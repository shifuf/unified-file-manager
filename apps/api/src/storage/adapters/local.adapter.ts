import { createReadStream, mkdirSync, rmSync, statSync } from 'node:fs';
import { copyFile, link, open, rename, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, resolve } from 'node:path';
import { ConflictException, NotFoundException } from '@nestjs/common';

import { CdnProvider } from '@prisma/client';

import type {
  RuntimeCdnConfig,
  StorageAdapter,
  StorageDownloadTarget,
  StorageUploadParams,
  StorageUploadFileParams,
  StorageObjectFingerprint,
  StoredObject,
} from '../storage.types';
import { configText, publicUrlFromDomain } from '../storage.util';

/** Local filesystem adapter. Config keys: `root`, `domain?`. */
export class LocalStorageAdapter implements StorageAdapter {
  readonly provider = CdnProvider.LOCAL;

  async upload(config: RuntimeCdnConfig, params: StorageUploadParams): Promise<StoredObject> {
    const path = this.absolutePath(config, params.key);
    mkdirSync(dirname(path), { recursive: true });
    const staged = `${path}.${randomUUID()}.tmp`;
    try {
      const handle = await open(staged, 'wx');
      try { await handle.writeFile(params.buffer); await handle.sync(); } finally { await handle.close(); }
      await this.publish(staged, path, params.buffer.length, createHash('sha256').update(params.buffer).digest('hex'));
      return { storageKey: params.key, publicUrl: publicUrlFromDomain(config, params.key) };
    } finally { await rm(staged, { force: true }); }
  }

  async uploadFile(config: RuntimeCdnConfig, params: StorageUploadFileParams): Promise<StoredObject> {
    const path = this.absolutePath(config, params.key);
    mkdirSync(dirname(path), { recursive: true });
    const staged = `${path}.${randomUUID()}.tmp`;
    try {
      await copyFile(params.path, staged);
      const handle = await open(staged, 'r+');
      try { await handle.sync(); } finally { await handle.close(); }
      await this.publish(staged, path, params.size, params.checksum);
      return { storageKey: params.key, publicUrl: publicUrlFromDomain(config, params.key) };
    } finally { await rm(staged, { force: true }); }
  }

  async getObjectFingerprint(config: RuntimeCdnConfig, key: string): Promise<StorageObjectFingerprint | null> {
    try { return await hashFile(this.absolutePath(config, key)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }

  /** Used only after an independent replica verifies the expected good digest. */
  async repairFile(config: RuntimeCdnConfig, params: StorageUploadFileParams, corrupt: StorageObjectFingerprint): Promise<StoredObject> {
    if (corrupt.size === params.size && corrupt.checksum === params.checksum) throw new ConflictException('本地对象未确认损坏，已拒绝修复。');
    const path = this.absolutePath(config, params.key);
    const staged = `${path}.${randomUUID()}.repair.tmp`;
    mkdirSync(dirname(path), { recursive: true });
    try {
      await copyFile(params.path, staged);
      const handle = await open(staged, 'r+');
      try { await handle.sync(); } finally { await handle.close(); }
      const replacement = await hashFile(staged);
      if (replacement.size !== params.size || replacement.checksum !== params.checksum) throw new Error('本地写盘对象大小或 SHA256 校验失败。');
      const current = await this.getObjectFingerprint(config, params.key);
      if (!current) throw new ConflictException('本地对象在修复前已发生变化，请重试。');
      if (current.size === params.size && current.checksum === params.checksum) return { storageKey: params.key };
      if (!sameFingerprint(current, corrupt)) throw new ConflictException('本地对象在修复前已发生变化，请重试。');

      const quarantine = this.absolutePath(config, `.ufm-quarantine/${randomUUID()}`);
      mkdirSync(dirname(quarantine), { recursive: true });
      await rename(path, quarantine);
      // Rename preserves open readers' inode. Verify again after isolation: if
      // a concurrent publisher replaced the path between comparison and rename,
      // restore it exclusively and preserve the isolated bytes in either case.
      const isolated = await hashFile(quarantine);
      if (!sameFingerprint(isolated, corrupt)) {
        try { await link(quarantine, path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        throw new ConflictException('本地对象在隔离时已发生变化，已保留原内容。');
      }
      await this.publish(staged, path, params.size, params.checksum);
      return { storageKey: params.key, publicUrl: null };
    } finally { await rm(staged, { force: true }); }
  }

  private async publish(staged: string, path: string, size: number, checksum: string): Promise<void> {
    const actual = await hashFile(staged);
    if (actual.size !== size || actual.checksum !== checksum) throw new Error('本地写盘对象大小或 SHA256 校验失败。');
    // Both paths reside on the same filesystem. A hard link atomically publishes
    // complete bytes and never overwrites an existing immutable object.
    try { await link(staged, path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await hashFile(path);
      if (existing.size !== size || existing.checksum !== checksum) throw new ConflictException('不可变本地对象内容冲突，请使用新的存储 key。');
    }
  }

  async remove(config: RuntimeCdnConfig, key: string): Promise<void> {
    rmSync(this.absolutePath(config, key), { force: true });
  }

  async getDownloadUrl(config: RuntimeCdnConfig, key: string): Promise<string> {
    return this.absolutePath(config, key);
  }

  async objectExists(config: RuntimeCdnConfig, key: string): Promise<boolean> {
    try { return statSync(this.absolutePath(config, key)).isFile(); } catch { return false; }
  }

  async getDownloadTarget(
    config: RuntimeCdnConfig,
    key: string,
    range?: { start?: number; end?: number },
  ): Promise<StorageDownloadTarget> {
    const path = this.absolutePath(config, key);

    let size: number;
    try {
      const stats = statSync(path);
      if (!stats.isFile()) throw new Error('not a file');
      size = stats.size;
    } catch {
      throw new NotFoundException('本地存储对象不存在或不是文件。');
    }

    return {
      type: 'stream',
      stream: range ? createReadStream(path, { start: range.start, end: range.end }) : createReadStream(path),
      contentLength: range ? Math.max(0, (range.end ?? size - 1) - (range.start ?? 0) + 1) : size,
    };
  }

  root(config: RuntimeCdnConfig): string {
    return this.rootPath(config);
  }

  private absolutePath(config: RuntimeCdnConfig, key: string): string {
    const root = this.rootPath(config);
    const normalizedKey = key.replace(/\\/g, '/').replace(/^\/+/, '');
    const target = resolve(root, normalizedKey);
    const prefix = root.endsWith('/') ? root : `${root}/`;

    if (target !== root && !target.replace(/\\/g, '/').startsWith(prefix.replace(/\\/g, '/'))) {
      throw new Error('本地存储路径越界，已拒绝访问。');
    }

    return target;
  }

  private rootPath(config: RuntimeCdnConfig): string {
    const rootValue = configText(config, 'root', './storage');
    return isAbsolute(rootValue) ? rootValue : resolve(workspaceRoot(), rootValue);
  }
}

async function hashFile(path: string): Promise<StorageObjectFingerprint> {
  const handle = await open(path, 'r');
  const digest = createHash('sha256'); let size = 0;
  let stream: ReturnType<typeof handle.createReadStream> | undefined;
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new NotFoundException('本地存储对象不是文件。');
    stream = handle.createReadStream({ autoClose: false });
    for await (const chunk of stream) { const buffer = chunk as Buffer; size += buffer.length; digest.update(buffer); }
    const after = await handle.stat({ bigint: true });
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new ConflictException('本地对象在核验期间已发生变化，请重试。');
    return { size, checksum: digest.digest('hex'), identity: `${before.dev}:${before.ino}:${before.birthtimeNs}:${before.mtimeNs}` };
  } finally { stream?.destroy(); await handle.close(); }
}

function sameFingerprint(left: StorageObjectFingerprint, right: StorageObjectFingerprint): boolean {
  return left.identity === right.identity && left.size === right.size && left.checksum === right.checksum;
}

function workspaceRoot(): string {
  const cwd = process.cwd().replace(/\\/g, '/');
  if (cwd.endsWith('/apps/api')) {
    return resolve(process.cwd(), '../..');
  }
  if (cwd.endsWith('/apps/api/dist')) {
    return resolve(process.cwd(), '../../../..');
  }
  return process.cwd();
}
