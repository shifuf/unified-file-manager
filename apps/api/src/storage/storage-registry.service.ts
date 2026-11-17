import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { resolve } from 'node:path';
import { type StoragePluginManifest } from '@ufm/storage-plugin-sdk';
import { LocalStorageAdapter } from './adapters/local.adapter';
import type { RuntimeCdnConfig, StorageAdapter } from './storage.types';
import { PluginStore } from './plugins/plugin-store';
import { PluginStateStore } from './plugins/plugin-state-store';
import { getAppCryptoKey } from '../common/utils/security-config.util';

export const LOCAL_MANIFEST = {
  id: 'LOCAL', name: '本地存储', version: '1.0.0', apiVersion: 1, entry: '',
  description: '本地保存文件，也是远端故障时的安全副本。',
  fields: [
    { key: 'root', label: '保存目录', type: 'string', required: true, default: './storage' },
    { key: 'domain', label: '访问域名', type: 'string', required: false, url: true },
  ], capabilities: { directUpload: false, usage: false },
} as StoragePluginManifest;

@Injectable()
export class StorageAdapterRegistry implements OnModuleInit {
  readonly store: PluginStore;
  constructor(private readonly localAdapter: LocalStorageAdapter, config: ConfigService) {
    const cwd = process.cwd();
    const workspace = /[\\/]apps[\\/]api$/.test(cwd) ? resolve(cwd, '../..') : cwd;
    const root = resolve(config.get<string>('STORAGE_PLUGIN_DIR') || resolve(workspace, 'storage-plugins'));
    const state = new PluginStateStore(resolve(root, 'state'), getAppCryptoKey(config));
    this.store = new PluginStore(root, provider => state.context(provider));
  }
  async onModuleInit() {
    try { await this.store.load(); }
    catch (error) { new Logger(StorageAdapterRegistry.name).error(error instanceof Error ? error.message : '插件加载失败'); }
  }
  adapter(provider: string): StorageAdapter { return provider === 'LOCAL' ? this.localAdapter : this.store.adapter(provider); }
  manifest(provider: string) { return provider === 'LOCAL' ? LOCAL_MANIFEST : this.store.manifest(provider); }
  list() { return [{ ...LOCAL_MANIFEST, builtin: true, available: true }, ...this.store.list()]; }
  localRoot(config: RuntimeCdnConfig): string | null { return config.provider === 'LOCAL' ? this.localAdapter.root(config) : null; }
  supportsDirectUpload(provider: string): boolean {
    try { return Boolean(this.manifest(provider)?.capabilities.directUpload && typeof this.adapter(provider).createDirectUpload === 'function'); }
    catch { return false; }
  }
}
