const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
require('ts-node').register({ project: path.resolve(__dirname, '../../apps/api/tsconfig.json'), transpileOnly: true });
const { StorageService } = require('../../apps/api/src/storage/storage.service.ts');

test('editing quota measurements takes effect without waiting for the usage cache', async () => {
  let config = { id: 'source', provider: 'UPYUN', name: 'source', config: {}, enabled: true,
    priority: 1, autoFailover: true, failoverThresholdPercent: 90, storageQuotaBytes: 100n,
    manualStorageUsedBytes: 10n, trafficQuotaBytes: null, manualTrafficUsedBytes: null,
    updatedAt: new Date('2026-11-13T00:00:00Z') };
  const db = { project: { findFirst: async () => ({ id: 'p', activeCdnConfigId: config.id, activeCdnConfig: config }) },
    cdnConfig: { findMany: async () => [] } };
  const service = new StorageService({ get: () => undefined }, db, { adapter: () => ({ getUsage: async () => ({}) }) });
  assert.equal((await service.getActiveStorage('p')).id, 'source');
  config = { ...config, manualStorageUsedBytes: 95n, updatedAt: new Date('2026-11-13T00:00:01Z') };
  await assert.rejects(service.getActiveStorage('p'), /没有剩余可用目标/);
  config = { ...config, manualStorageUsedBytes: null, storageQuotaBytes: null,
    trafficQuotaBytes: 100n, manualTrafficUsedBytes: 95n, updatedAt: new Date('2026-11-13T00:00:02Z') };
  await assert.rejects(service.getActiveStorage('p'), /没有剩余可用目标/);
  config = { ...config, manualTrafficUsedBytes: 5n, updatedAt: new Date('2026-11-13T00:00:03Z') };
  assert.equal((await service.getActiveStorage('p')).id, 'source');
});
