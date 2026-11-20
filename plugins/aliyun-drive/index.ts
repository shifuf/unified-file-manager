import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PluginContext, StorageAdapter } from '@ufm/storage-plugin-sdk';
import { DriveClient, stateKey, type Transport } from './client';
import { DriveAuth } from './auth';
import { DriveObjects } from './objects';
import { DriveRemoteFiles } from './remote-files';

export function createAdapter(context?: PluginContext, transport: Transport = fetch): StorageAdapter {
  const unavailable = async (): Promise<never> => { throw new Error('此插件需要宿主提供加密账号状态，请升级宿主后重试。'); };
  const state: PluginContext = context ?? { getState: unavailable, setState: unavailable, withLock: unavailable };
  const client = new DriveClient(state, transport), auth = new DriveAuth(client), objects = new DriveObjects(client);
  const remote = new DriveRemoteFiles(client, objects);
  return {
    provider: 'ALIYUN_DRIVE',
    startLogin: accountId => auth.startLogin(accountId), pollLogin: sessionId => auth.pollLogin(sessionId), cancelLogin: sessionId => auth.cancelLogin(sessionId),
    accountStatus: async accountId => {
      try { return await client.profile(accountId); }
      catch { const saved = await client.load(accountId); return { ...client.summary(saved), connected: false }; }
    },
    disconnectAccount: accountId => state.withLock(`token-${accountId}`, () => state.setState(stateKey(accountId), null)),
    upload: async (config, params) => {
      const directory = await mkdtemp(join(tmpdir(), 'ufm-drive-upload-'));
      try {
        const path = join(directory, 'object'); await writeFile(path, params.buffer, { mode: 0o600 });
        return await objects.uploadFile(config, { ...params, path, size: params.buffer.length, checksum: createHash('sha256').update(params.buffer).digest('hex') });
      } finally { await rm(directory, { recursive: true, force: true }); }
    },
    uploadFile: (config, params) => objects.uploadFile(config, params),
    verifyBackup: (config, params) => objects.verifyBackup(config, params.key, params.size, params.checksum),
    objectExists: (config, key) => objects.objectExists(config, key),
    getDownloadUrl: (config, key, expires) => objects.getDownloadUrl(config, key, expires),
    getDownloadTarget: (config, key, range) => objects.getDownloadTarget(config, key, range),
    remove: (config, key) => objects.remove(config, key),
    getUsage: config => objects.getUsage(config),
    listRemoteFiles: (config, options) => remote.list(config, options),
    readRemoteFile: (config, id, options) => remote.read(config, id, options),
  };
}
