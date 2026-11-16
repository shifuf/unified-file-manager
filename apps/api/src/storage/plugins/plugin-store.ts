import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import * as yauzl from 'yauzl';
import { validateManifest, validateAdapter, validateConfig, type RuntimeCdnConfig, type StoragePluginManifest, type StorageAdapter } from '@ufm/storage-plugin-sdk';

type Entry = { manifest: StoragePluginManifest; digest: string; directory: string };
type Loaded = Entry & { adapter?: StorageAdapter; error?: string };
const MAX_ZIP = 32 * 1024 * 1024;
const MAX_EXPANDED = 128 * 1024 * 1024;

/** Trusted server code. Archive validation protects installation paths, not against malicious JavaScript. */
export class PluginStore {
  private entries = new Map<string, Loaded>();
  constructor(readonly root: string) {}

  async load(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    let index: Entry[];
    try { index = JSON.parse(await readFile(join(this.root, 'active.json'), 'utf8')) as Entry[]; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw new Error('插件索引损坏，请恢复 active.json。'); }
    if (!Array.isArray(index)) throw new Error('插件索引格式错误。');
    for (const item of index) {
      try {
        validateManifest(item.manifest);
        if (!/^[a-f0-9]{64}-[a-f0-9-]{36}$/.test(item.directory)) throw new Error('插件目录无效。');
        const bytes = await readFile(join(this.root, item.directory, 'package.zip'));
        if (digest(bytes) !== item.digest) throw new Error('插件包校验失败。');
        // Recreate executable files from the verified archive instead of trusting stale extracted code.
        const files = await unpack(bytes);
        const archived = validateManifest(JSON.parse(files.get('storage-plugin.json')?.toString('utf8') ?? 'null'));
        if (JSON.stringify(archived) !== JSON.stringify(item.manifest)) throw new Error('插件索引与包清单不一致。');
        for (const [name, data] of files) await writeFile(join(this.root, item.directory, name), data);
        const adapter = this.instantiate(item);
        this.entries.set(item.manifest.id, { ...item, adapter });
      } catch (error) {
        if (item.manifest?.id && item.manifest.id !== 'LOCAL') this.entries.set(item.manifest.id, { ...item, error: message(error) });
      }
    }
  }

  list() { return [...this.entries.values()].map(({ manifest, digest: sha256, error }) => ({ ...manifest, sha256, builtin: false, available: !error, ...(error ? { error } : {}) })); }
  manifest(id: string) { return this.entries.get(id)?.manifest; }
  adapter(id: string): StorageAdapter {
    const item = this.entries.get(id);
    if (!item?.adapter) throw new Error(`存储插件 ${id} 未安装或不可用，请先在插件管理中安装。`);
    const adapter = item.adapter;
    return new Proxy(adapter, { get(target, property, receiver): unknown {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      return async (config: RuntimeCdnConfig, ...args: unknown[]) => {
        const normalized = { ...config, config: validateConfig(item.manifest, config.config) };
        try { return await (value as (this: StorageAdapter, config: RuntimeCdnConfig, ...args: unknown[]) => Promise<unknown>).call(target, normalized, ...args); }
        catch (error) {
          let reason = message(error);
          for (const [key, secret] of Object.entries(config.config)) {
            if (typeof secret === 'string' && secret && (/secret|password|token|accesskey|operator/i.test(key) || item.manifest.fields.some(f => f.key === key && f.secret))) {
              reason = reason.split(secret).join('******');
            }
          }
          reason = reason.replace(/https?:\/\/[^\s]+/g, '[远程地址]');
          throw new Error(reason.slice(0, 512));
        }
      };
    } });
  }
  async package(id: string): Promise<Buffer> {
    const item = this.entries.get(id);
    if (!item) throw new Error('插件不存在。');
    const bytes = await readFile(join(this.root, item.directory, 'package.zip'));
    if (digest(bytes) !== item.digest) throw new Error('插件包校验失败。');
    return bytes;
  }

  async install(bytes: Buffer, check?: (manifest: StoragePluginManifest) => Promise<void>) {
    return this.lock(async () => {
      const files = await unpack(bytes);
      const manifest = validateManifest(JSON.parse(files.get('storage-plugin.json')?.toString('utf8') ?? 'null'));
      if (!files.has(manifest.entry)) throw new Error('插件入口不存在。');
      await check?.(manifest);
      const sha256 = digest(bytes), directory = `${sha256}-${randomUUID()}`;
      const location = join(this.root, directory);
      await mkdir(location);
      for (const [name, data] of files) await writeFile(join(location, name), data, { flag: 'wx' });
      await writeFile(join(location, 'package.zip'), bytes, { flag: 'wx' });
      const item: Entry = { manifest, digest: sha256, directory };
      const adapter = this.instantiate(item);
      const next = new Map(this.entries); next.set(manifest.id, { ...item, adapter });
      await this.persist(next);
      this.entries = next;
      return this.list().find(p => p.id === manifest.id)!;
    });
  }
  async uninstall(id: string, check?: () => Promise<void>) {
    return this.lock(async () => {
      if (id === 'LOCAL') throw new Error('本地存储不能卸载。');
      if (!this.entries.has(id)) throw new Error('插件不存在。');
      await check?.();
      const next = new Map(this.entries); next.delete(id);
      await this.persist(next); this.entries = next;
      // Immutable versions remain for in-flight operations and operational recovery.
      return { success: true };
    });
  }
  private instantiate(item: Entry): StorageAdapter {
    const entry = resolve(this.root, item.directory, item.manifest.entry);
    const module = require(entry) as { createAdapter?: () => StorageAdapter };
    if (typeof module.createAdapter !== 'function') throw new Error('插件必须导出 createAdapter()。');
    const adapter = module.createAdapter(); validateAdapter(item.manifest, adapter); return adapter;
  }
  private async persist(entries: Map<string, Loaded>) {
    const temporary = join(this.root, `index-${randomUUID()}.json`);
    await writeFile(temporary, JSON.stringify([...entries.values()].map(({ manifest, digest: sha256, directory }) => ({ manifest, digest: sha256, directory }))), { flag: 'wx' });
    await rename(temporary, join(this.root, 'active.json'));
  }
  private async lock<T>(action: () => Promise<T>): Promise<T> {
    await mkdir(this.root, { recursive: true });
    const path = join(this.root, '.mutation.lock');
    let handle;
    try { handle = await open(path, 'wx'); } catch { throw new Error('已有插件安装操作进行中；异常退出后请检查并清理插件目录 .mutation.lock。'); }
    try { return await action(); } finally { await handle.close(); const { unlink } = await import('node:fs/promises'); await unlink(path); }
  }
}

function digest(bytes: Buffer) { return createHash('sha256').update(bytes).digest('hex'); }
function message(error: unknown) { return error instanceof Error ? error.message : '插件加载失败。'; }

/** v1 bundles are deliberately flat: manifest, index.cjs and optional README/LICENSE. */
export async function unpack(bytes: Buffer): Promise<Map<string, Buffer>> {
  if (!bytes.length || bytes.length > MAX_ZIP) throw new Error('插件 ZIP 必须在 32 MiB 以内。');
  return new Promise((accept, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, zip) => {
      if (error || !zip) { reject(new Error('插件 ZIP 格式错误。')); return; }
      const files = new Map<string, Buffer>(); let total = 0, failed = false;
      const fail = (reason: unknown) => { if (failed) return; failed = true; zip.close(); reject(reason instanceof Error ? reason : new Error('插件 ZIP 读取失败。')); };
      zip.on('error', fail);
      zip.on('entry', (entry: yauzl.Entry) => {
        const name = entry.fileName, mode = (entry.externalFileAttributes >>> 16) & 0xf000;
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name) || name.toLowerCase() === 'package.zip' || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) || name.endsWith('.') || (mode !== 0 && mode !== 0x8000) || (entry.generalPurposeBitFlag & 1) || [...files.keys()].some(key => key.toLowerCase() === name.toLowerCase()) || files.size >= 64 || entry.uncompressedSize > MAX_EXPANDED || total + entry.uncompressedSize > MAX_EXPANDED) { fail(new Error('插件 ZIP 路径、类型、重复文件或解压大小无效。')); return; }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) { fail(streamError); return; }
          const chunks: Buffer[] = []; let size = 0;
          stream.on('error', fail);
          stream.on('data', (chunk: Buffer) => { size += chunk.length; if (total + size > MAX_EXPANDED) { stream.destroy(); fail(new Error('插件解压大小超限。')); } else chunks.push(chunk); });
          stream.on('end', () => { if (failed) return; total += size; files.set(name, Buffer.concat(chunks)); zip.readEntry(); });
        });
      });
      zip.on('end', () => { if (!failed) accept(files); });
      zip.readEntry();
    });
  });
}
