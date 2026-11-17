import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { RuntimeCdnConfig, StorageByteRange, StorageUploadFileParams } from '@ufm/storage-plugin-sdk';
import { checkedDownloadUrl, DriveClient, DriveError } from './client';

type Binding = { accountId: string; driveId: string; root: string; scope: string };
type ObjectState = { fileId: string; size: number; checksum: string; sha1: string; uploadId?: string; ready: boolean };
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const CHUNK_SIZE = 10 * 1024 * 1024;

export class DriveObjects {
  constructor(private readonly client: DriveClient) {}
  binding(config: RuntimeCdnConfig): Binding {
    const { accountId, driveId, rootFolderId = 'root' } = config.config;
    if (typeof accountId !== 'string' || typeof driveId !== 'string' || typeof rootFolderId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(accountId) || !/^[A-Za-z0-9_-]{1,128}$/.test(driveId) || !/^[A-Za-z0-9_-]{1,128}$/.test(rootFolderId)) throw new Error('请先扫码连接账号并选择云盘。');
    return { accountId, driveId, root: rootFolderId, scope: sha256(`${accountId}\0${driveId}\0${rootFolderId}`) };
  }
  private objectKey(binding: Binding, key: string) {
    if (!key || key.length > 512 || key.includes('\0') || key.startsWith('/') || key.split('/').includes('..')) throw new Error('存储对象 key 无效。');
    return `object-${sha256(binding.scope + '\0' + key)}`;
  }
  private name(key: string) { return sha256(key); }
  private async metadata(binding: Binding, fileId: string) {
    try { return await this.client.request(binding.accountId, '/v2/file/get', { drive_id: binding.driveId, file_id: fileId }); }
    catch (error) { if (error instanceof DriveError && error.missing) return null; throw error; }
  }
  private async list(binding: Binding, parent: string, name: string) {
    let marker = ''; const seen = new Set<string>();
    do {
      const page = await this.client.request(binding.accountId, '/v2/file/list', {
        drive_id: binding.driveId, parent_file_id: parent, limit: 200, marker, fields: '*', order_by: 'name', order_direction: 'ASC',
      });
      const found = (page.items as Array<Record<string, any>> || []).filter(item => item.name === name && !item.trashed);
      if (found.length > 1) throw new Error('网盘内存在重复对象，请检查 UFM 目录。');
      if (found.length) return found[0];
      marker = String(page.next_marker || '');
      if (marker && seen.has(marker)) throw new Error('网盘分页游标异常。');
      seen.add(marker);
    } while (marker);
    return null;
  }
  private async folder(binding: Binding, create: boolean): Promise<string | null> {
    return this.client.context.withLock(`folder-${binding.scope}`, async () => {
      const key = `folder-${binding.scope}`;
      const cached = await this.client.context.getState<{ fileId: string }>(key);
      if (cached && await this.metadata(binding, cached.fileId)) return cached.fileId;
      const name = `UFM-objects-${binding.scope.slice(0, 16)}`;
      let folder = await this.list(binding, binding.root, name);
      if (!folder && create) folder = await this.client.request(binding.accountId, '/adrive/v2/file/createWithFolders', {
        drive_id: binding.driveId, parent_file_id: binding.root, name, type: 'folder', check_name_mode: 'refuse',
      });
      if (!folder?.file_id) return null;
      if (folder.type !== 'folder') throw new Error('UFM 对象目录被同名文件占用。');
      await this.client.context.setState(key, { fileId: String(folder.file_id) });
      return String(folder.file_id);
    });
  }
  private async find(binding: Binding, key: string, includeTrashed = false) {
    const id = this.objectKey(binding, key);
    const saved = await this.client.context.getState<ObjectState>(id);
    if (saved) {
      const item = await this.metadata(binding, saved.fileId);
      if (item) return !item.trashed || includeTrashed ? { saved, item } : null;
      await this.client.context.setState(id, null);
    }
    const parent = await this.folder(binding, false);
    if (!parent) return null;
    const item = await this.list(binding, parent, this.name(key));
    if (!item) return null;
    return { saved: null, item };
  }
  async uploadFile(config: RuntimeCdnConfig, params: StorageUploadFileParams) {
    const binding = this.binding(config), id = this.objectKey(binding, params.key);
    return this.client.context.withLock(id, async () => {
      const info = await stat(params.path);
      if (!info.isFile() || info.size !== params.size) throw new Error('上传源文件大小发生变化。');
      const hash = createHash('sha1'), checksum = createHash('sha256');
      for await (const bytes of createReadStream(params.path)) { hash.update(bytes); checksum.update(bytes); }
      const sha1 = hash.digest('hex').toUpperCase();
      if (checksum.digest('hex') !== params.checksum) throw new Error('上传源文件 SHA256 校验失败。');
      const existing = await this.find(binding, params.key);
      let saved = existing?.saved;
      if (existing) {
        const expectedRemoteSize = existing.item.status === 'uploading' && saved?.uploadId && !saved.ready
          ? saved.size : Number(existing.item.size);
        if (expectedRemoteSize !== params.size ||
          (saved ? saved.checksum !== params.checksum : String(existing.item.content_hash || '').toUpperCase() !== sha1)) {
          throw new Error('不可变 key 已存在不同内容的对象。');
        }
        if (existing.item.status === 'available') {
          await this.client.context.setState(id, { fileId: existing.item.file_id, size: params.size, checksum: params.checksum, sha1, ready: true });
          return { storageKey: params.key };
        }
        if (!saved?.uploadId) throw new Error('网盘有未完成的同名上传，请稍后重试或清理该对象。');
      }
      const count = Math.max(1, Math.ceil(params.size / CHUNK_SIZE));
      if (count > 10_000) throw new Error('文件超过当前分片上传支持的大小。');
      const parts = Array.from({ length: count }, (_, index) => ({ part_number: index + 1 }));
      let urls: Array<{ part_number: number; upload_url: string }>;
      if (!saved?.uploadId) {
        const parent = await this.folder(binding, true);
        const state = await this.client.fresh(binding.accountId);
        const digest = createHash('md5').update(state.accessToken).digest('hex').slice(0, 16);
        const offset = params.size ? Number(BigInt(`0x${digest}`) % BigInt(params.size)) : 0;
        const file = await open(params.path, 'r');
        let proof: Buffer;
        try { proof = Buffer.alloc(Math.min(8, params.size - offset)); await file.read(proof, 0, proof.length, offset); }
        finally { await file.close(); }
        const created = await this.client.request(binding.accountId, '/adrive/v2/file/createWithFolders', {
          drive_id: binding.driveId, parent_file_id: parent, type: 'file', name: this.name(params.key), check_name_mode: 'refuse',
          size: params.size, content_hash: sha1, content_hash_name: 'sha1', proof_code: proof.toString('base64'), proof_version: 'v1', part_info_list: parts,
        });
        if (!created.file_id) throw new Error('创建网盘对象失败。');
        saved = { fileId: String(created.file_id), uploadId: created.upload_id, size: params.size, checksum: params.checksum, sha1, ready: Boolean(created.rapid_upload) };
        await this.client.context.setState(id, saved);
        if (saved.ready) return { storageKey: params.key };
        urls = created.part_info_list || [];
      } else {
        const renewed = await this.client.request(binding.accountId, '/v2/file/get_upload_url', {
          drive_id: binding.driveId, file_id: saved.fileId, upload_id: saved.uploadId, part_info_list: parts,
        });
        urls = renewed.part_info_list || [];
      }
      for (const part of parts) {
        let url = urls.find(item => item.part_number === part.part_number)?.upload_url;
        for (let attempt = 0; attempt < 3; attempt++) {
          if (!url) throw new Error('网盘没有返回分片上传地址。');
          const uploadUrl = checkedDownloadUrl(url);
          const start = (part.part_number - 1) * CHUNK_SIZE, end = Math.min(params.size, start + CHUNK_SIZE);
          const stream = params.size ? createReadStream(params.path, { start, end: end - 1 }) : Readable.from([]);
          let ok = false;
          try {
            const response = await this.client.transport(uploadUrl, { method: 'PUT', body: stream as unknown as BodyInit,
              duplex: 'half', headers: { 'content-length': String(end - start) }, signal: AbortSignal.timeout(120_000), redirect: 'error' } as RequestInit);
            await response.body?.cancel();
            ok = response.ok;
            if (!ok && ![403, 408, 429, 500, 502, 503, 504].includes(response.status)) throw new DriveError('PartUploadFailed', response.status);
          } catch (error) { if (error instanceof DriveError) throw error; }
          finally { stream.destroy(); }
          if (ok) break;
          if (attempt === 2) throw new Error('网盘分片上传失败，任务稍后可重试。');
          const renewed = await this.client.request(binding.accountId, '/v2/file/get_upload_url', {
            drive_id: binding.driveId, file_id: saved.fileId, upload_id: saved.uploadId, part_info_list: [part],
          });
          url = renewed.part_info_list?.[0]?.upload_url;
        }
      }
      const completed = await this.client.request(binding.accountId, '/v2/file/complete', {
        drive_id: binding.driveId, file_id: saved.fileId, upload_id: saved.uploadId, part_info_list: parts,
      });
      if (completed.file_id !== saved.fileId || completed.status && completed.status !== 'available') throw new Error('网盘上传尚未完成。');
      saved.ready = true; await this.client.context.setState(id, saved);
      return { storageKey: params.key };
    });
  }
  async objectExists(config: RuntimeCdnConfig, key: string) {
    const found = await this.find(this.binding(config), key);
    return Boolean(found && found.item.status === 'available' && !found.item.trashed);
  }
  async verifyBackup(config: RuntimeCdnConfig, key: string, size: number, checksum: string) {
    const binding = this.binding(config), found = await this.find(binding, key);
    if (!found || found.item.status !== 'available' || found.item.trashed || Number(found.item.size) !== size ||
      !found.saved || found.saved.size !== size || found.saved.checksum !== checksum || !found.saved.ready ||
      String(found.item.content_hash || '').toUpperCase() !== found.saved.sha1) {
      throw new Error('阿里云盘备份元数据不存在、不完整或与源文件校验值不匹配。');
    }
  }
  async getDownloadUrl(_config: RuntimeCdnConfig, _key: string, _expiresSeconds: number): Promise<never> {
    throw new Error('阿里云盘仅用于上传备份，不提供下载。');
  }
  async getDownloadTarget(_config: RuntimeCdnConfig, _key: string, _range?: StorageByteRange): Promise<never> {
    throw new Error('阿里云盘仅用于上传备份，不提供下载。');
  }
  async remove(config: RuntimeCdnConfig, key: string) {
    const binding = this.binding(config), id = this.objectKey(binding, key);
    await this.client.context.withLock(id, async () => {
      const found = await this.find(binding, key, true);
      if (!found) return;
      try { await this.client.request(binding.accountId, '/v2/file/delete', { drive_id: binding.driveId, file_id: found.item.file_id }); }
      catch (error) { if (!(error instanceof DriveError && error.missing)) throw error; }
      if (await this.metadata(binding, String(found.item.file_id))) throw new Error('网盘对象尚未彻底删除，任务将重试。');
      await this.client.context.setState(id, null);
    });
  }
  async getUsage(config: RuntimeCdnConfig) {
    const binding = this.binding(config);
    const data = await this.client.request(binding.accountId, '/v2/databox/get_personal_info');
    const space = data.personal_space_info || {};
    const value = (input: unknown) => input === null || input === undefined || !Number.isFinite(Number(input)) ? null : Number(input);
    return { storageUsedBytes: value(space.used_size), storageQuotaBytes: value(space.total_size), checkedAt: new Date().toISOString() };
  }
}
