import { createReadStream, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { Readable } from 'node:stream';

import { CdnProvider } from '@prisma/client';

import type {
  RuntimeCdnConfig,
  StorageAdapter,
  StorageDownloadTarget,
  StorageUploadParams,
  StoredObject,
} from '../storage.types';
import { configText, publicUrlFromDomain } from '../storage.util';

/** Local filesystem adapter. Config keys: `root`, `domain?`. */
export class LocalStorageAdapter implements StorageAdapter {
  readonly provider = CdnProvider.LOCAL;

  async upload(config: RuntimeCdnConfig, params: StorageUploadParams): Promise<StoredObject> {
    const path = this.absolutePath(config, params.key);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, params.buffer);

    return { storageKey: params.key, publicUrl: publicUrlFromDomain(config, params.key) };
  }

  async remove(config: RuntimeCdnConfig, key: string): Promise<void> {
    rmSync(this.absolutePath(config, key), { force: true });
  }

  async getDownloadUrl(config: RuntimeCdnConfig, key: string): Promise<string> {
    return this.absolutePath(config, key);
  }

  async objectExists(config: RuntimeCdnConfig, key: string): Promise<boolean> {
    return existsSync(this.absolutePath(config, key));
  }

  async getDownloadTarget(
    config: RuntimeCdnConfig,
    key: string,
    range?: { start?: number; end?: number },
  ): Promise<StorageDownloadTarget> {
    const path = this.absolutePath(config, key);

    try {
      if (!statSync(path).isFile()) {
        return { type: 'stream', stream: Readable.from([]) };
      }
    } catch {
      return { type: 'stream', stream: Readable.from([]) };
    }

    return {
      type: 'stream',
      stream: range ? createReadStream(path, { start: range.start, end: range.end }) : createReadStream(path),
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
