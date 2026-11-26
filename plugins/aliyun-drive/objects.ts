import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, open, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { RuntimeCdnConfig, StorageByteRange, StorageProjectIdentity, StorageUploadFileParams } from '@ufm/storage-plugin-sdk';
import { checkedDownloadUrl, DriveClient, DriveError } from './client';

type Binding = { accountId: string; driveId: string; root: string; scope: string };
type ObjectState = { fileId: string; size: number; checksum: string; sha1: string; uploadId?: string; ready: boolean };
type SearchBudget = { pages: number; items: number };
type CloudItem = Record<string, any>;
type ProjectProof = { fileId: string; size: number; sha1: string; project: StorageProjectIdentity };
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const CHUNK_SIZE = 10 * 1024 * 1024;
const JSON_LIMIT = 16 * 1024;
const PROJECT_MARKER = '.ufm-project.json';
const budget = (): SearchBudget => ({ pages: 256, items: 20_000 });
const shortProjectId = (id: string) => sha256(id).slice(0, 12);

export function checkedProject(value: unknown): StorageProjectIdentity {
  const project = value as StorageProjectIdentity;
  if (!project || typeof project.id !== 'string' || !project.id.trim() || project.id.length > 128 || /[\x00-\x1f\x7f]/.test(project.id) ||
    typeof project.name !== 'string' || !project.name.trim() || project.name.length > 255 || /[\x00-\x1f\x7f]/.test(project.name)) throw new Error('项目名称或标识无效。');
  return { id: project.id, name: project.name };
}
export function checkedFolderPath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 1024 || /[\\\x00-\x1f\x7f]/.test(value) || value.startsWith('/') ||
    value && (value.split('/').length > 64 || value.split('/').some(part => !part || part === '.' || part === '..' || part.length > 255))) throw new Error('项目相对目录路径无效。');
  return value;
}
function projectFolderName(project: StorageProjectIdentity): string {
  const cleaned = project.name.normalize('NFKC').replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, '_').replace(/\s+/g, ' ').replace(/^[. ]+|[. ]+$/g, '') || '项目';
  let readable = '';
  for (const character of cleaned) { if (Buffer.byteLength(readable + character, 'utf8') > 160) break; readable += character; }
  return `${readable}-${shortProjectId(project.id)}`;
}
export type PortableDescription = { originalName: string; storageKey: string; checksum: string; mimeType: string; project?: StorageProjectIdentity; folderPath?: string };
export function checkedPortableDescription(value: any, item: CloudItem): PortableDescription | undefined {
  const key = value?.storageKey, name = value?.originalName;
  if (value?.version !== 1 || typeof key !== 'string' || !key || key.length > 512 || key.includes('\0') ||
    key.startsWith('/') || key.split('/').includes('..') || sha256(key) !== item.name ||
    typeof name !== 'string' || !name.trim() || name.length > 255 || /[\x00-\x1f/\\]/.test(name) || name === '.' || name === '..' ||
    value.size !== Number(item.size) || typeof value.sha1 !== 'string' || value.sha1.toLowerCase() !== String(item.content_hash).toLowerCase() ||
    typeof value.checksum !== 'string' || !/^[a-f0-9]{64}$/i.test(value.checksum)) return undefined;
  try {
    return { storageKey: key, originalName: name, checksum: value.checksum.toLowerCase(),
      mimeType: typeof value.mimeType === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(value.mimeType) ? value.mimeType : 'application/octet-stream',
      ...(value.project === undefined ? {} : { project: checkedProject(value.project) }),
      ...(value.folderPath === undefined ? {} : { folderPath: checkedFolderPath(value.folderPath) }) };
  } catch { return undefined; }
}

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
  private stateKey(binding: Binding, key: string, cloudName?: string) {
    return this.objectKey(binding, key) + (cloudName ? '-metadata' : '');
  }
  private async metadata(binding: Binding, fileId: string) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(fileId)) throw new Error('网盘文件标识无效。');
    try {
      const item = await this.client.request(binding.accountId, '/v2/file/get', { drive_id: binding.driveId, file_id: fileId });
      if (item.file_id !== fileId) throw new Error('网盘文件标识不一致。');
      return item;
    }
    catch (error) { if (error instanceof DriveError && error.missing) return null; throw error; }
  }
  private async entries(binding: Binding, parent: string, remaining: SearchBudget = budget()): Promise<CloudItem[]> {
    const items: CloudItem[] = [];
    let marker = ''; const seen = new Set<string>();
    do {
      if (--remaining.pages < 0) throw new Error('网盘目录查找超过分页上限，请缩小保存目录。');
      const page = await this.client.request(binding.accountId, '/v2/file/list', {
        drive_id: binding.driveId, parent_file_id: parent, limit: 200, marker, fields: '*', order_by: 'name', order_direction: 'ASC',
      });
      if (!Array.isArray(page.items)) throw new Error('网盘返回了无效的目录列表。');
      remaining.items -= page.items.length;
      if (remaining.items < 0) throw new Error('网盘目录查找超过条目上限，请缩小保存目录。');
      for (const item of page.items) {
        if (item.parent_file_id !== parent || !['folder', 'file'].includes(item.type) || typeof item.name !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(item.file_id || '')) throw new Error('网盘文件目录信息不一致。');
        items.push(item);
      }
      marker = String(page.next_marker || '');
      if (marker.length > 2048 || /[\x00-\x1f]/.test(marker) || marker && seen.has(marker)) throw new Error('网盘分页游标异常。');
      seen.add(marker);
    } while (marker);
    return items;
  }
  private async list(binding: Binding, parent: string, name: string, remaining: SearchBudget = budget()) {
    const found = (await this.entries(binding, parent, remaining)).filter(item => item.name === name && !item.trashed);
    if (found.length > 1) throw new Error('网盘内存在重复对象，请检查 UFM 目录。');
    return found[0] || null;
  }
  private legacyFolderName(binding: Binding) { return `UFM-objects-${binding.scope.slice(0, 16)}`; }
  private markerScope(binding: Binding) { return sha256(`${binding.driveId}\0${binding.root}`); }
  private projectProofKey(binding: Binding, folderId: string) { return `project-proof-${binding.scope}-${folderId}`; }
  private async readJson(binding: Binding, item: CloudItem): Promise<{ value: any; bytes: Buffer } | null> {
    const size = Number(item.size);
    if (item.type !== 'file' || item.trashed || item.status !== 'available' || !Number.isSafeInteger(size) || size < 1 || size > JSON_LIMIT || !/^[a-f0-9]{40}$/i.test(item.content_hash || '')) return null;
    const target = await this.client.request(binding.accountId, '/v2/file/get_download_url', { drive_id: binding.driveId, file_id: item.file_id, expire_sec: 300 });
    const response = await this.client.transport(checkedDownloadUrl(target.url), {
      redirect: 'error', signal: AbortSignal.timeout(120_000), headers: { Referer: 'https://www.aliyundrive.com/' },
    });
    if (!response.ok || response.status !== 200 || !response.body) { await response.body?.cancel(); throw new DriveError('DownloadFailed', response.status); }
    const chunks: Buffer[] = []; let received = 0;
    try {
      for await (const chunk of response.body) {
        received += chunk.byteLength;
        if (received > size) throw new Error('云端 JSON 描述大小校验失败。');
        chunks.push(Buffer.from(chunk));
      }
    } finally { await response.body.cancel().catch(() => undefined); }
    const bytes = Buffer.concat(chunks);
    if (received !== size || createHash('sha1').update(bytes).digest('hex') !== String(item.content_hash).toLowerCase()) throw new Error('云端 JSON 描述内容校验失败。');
    try { return { value: JSON.parse(bytes.toString('utf8')), bytes }; } catch { return null; }
  }
  private async folderProject(binding: Binding, folder: CloudItem, remaining: SearchBudget = budget()): Promise<StorageProjectIdentity | null> {
    if (folder.type !== 'folder' || folder.trashed || folder.parent_file_id !== binding.root || !/-[a-f0-9]{12}$/.test(folder.name)) return null;
    const marker = await this.list(binding, String(folder.file_id), PROJECT_MARKER, remaining);
    if (!marker) return null;
    const cached = await this.client.context.getState<ProjectProof>(this.projectProofKey(binding, String(folder.file_id)));
    if (cached && marker.type === 'file' && marker.status === 'available' && cached.fileId === marker.file_id && cached.size === Number(marker.size) &&
      cached.sha1 === String(marker.content_hash).toLowerCase()) {
      const project = checkedProject(cached.project);
      if (folder.name.endsWith(`-${shortProjectId(project.id)}`)) return project;
    }
    const json = await this.readJson(binding, marker);
    if (!json || json.value?.version !== 1 || json.value.kind !== 'ufm-project' || json.value.scope !== this.markerScope(binding)) return null;
    try {
      const project = checkedProject(json.value.project);
      if (!folder.name.endsWith(`-${shortProjectId(project.id)}`)) return null;
      await this.client.context.setState(this.projectProofKey(binding, String(folder.file_id)), {
        fileId: String(marker.file_id), size: Number(marker.size), sha1: String(marker.content_hash).toLowerCase(), project,
      });
      return project;
    } catch { return null; }
  }
  async projectForFolder(config: RuntimeCdnConfig, folderId: string): Promise<StorageProjectIdentity | undefined> {
    const binding = this.binding(config), seen = new Set<string>(); let current = folderId;
    for (let depth = 0; depth < 64 && current !== binding.root; depth++) {
      if (seen.has(current) || current === 'root') break;
      seen.add(current);
      const item = await this.metadata(binding, current);
      if (!item || item.trashed || item.type !== 'folder') break;
      if (item.parent_file_id === binding.root) return (await this.folderProject(binding, item)) || undefined;
      current = String(item.parent_file_id || '');
    }
    return undefined;
  }
  private async assertManagedParent(binding: Binding, parentId: string): Promise<StorageProjectIdentity | null> {
    const seen = new Set<string>(); let current = parentId;
    for (let depth = 0; depth < 64; depth++) {
      if (current === binding.root || current === 'root' || seen.has(current)) break;
      seen.add(current);
      const folder = await this.metadata(binding, current);
      if (!folder || folder.trashed || folder.type !== 'folder') break;
      if (folder.parent_file_id === binding.root) {
        if (/^UFM-objects-[a-f0-9]{16}$/.test(folder.name)) return null;
        const project = await this.folderProject(binding, folder);
        if (project) return project;
        break;
      }
      current = String(folder.parent_file_id || '');
    }
    throw new Error('对象不在此存储的 UFM 管理目录范围内。');
  }
  private async folder(binding: Binding, create: boolean): Promise<string | null> {
    return this.client.context.withLock(`folder-${binding.scope}`, async () => {
      const key = `folder-${binding.scope}`;
      const cached = await this.client.context.getState<{ fileId: string }>(key);
      if (cached) {
        const item = await this.metadata(binding, cached.fileId);
        if (item && !item.trashed) {
          if (item.type !== 'folder' || item.parent_file_id !== binding.root || item.name !== this.legacyFolderName(binding)) throw new Error('缓存的 UFM 对象目录不在保存根目录内。');
          return cached.fileId;
        }
      }
      const name = this.legacyFolderName(binding);
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
  private async projectFolder(config: RuntimeCdnConfig, project: StorageProjectIdentity): Promise<string> {
    const binding = this.binding(config), key = `project-folder-${binding.scope}-${sha256(project.id)}`;
    return this.client.context.withLock(key, async () => {
      const saved = await this.client.context.getState<{ fileId: string; pendingMarker?: boolean }>(key);
      if (saved) {
        const folder = await this.metadata(binding, saved.fileId);
        if (folder && !folder.trashed) {
          if (folder.type !== 'folder' || folder.parent_file_id !== binding.root || !folder.name.endsWith(`-${shortProjectId(project.id)}`)) throw new Error('缓存的项目目录不在保存根目录内。');
          const identity = await this.folderProject(binding, folder);
          if (identity?.id === project.id) return saved.fileId;
          const marker = await this.list(binding, saved.fileId, PROJECT_MARKER);
          if (!saved.pendingMarker || marker?.status === 'available') throw new Error('项目目录标记无效，请检查云端目录。');
          await this.writeProjectMarker(config, saved.fileId, project);
          await this.client.context.setState(key, { fileId: saved.fileId });
          return saved.fileId;
        }
      }
      const remaining = budget(), entries = await this.entries(binding, binding.root, remaining);
      const matching: CloudItem[] = [];
      for (const entry of entries) {
        if (entry.trashed || !entry.name.endsWith(`-${shortProjectId(project.id)}`)) continue;
        const identity = await this.folderProject(binding, entry, remaining);
        if (!identity || identity.id !== project.id) throw new Error('项目目录被同名对象占用或标记无效。');
        matching.push(entry);
      }
      if (matching.length > 1) throw new Error('网盘内存在重复的项目目录，请检查项目标记。');
      if (matching.length) { await this.client.context.setState(key, { fileId: matching[0].file_id }); return String(matching[0].file_id); }
      const name = projectFolderName(project);
      if (entries.some(entry => entry.name === name && !entry.trashed)) throw new Error('项目目录名称已被占用。');
      const created = await this.client.request(binding.accountId, '/adrive/v2/file/createWithFolders', {
        drive_id: binding.driveId, parent_file_id: binding.root, name, type: 'folder', check_name_mode: 'refuse',
      });
      if (!created.file_id || created.type !== 'folder') throw new Error('创建项目目录失败。');
      const fileId = String(created.file_id);
      await this.client.context.setState(key, { fileId, pendingMarker: true });
      await this.writeProjectMarker(config, fileId, project);
      await this.client.context.setState(key, { fileId });
      return fileId;
    });
  }
  private async writeProjectMarker(config: RuntimeCdnConfig, parentId: string, project: StorageProjectIdentity) {
    const binding = this.binding(config);
    const bytes = Buffer.from(JSON.stringify({ version: 1, kind: 'ufm-project', scope: this.markerScope(binding), project }));
    if (bytes.length > JSON_LIMIT) throw new Error('项目目录标记超过大小上限。');
    await this.withJsonFile(bytes, async path => this.uploadObject(config, { key: `__ufm_project_marker/${sha256(project.id)}`, path,
      size: bytes.length, checksum: sha256(bytes.toString()), mimeType: 'application/json', originalName: PROJECT_MARKER }, PROJECT_MARKER, parentId));
    const marker = await this.list(binding, parentId, PROJECT_MARKER);
    const hash = createHash('sha1').update(bytes).digest('hex');
    if (!marker || marker.status !== 'available' || Number(marker.size) !== bytes.length || String(marker.content_hash).toLowerCase() !== hash) throw new Error('项目目录标记上传后校验失败。');
    await this.client.context.setState(this.projectProofKey(binding, parentId), { fileId: marker.file_id, size: bytes.length, sha1: hash, project });
  }
  private async managedFolders(binding: Binding, remaining: SearchBudget): Promise<string[]> {
    const folders: string[] = [];
    for (const entry of await this.entries(binding, binding.root, remaining)) {
      if (entry.trashed || entry.type !== 'folder') continue;
      if (/^UFM-objects-[a-f0-9]{16}$/.test(entry.name) || await this.folderProject(binding, entry, remaining)) folders.push(String(entry.file_id));
    }
    return folders;
  }
  private async find(binding: Binding, key: string, includeTrashed = false, cloudName?: string): Promise<{ saved: ObjectState | null; item: CloudItem } | null> {
    const id = this.stateKey(binding, key, cloudName);
    const saved = await this.client.context.getState<ObjectState>(id);
    if (saved) {
      const item = await this.metadata(binding, saved.fileId);
      if (item) {
        if (item.type !== 'file' || item.name !== (cloudName || this.name(key))) throw new Error('缓存的不可变对象标识不一致。');
        await this.assertManagedParent(binding, String(item.parent_file_id || ''));
        return !item.trashed || includeTrashed ? { saved, item } : null;
      }
      await this.client.context.setState(id, null);
    }
    const remaining = budget(), queue = (await this.managedFolders(binding, remaining)).map(id => ({ id, depth: 0 })), seen = new Set<string>(), found: CloudItem[] = [];
    while (queue.length) {
      const parent = queue.shift()!;
      if (seen.has(parent.id)) throw new Error('网盘目录出现循环引用。');
      seen.add(parent.id);
      for (const item of await this.entries(binding, parent.id, remaining)) {
        if (item.trashed && !includeTrashed) continue;
        if (item.type === 'folder' && !item.trashed) {
          if (parent.depth >= 63) throw new Error('网盘对象目录超过深度上限。');
          queue.push({ id: String(item.file_id), depth: parent.depth + 1 });
        } else if (item.type === 'file' && item.name === (cloudName || this.name(key))) found.push(item);
      }
    }
    if (found.length > 1) throw new Error('网盘内存在重复对象，请检查 UFM 目录。');
    return found.length ? { saved: null, item: found[0] } : null;
  }
  private async hasPortableDescription(binding: Binding, params: StorageUploadFileParams, source: ObjectState): Promise<CloudItem | null> {
    const found = await this.find(binding, params.key, false, `${this.name(params.key)}.ufm.json`);
    if (!found || found.item.status !== 'available') return null;
    if (found.saved?.ready && Number(found.item.size) === found.saved.size &&
      String(found.item.content_hash || '').toUpperCase() === found.saved.sha1) return found.item;
    const json = await this.readJson(binding, found.item);
    const value = json && checkedPortableDescription(json.value, { name: this.name(params.key), size: params.size, content_hash: source.sha1 });
    // The key describes immutable bytes; keep its first verified display name
    // when a later upload retries those bytes after a business-file rename.
    if (!json || !value || value.storageKey !== params.key || value.checksum !== params.checksum || value.project && params.project && value.project.id !== params.project.id) return null;
    await this.client.context.setState(this.stateKey(binding, params.key, `${this.name(params.key)}.ufm.json`), {
      fileId: found.item.file_id, size: json.bytes.length, checksum: createHash('sha256').update(json.bytes).digest('hex'), sha1: String(found.item.content_hash).toUpperCase(), ready: true,
    });
    return found.item;
  }
  private async withJsonFile<T>(bytes: Buffer, action: (path: string) => Promise<T>): Promise<T> {
    const directory = await mkdtemp(join(tmpdir(), 'ufm-drive-metadata-')), path = join(directory, 'description.json');
    try { await writeFile(path, bytes, { mode: 0o600 }); return await action(path); }
    finally { await unlink(path).catch(() => undefined); await rmdir(directory).catch(() => undefined); }
  }
  private async move(binding: Binding, item: CloudItem, parentId: string) {
    if (item.parent_file_id === parentId) return;
    await this.client.request(binding.accountId, '/v3/file/move', {
      drive_id: binding.driveId, file_id: item.file_id, to_parent_file_id: parentId, check_name_mode: 'refuse',
    });
    const moved = await this.metadata(binding, String(item.file_id));
    if (!moved || moved.trashed || moved.parent_file_id !== parentId || moved.name !== item.name || moved.status !== 'available' ||
      Number(moved.size) !== Number(item.size) || String(moved.content_hash).toLowerCase() !== String(item.content_hash).toLowerCase()) throw new Error('网盘对象移动后校验失败，任务可重试。');
  }
  async uploadFile(config: RuntimeCdnConfig, params: StorageUploadFileParams) {
    if (params.project !== undefined) params = { ...params, project: checkedProject(params.project) };
    if (params.folderPath !== undefined) checkedFolderPath(params.folderPath);
    const binding = this.binding(config), id = this.objectKey(binding, params.key);
    return this.client.context.withLock(`portable-${id}`, async () => {
      const stored = await this.uploadObject(config, params);
      const saved = await this.client.context.getState<ObjectState>(id);
      if (!saved?.ready) throw new Error('上传对象的校验元数据尚未保存。');
      if (params.project) {
        const item = await this.metadata(binding, saved.fileId);
        if (!item || item.status !== 'available' || Number(item.size) !== params.size || String(item.content_hash).toUpperCase() !== saved.sha1) throw new Error('整理前的网盘对象校验失败。');
        const previous = await this.assertManagedParent(binding, String(item.parent_file_id));
        if (previous && previous.id !== params.project.id) throw new Error('不可变对象已经属于另一个项目。');
        await this.move(binding, item, await this.projectFolder(config, params.project));
      }
      const description = await this.hasPortableDescription(binding, params, saved);
      if (description) {
        if (params.project) await this.move(binding, description, await this.projectFolder(config, params.project));
        return stored;
      }
      const bytes = Buffer.from(JSON.stringify({ version: 1, storageKey: params.key,
        originalName: params.originalName, mimeType: params.mimeType,
        size: params.size, checksum: params.checksum, sha1: saved.sha1.toLowerCase(),
        ...(params.project ? { project: params.project } : {}), ...(params.folderPath === undefined ? {} : { folderPath: params.folderPath }) }));
      if (bytes.length > JSON_LIMIT) throw new Error('文件名称元数据超过大小上限。');
      await this.withJsonFile(bytes, path => this.uploadObject(config, { key: params.key, path, size: bytes.length,
          checksum: createHash('sha256').update(bytes).digest('hex'), mimeType: 'application/json',
          originalName: `${this.name(params.key)}.ufm.json`, project: params.project }, `${this.name(params.key)}.ufm.json`));
      return stored;
    });
  }
  private async uploadedParts(binding: Binding, saved: ObjectState, size: number): Promise<Set<number>> {
    const count = Math.max(1, Math.ceil(size / CHUNK_SIZE)), uploaded = new Set<number>();
    let marker = 0, sequential = false;
    for (let page = 0; page < 100; page++) {
      let result: CloudItem;
      try {
        result = await this.client.request(binding.accountId, '/v2/file/list_uploaded_parts', {
          drive_id: binding.driveId, file_id: saved.fileId, upload_id: saved.uploadId, limit: 100,
          ...(marker ? { part_number_marker: marker } : {}),
        });
      } catch {
        throw new Error('无法确认已上传分片：上传会话失效或服务不支持查询，已停止续传以避免覆盖已有分片。');
      }
      if (result.file_id !== saved.fileId || result.upload_id !== saved.uploadId || !Array.isArray(result.uploaded_parts)
        || result.uploaded_parts.length > 100) throw new Error('已上传分片的会话或列表信息不一致。');
      sequential ||= result.parallel_upload === false;
      let last = marker;
      for (const part of result.uploaded_parts) {
        const number = part?.part_number, expected = Math.min(CHUNK_SIZE, size - (number - 1) * CHUNK_SIZE);
        if (!Number.isSafeInteger(number) || number < 1 || number > count || number <= last || uploaded.has(number)
          || part.part_size !== expected) throw new Error('已上传分片的编号或大小校验失败，已停止续传。');
        uploaded.add(number); last = number;
      }
      const next = Number(result.next_part_number_marker ?? 0);
      if (!Number.isSafeInteger(next) || next < 0 || next > count || next && (next <= marker || next < last || !result.uploaded_parts.length)) {
        throw new Error('已上传分片的分页游标异常。');
      }
      if (!next) {
        if (sequential && [...uploaded].some((number, index) => number !== index + 1)) throw new Error('顺序上传的已确认分片不连续，已停止续传。');
        return uploaded;
      }
      marker = next;
    }
    throw new Error('已上传分片查询超过分页上限，已停止续传。');
  }
  private async uploadObject(config: RuntimeCdnConfig, params: StorageUploadFileParams, cloudName?: string, fixedParent?: string) {
    const binding = this.binding(config), id = this.stateKey(binding, params.key, cloudName);
    return this.client.context.withLock(id, async () => {
      const info = await stat(params.path);
      if (!info.isFile() || info.size !== params.size) throw new Error('上传源文件大小发生变化。');
      const hash = createHash('sha1'), checksum = createHash('sha256');
      for await (const bytes of createReadStream(params.path)) { hash.update(bytes); checksum.update(bytes); }
      const sha1 = hash.digest('hex').toUpperCase();
      if (checksum.digest('hex') !== params.checksum) throw new Error('上传源文件 SHA256 校验失败。');
      const existing = fixedParent ? await (async () => {
        const saved = await this.client.context.getState<ObjectState>(id), item = await this.list(binding, fixedParent, cloudName!);
        return item ? { saved: saved?.fileId === item.file_id ? saved : null, item } : null;
      })() : await this.find(binding, params.key, false, cloudName);
      let saved = existing?.saved;
      if (existing) {
        const expectedRemoteSize = existing.item.status === 'uploading' && saved?.uploadId && !saved.ready
          ? saved.size : Number(existing.item.size);
        if (expectedRemoteSize !== params.size ||
          (saved && saved.checksum !== params.checksum) || existing.item.status === 'available' && String(existing.item.content_hash || '').toUpperCase() !== sha1 ||
          !saved && String(existing.item.content_hash || '').toUpperCase() !== sha1) {
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
      let confirmed = new Set<number>();
      if (!saved?.uploadId) {
        const parent = fixedParent || (params.project ? await this.projectFolder(config, params.project) : await this.folder(binding, true));
        const state = await this.client.fresh(binding.accountId);
        const digest = createHash('md5').update(state.accessToken).digest('hex').slice(0, 16);
        const offset = params.size ? Number(BigInt(`0x${digest}`) % BigInt(params.size)) : 0;
        const file = await open(params.path, 'r');
        let proof: Buffer;
        try { proof = Buffer.alloc(Math.min(8, params.size - offset)); await file.read(proof, 0, proof.length, offset); }
        finally { await file.close(); }
        const created = await this.client.request(binding.accountId, '/adrive/v2/file/createWithFolders', {
          drive_id: binding.driveId, parent_file_id: parent, type: 'file', name: cloudName || this.name(params.key), check_name_mode: 'refuse',
          size: params.size, content_hash: sha1, content_hash_name: 'sha1', proof_code: proof.toString('base64'), proof_version: 'v1', part_info_list: parts,
        });
        if (!created.file_id) throw new Error('创建网盘对象失败。');
        saved = { fileId: String(created.file_id), uploadId: created.upload_id, size: params.size, checksum: params.checksum, sha1, ready: Boolean(created.rapid_upload) };
        await this.client.context.setState(id, saved);
        if (saved.ready) return { storageKey: params.key };
        urls = created.part_info_list || [];
      } else {
        confirmed = await this.uploadedParts(binding, saved, params.size);
        const missing = parts.filter(part => !confirmed.has(part.part_number));
        const renewed = missing.length ? await this.client.request(binding.accountId, '/v2/file/get_upload_url', {
          drive_id: binding.driveId, file_id: saved.fileId, upload_id: saved.uploadId, part_info_list: missing,
        }) : {};
        urls = renewed.part_info_list || [];
      }
      for (const part of parts) {
        if (confirmed.has(part.part_number)) continue;
        let url = urls.find(item => item.part_number === part.part_number)?.upload_url;
        for (let attempt = 0; attempt < 3; attempt++) {
          if (!url) throw new Error('网盘没有返回分片上传地址。');
          const uploadUrl = checkedDownloadUrl(url);
          const start = (part.part_number - 1) * CHUNK_SIZE, end = Math.min(params.size, start + CHUNK_SIZE);
          const stream = params.size ? createReadStream(params.path, { start, end: end - 1 }) : Readable.from([]);
          let ok = false, status = 0;
          try {
            const response = await this.client.transport(uploadUrl, { method: 'PUT', body: stream as unknown as BodyInit,
              duplex: 'half', headers: { 'content-length': String(end - start) }, signal: AbortSignal.timeout(120_000), redirect: 'error' } as RequestInit);
            await response.body?.cancel();
            ok = response.ok; status = response.status;
          } catch (error) { if (error instanceof DriveError) throw error; }
          finally { stream.destroy(); }
          if (ok) break;
          if (status && ![403, 408, 409, 429, 500, 502, 503, 504].includes(status)) throw new DriveError('PartUploadFailed', status);
          // A timeout can occur after the server accepted a sequential part.
          // Confirm the server checkpoint before retrying; a 409 alone is never
          // sufficient proof that the expected bytes have already arrived.
          confirmed = await this.uploadedParts(binding, saved, params.size);
          if (confirmed.has(part.part_number)) break;
          if (status === 409) throw new DriveError('PartUploadFailed', status);
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
    if (found && !found.saved && found.item.status === 'available' && !found.item.trashed && Number(found.item.size) === size) {
      const description = await this.find(binding, key, false, `${this.name(key)}.ufm.json`);
      const json = description && await this.readJson(binding, description.item);
      const portable = json && checkedPortableDescription(json.value, found.item);
      if (portable && portable.storageKey === key && portable.checksum === checksum) {
        const saved = { fileId: String(found.item.file_id), size, checksum, sha1: String(found.item.content_hash).toUpperCase(), ready: true };
        await this.client.context.setState(this.objectKey(binding, key), saved);
        found.saved = saved;
      }
    }
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
    await this.client.context.withLock(`portable-${id}`, async () => {
      // Resolve the whole pair before any deletion; ambiguous metadata must not
      // leave an otherwise valid object only partly removed.
      await this.find(binding, key, true);
      await this.find(binding, key, true, `${this.name(key)}.ufm.json`);
      await this.removeObject(config, key);
      await this.removeObject(config, key, `${this.name(key)}.ufm.json`);
    });
  }
  private async removeObject(config: RuntimeCdnConfig, key: string, cloudName?: string) {
    const binding = this.binding(config), id = this.stateKey(binding, key, cloudName);
    await this.client.context.withLock(id, async () => {
      const found = await this.find(binding, key, true, cloudName);
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
