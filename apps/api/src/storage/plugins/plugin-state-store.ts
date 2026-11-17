import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PluginContext } from '@ufm/storage-plugin-sdk';
import { encryptText, decryptText } from '../../common/utils/crypto.util';

/** Single API process, matching the plugin installation lifecycle. */
export class PluginStateStore {
  private readonly locks = new Map<string, Promise<unknown>>();
  constructor(private readonly root: string, private readonly cryptoKey: string) {}
  context(provider: string): PluginContext {
    this.check(provider);
    const directory = join(this.root, provider);
    return {
      getState: async <T>(key: string): Promise<T | null> => {
        this.check(key);
        try { return JSON.parse(decryptText(await readFile(join(directory, `${key}.json`), 'utf8'), this.cryptoKey)) as T; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
      },
      setState: async (key, value) => {
        this.check(key);
        await mkdir(directory, { recursive: true });
        const target = join(directory, `${key}.json`);
        if (value === null) { await unlink(target).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; }); return; }
        const temporary = join(directory, `${key}-${randomUUID()}.tmp`);
        try {
          await writeFile(temporary, encryptText(JSON.stringify(value), this.cryptoKey), { flag: 'wx', mode: 0o600 });
          await rename(temporary, target);
        } finally { await unlink(temporary).catch(() => undefined); }
      },
      withLock: async <T>(key: string, action: () => Promise<T>): Promise<T> => {
        this.check(key);
        const id = `${provider}:${key}`;
        const previous = this.locks.get(id) ?? Promise.resolve();
        const running = previous.catch(() => undefined).then(action);
        this.locks.set(id, running);
        try { return await running; } finally { if (this.locks.get(id) === running) this.locks.delete(id); }
      },
    };
  }
  private check(key: string) { if (!/^[A-Za-z0-9_-]{1,180}$/.test(key)) throw new Error('插件状态标识无效。'); }
}
