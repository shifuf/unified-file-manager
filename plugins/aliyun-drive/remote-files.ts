import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { RuntimeCdnConfig, StorageRemoteFile, StorageRemotePage, StorageRemoteRead } from '@ufm/storage-plugin-sdk';
import { checkedDownloadUrl, DriveClient, DriveError } from './client';
import { checkedPortableDescription, DriveObjects, type PortableDescription } from './objects';

function identifier(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error('云端文件标识无效。');
  return value;
}
const DESCRIPTION_LIMIT = 16 * 1024;
const objectName = /^[a-f0-9]{64}$/;
const descriptionName = /^[a-f0-9]{64}\.ufm\.json$/;

/** Reads only the configured root and descendants; never relies on local object-state mappings. */
export class DriveRemoteFiles {
  constructor(private readonly client: DriveClient, private readonly objects: DriveObjects) {}

  private async metadata(config: RuntimeCdnConfig, id: string): Promise<Record<string, any>> {
    const binding = this.objects.binding(config);
    const item = await this.client.request(binding.accountId, '/v2/file/get', { drive_id: binding.driveId, file_id: identifier(id) });
    if (item.file_id !== id || item.trashed) throw new Error('云端文件不存在或已放入回收站。');
    return item;
  }

  private async assertFolder(config: RuntimeCdnConfig, id: string): Promise<void> {
    const binding = this.objects.binding(config);
    let current = identifier(id);
    const seen = new Set<string>();
    for (let depth = 0; depth < 64; depth++) {
      if (current === binding.root) return;
      if (current === 'root' || seen.has(current)) break;
      seen.add(current);
      const item = await this.metadata(config, current);
      if (item.type !== 'folder') throw new Error('请选择云端文件夹。');
      current = identifier(String(item.parent_file_id || ''));
    }
    throw new Error('该目录不在此存储的保存目录范围内。');
  }

  private async findDescription(config: RuntimeCdnConfig, item: Record<string, any>) {
    const binding = this.objects.binding(config);
    const seen = new Set<string>();
    let cursor = '';
    let pages = 0, entries = 0;
    do {
      if (++pages > 256) throw new Error('云端文件描述查找超过分页上限。');
      const page = await this.client.request(binding.accountId, '/v2/file/list', {
        drive_id: binding.driveId, parent_file_id: item.parent_file_id, limit: 200, marker: cursor,
        fields: '*', order_by: 'name', order_direction: 'ASC',
      });
      if (!Array.isArray(page.items)) throw new Error('云端目录返回了无效的文件列表。');
      if ((entries += page.items.length) > 20_000) throw new Error('云端文件描述查找超过条目上限。');
      const found = page.items.filter((entry: Record<string, any>) => entry.name === `${item.name}.ufm.json` && !entry.trashed);
      if (found.length > 1) throw new Error('云端存在重复的文件描述，请检查对象目录。');
      if (found.length) return found[0];
      cursor = String(page.next_marker || '');
      if (cursor.length > 2048 || /[\x00-\x1f]/.test(cursor) || cursor && seen.has(cursor)) throw new Error('云端分页游标异常。');
      seen.add(cursor);
    } while (cursor);
    return undefined;
  }

  private async portableDescription(config: RuntimeCdnConfig, item: Record<string, any>, description?: Record<string, any>): Promise<PortableDescription | undefined> {
    if (!objectName.test(item.name) || !description) return undefined;
    if (description.type !== 'file' || description.parent_file_id !== item.parent_file_id ||
      description.name !== `${item.name}.ufm.json` || description.trashed || description.status !== 'available') return undefined;
    let value: Record<string, any>;
    try {
      const read = await this.read(config, identifier(String(description.file_id)), { maxBytes: DESCRIPTION_LIMIT });
      const chunks: Buffer[] = [];
      for await (const bytes of read.stream) chunks.push(Buffer.from(bytes));
      try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { return undefined; }
    } catch (error) {
      // Transport and authentication failures must stay visible to the administrator.
      // An oversized description is invalid metadata, not a reason to hide the object.
      if (Number(description.size) > DESCRIPTION_LIMIT) return undefined;
      throw error;
    }
    const portable = checkedPortableDescription(value, item);
    if (!portable) return undefined;
    const project = await this.objects.projectForFolder(config, String(item.parent_file_id));
    if (portable.project && portable.project.id !== project?.id) return undefined;
    return { ...portable, ...(project && !portable.project ? { project } : {}) };
  }

  async list(config: RuntimeCdnConfig, options: { parentId?: string; cursor?: string }): Promise<StorageRemotePage> {
    const binding = this.objects.binding(config);
    const parentId = identifier(options.parentId || binding.root);
    const cursor = options.cursor || '';
    if (cursor.length > 2048 || /[\x00-\x1f]/.test(cursor)) throw new Error('云端分页游标无效。');
    await this.assertFolder(config, parentId);
    const page = await this.client.request(binding.accountId, '/v2/file/list', {
      drive_id: binding.driveId, parent_file_id: parentId, limit: 100, marker: cursor,
      fields: '*', order_by: 'name', order_direction: 'ASC',
    });
    if (!Array.isArray(page.items)) throw new Error('云端目录返回了无效的文件列表。');
    const nextCursor = String(page.next_marker || '');
    if (nextCursor.length > 2048 || /[\x00-\x1f]/.test(nextCursor) || nextCursor && nextCursor === cursor) throw new Error('云端分页游标异常。');
    const descriptions = new Map<string, Record<string, any>>();
    for (const item of page.items) if (descriptionName.test(item.name) && !item.trashed) {
      if (descriptions.has(item.name)) throw new Error('云端存在重复的文件描述，请检查对象目录。');
      descriptions.set(item.name, item);
    }
    const items: StorageRemoteFile[] = [];
    for (const item of page.items) {
      if (item.trashed || item.status && item.status !== 'available') continue;
      if (item.parent_file_id !== parentId || !['folder', 'file'].includes(item.type)) throw new Error('云端文件目录信息不一致。');
      const size = item.type === 'folder' ? 0 : Number(item.size);
      if (!Number.isSafeInteger(size) || size < 0 || typeof item.name !== 'string' || !item.name || item.name.length > 1024) throw new Error('云端文件元数据无效。');
      if (item.type === 'file' && (descriptionName.test(item.name) || item.name === '.ufm-project.json')) continue;
      let description = descriptions.get(`${item.name}.ufm.json`);
      // Name ordering places a description immediately after its object. Only a
      // page boundary needs a separate lookup; old objects cause no extra scan.
      if (!description && objectName.test(item.name) && nextCursor && page.items.at(-1)?.file_id === item.file_id) description = await this.findDescription(config, item);
      const portable = await this.portableDescription(config, item, description);
      items.push({ id: identifier(String(item.file_id)), parentId, name: item.name, type: item.type, size, ...portable,
        ...(item.type === 'folder' ? { project: await this.objects.projectForFolder(config, String(item.file_id)) } : {}),
        mimeType: portable?.mimeType || (typeof item.mime_type === 'string' ? item.mime_type.slice(0, 128) : undefined),
        sha1: /^[a-f0-9]{40}$/i.test(item.content_hash || '') ? String(item.content_hash).toLowerCase() : undefined,
        updatedAt: typeof item.updated_at === 'string' ? item.updated_at : undefined });
    }
    return { parentId, items, nextCursor };
  }

  async read(config: RuntimeCdnConfig, id: string, options: { maxBytes?: number; timeoutMs?: number } = {}): Promise<StorageRemoteRead> {
    const binding = this.objects.binding(config);
    const item = await this.metadata(config, identifier(id));
    if (item.type !== 'file' || item.status !== 'available') throw new Error('该云端文件尚未可读取。');
    await this.assertFolder(config, String(item.parent_file_id || ''));
    const size = Number(item.size);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('云端文件大小无效。');
    if (options.maxBytes !== undefined && (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0 || size > options.maxBytes)) throw new Error('云端文件超过本次拉取的大小上限。');
    const sha1 = /^[a-f0-9]{40}$/i.test(item.content_hash || '') ? String(item.content_hash).toLowerCase() : undefined;
    if (!sha1) throw new Error('云端文件缺少完整性校验值，暂不能安全拉取。');
    const description = objectName.test(item.name) ? await this.findDescription(config, item) : undefined;
    const portable = await this.portableDescription(config, item, description);
    const target = await this.client.request(binding.accountId, '/v2/file/get_download_url', { drive_id: binding.driveId, file_id: id, expire_sec: 300 });
    const timeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs! > 0
      ? Math.min(1_800_000, Math.max(1000, options.timeoutMs!)) : 1_800_000;
    const response = await this.client.transport(checkedDownloadUrl(target.url), {
      redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers: { Referer: 'https://www.aliyundrive.com/' },
    });
    if (!response.ok || response.status !== 200 || !response.body) {
      await response.body?.cancel();
      throw new DriveError('DownloadFailed', response.status);
    }
    const stream = Readable.from((async function* () {
      let received = 0;
      const hash = createHash('sha1');
      try {
        for await (const chunk of response.body!) {
          received += chunk.byteLength;
          if (received > size) throw new Error('云端文件大小校验失败，请刷新后重试。');
          hash.update(chunk);
          yield chunk;
        }
        if (received !== size || hash.digest('hex') !== sha1) throw new Error('云端文件完整性校验失败，请刷新后重试。');
      } finally { await response.body?.cancel().catch(() => undefined); }
    })());
    return { stream, name: portable?.originalName || String(item.name).slice(0, 1024), size,
      mimeType: portable?.mimeType || (typeof item.mime_type === 'string' ? item.mime_type.slice(0, 128) : 'application/octet-stream'), sha1 };
  }
}
