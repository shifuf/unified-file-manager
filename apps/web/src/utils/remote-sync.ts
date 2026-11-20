import type { StorageRemoteFile, StorageRemoteFilePage } from '@/api/remote-files';

export interface RemoteSyncFile {
  id: string;
  name: string;
  folderPath: string;
  selectionId?: string;
  source?: StorageRemoteFile;
  sourceCursor?: string;
}
export interface RemoteSyncBatch { files: RemoteSyncFile[]; folderPath: string; projectIds: string[]; jobId?: string }
interface CollectOptions {
  entries?: StorageRemoteFile[];
  parentId?: string;
  folderPath?: string;
  itemCursors?: ReadonlyMap<string, string | undefined>;
  list: (query: { parentId?: string; cursor?: string }) => Promise<StorageRemoteFilePage>;
  onProgress?: (files: number, directories: number) => void;
}

function destinationPath(value: string): string {
  const parts = value.trim().split(/[\\/]/).filter(Boolean);
  if (value.length > 512 || /\p{Cc}/u.test(value) || /^[\\/]|^[A-Za-z]:|:\/\//u.test(value) || parts.some(part => part === '.' || part === '..')) {
    throw new Error('目标目录无效，请使用不含上级跳转的相对路径（最多512个字符）。');
  }
  return parts.join('/');
}

function sourceDestination(base: string, item: StorageRemoteFile): string {
  const path = item.folderPath;
  if (!path) return base;
  const parts = path.split('/');
  if (path.length > 512 || /^[\\/]|^[A-Za-z]:|:\/\//u.test(path) || /[\\\p{Cc}]/u.test(path) || parts.length > 64 || parts.some(part => !part || part === '.' || part === '..' || part.length > 255)) {
    throw new Error(`文件“${item.originalName || item.name}”的原目录无效，请刷新或调整云盘元数据后重试。`);
  }
  return destinationPath(base ? `${base}/${path}` : path);
}

function childPath(base: string, item: StorageRemoteFile): string {
  const name = item.originalName || item.name;
  if (!name.trim() || name === '.' || name === '..' || /[\\/]|\p{Cc}/u.test(name)) {
    throw new Error(`云盘目录名“${name}”无法保留为相对路径，请调整目录名后重试。`);
  }
  return destinationPath(base ? `${base}/${name}` : name);
}

/** Complete discovery before the caller submits any imports. */
export async function collectRemoteSyncFiles(options: CollectOptions): Promise<RemoteSyncFile[]> {
  const base = destinationPath(options.folderPath || '');
  const files = new Map<string, RemoteSyncFile>();
  const directories = new Set<string>();
  const queue: Array<{ id?: string; path: string; depth: number; selectionId?: string }> = [];
  let scannedEntries = 0, pageCount = 0;

  function addFile(item: StorageRemoteFile, path: string, selectionId?: string, cursor?: string): void {
    if (files.has(item.id)) return;
    if (files.size >= 2000) throw new Error('本次同步超过2000个文件，请分批选择目录后重试。');
    files.set(item.id, { id: item.id, name: item.originalName || item.name, folderPath: sourceDestination(path, item), selectionId, source: { ...item }, sourceCursor: cursor });
    options.onProgress?.(files.size, directories.size);
  }
  function addDirectory(item: StorageRemoteFile, path: string, depth: number, selectionId?: string): void {
    if (depth > 64) throw new Error('云盘目录超过64层，请从较深的目录开始同步。');
    if (directories.has(item.id)) throw new Error('发现重复或循环的云盘目录，已停止同步，请刷新后重试。');
    if (directories.size >= 2000) throw new Error('本次同步超过2000个目录，请分批选择后重试。');
    directories.add(item.id);
    queue.push({ id: item.id, path: childPath(path, item), depth, selectionId });
  }

  if (options.entries) {
    for (const item of options.entries) {
      if (item.type === 'folder') addDirectory(item, base, 1, item.id);
      else addFile(item, base, item.id, options.itemCursors?.get(item.id));
    }
  } else {
    if (options.parentId) directories.add(options.parentId);
    queue.push({ id: options.parentId, path: base, depth: 0 });
  }

  for (const directory of queue) {
    const cursors = new Set<string>();
    let cursor: string | undefined, resolvedId = directory.id;
    do {
      if (++pageCount > 10000) throw new Error('云盘目录分页超过10000页，已停止同步，请分批选择后重试。');
      const result = await options.list({ ...(directory.id ? { parentId: directory.id } : {}), ...(cursor ? { cursor } : {}) });
      if (resolvedId && result.parentId !== resolvedId) throw new Error('读取时云盘目录发生变化，已停止同步，请刷新后重试。');
      if (!resolvedId) {
        resolvedId = result.parentId;
        directories.add(resolvedId);
      }
      scannedEntries += result.items.length;
      if (scannedEntries > 10000) throw new Error('本次云盘目录条目超过10000项，请分批选择后重试。');
      for (const item of result.items) {
        if (item.parentId !== result.parentId) throw new Error('云盘返回了不属于当前目录的条目，已停止同步，请刷新后重试。');
        if (item.type === 'folder') addDirectory(item, directory.path, directory.depth + 1, directory.selectionId);
        else addFile(item, directory.path, directory.selectionId, cursor);
      }
      const next = result.nextCursor || undefined;
      if (next && cursors.has(next)) throw new Error('云盘分页标记重复，已停止同步，请刷新后重试。');
      if (next) cursors.add(next);
      cursor = next;
      options.onProgress?.(files.size, directories.size);
    } while (cursor);
  }
  return [...files.values()];
}

export function createRemoteSyncBatches(files: RemoteSyncFile[], projectIds: string[]): RemoteSyncBatch[] {
  const targets = [...new Set(projectIds)];
  if (!targets.length) throw new Error('请先选择目标项目。');
  if (targets.length > 20) throw new Error('一次最多同步到20个目标项目。');
  const groups = new Map<string, RemoteSyncFile[]>();
  for (const file of files) {
    // A fresh source page adds at most200 host snapshots. Grouping that page
    // separately prevents a later page from evicting proof for this batch.
    const key = JSON.stringify([file.folderPath, file.source?.parentId, file.sourceCursor]);
    const group = groups.get(key) || [];
    group.push(file);
    groups.set(key, group);
  }
  const batches: RemoteSyncBatch[] = [];
  for (const group of groups.values()) {
    // One cloud source per request bounds proxy wait time and exposes progress
    // as each file finishes, while staging once for all selected projects.
    for (const file of group) {
      batches.push({ folderPath: file.folderPath, files: [file], projectIds: [...targets] });
    }
  }
  return batches;
}

/** Renew the host snapshot, retaining the original discovery as the baseline. */
export async function refreshRemoteSyncBatch(batch: RemoteSyncBatch, list: CollectOptions['list']): Promise<void> {
  const first = batch.files[0];
  if (!first?.source || batch.files.some(file => !file.source || file.source.parentId !== first.source!.parentId || file.sourceCursor !== first.sourceCursor)) {
    throw new Error('同步来源目录信息不完整，请刷新列表并重新选择。');
  }
  const result = await list({ parentId: first.source.parentId, ...(first.sourceCursor ? { cursor: first.sourceCursor } : {}) });
  if (result.parentId !== first.source.parentId || result.items.length > 200) throw new Error('云盘来源目录发生变化，请刷新列表并重新选择。');
  for (const file of batch.files) {
    const current = result.items.find(item => item.id === file.id);
    const original = file.source!;
    if (!current) throw new Error(`云盘文件“${file.name}”不存在或分页位置已变化，请刷新列表并重新选择。`);
    if (current.type !== 'file' || current.parentId !== original.parentId || String(current.size) !== String(original.size) || current.name !== original.name ||
      current.originalName !== original.originalName || current.folderPath !== original.folderPath ||
      current.sha1?.toLowerCase() !== original.sha1?.toLowerCase() || current.checksum?.toLowerCase() !== original.checksum?.toLowerCase()) {
      throw new Error(`云盘文件“${file.name}”已变化，请刷新列表并重新选择。`);
    }
  }
}
