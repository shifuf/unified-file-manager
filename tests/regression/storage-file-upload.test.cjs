const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { createReadStream } = require('node:fs');
const { mkdtemp, writeFile, readFile, rm } = require('node:fs/promises');
const { createHash } = require('node:crypto');
require('ts-node').register({ project: path.resolve(__dirname, '../../apps/api/tsconfig.json'), transpileOnly: true });
const { StorageService } = require('../../apps/api/src/storage/storage.service.ts');
const { StorageLimitsService, StorageLimitError } = require('../../apps/api/src/storage/storage-limits.service.ts');

async function fixture(t, adapterOverrides = {}, rowOverrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ufm-file-upload-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'), target = path.join(root, 'target');
  const body = Buffer.from('disk archive bytes');
  await writeFile(source, body);
  const checksum = createHash('sha256').update(body).digest('hex');
  const row = { id: 'cloud', name: 'cloud', provider: 'S3', config: {}, enabled: true,
    storageLimitEnabled: true, trafficLimitEnabled: true, trafficQuotaMode: 'FIXED', trafficPeriodKey: null,
    quotaRevision: 0, trackedStorageBytes: 0n, storageQuotaBytes: 100n, manualStorageUsedBytes: 0n,
    trafficQuotaBytes: 100n, manualTrafficUsedBytes: 0n, ...rowOverrides };
  const ledger = [];
  let sequence = 0, stored = false, uploads = 0;
  const db = { cdnConfig: {
    findFirst: async () => ({ ...row }),
    updateMany: async ({ where, data }) => {
      if (!Object.entries(where).every(([key, value]) => value && typeof value === 'object' && 'gte' in value ? row[key] >= value.gte : row[key] === value)) return { count: 0 };
      for (const [key, value] of Object.entries(data)) row[key] = value && typeof value === 'object'
        ? 'increment' in value ? row[key] + value.increment : row[key] - value.decrement : value;
      return { count: 1 };
    },
  }, storageSpaceReservation: {
    findUnique: async ({ where }) => ledger.find(item => where.id ? item.id === where.id : item.configId === where.configId_keyHash.configId && item.keyHash === where.configId_keyHash.keyHash) ?? null,
    create: async ({ data }) => { const item = { id: String(++sequence), ...data }; ledger.push(item); return { ...item }; },
    update: async ({ where, data }) => { const item = ledger.find(item => item.id === where.id); Object.assign(item, data); return { ...item }; },
    delete: async ({ where }) => ledger.splice(ledger.findIndex(item => item.id === where.id), 1)[0],
  }, $queryRaw: async () => [], $transaction: async callback => callback(db) };
  const adapter = {
    upload: async () => { throw new Error('buffer upload must not be used'); },
    uploadFile: async (_config, params) => {
      uploads++;
      assert.equal(params.path, source);
      assert.equal(params.key, 'backups/archive.ufm');
      assert.equal(params.checksum, checksum);
      assert.deepEqual(params.project, { id: 'project', name: 'Project' });
      await writeFile(target, await readFile(params.path));
      stored = true;
      return { storageKey: params.key };
    },
    getDownloadTarget: async () => ({ type: 'stream', stream: createReadStream(target), contentLength: body.length }),
    objectExists: async () => stored,
    getUsage: async () => ({}),
    ...adapterOverrides,
  };
  const registry = { adapter: () => adapter };
  const limits = new StorageLimitsService(db, registry, { get: () => undefined });
  const storage = new StorageService({ get: () => undefined }, db, registry, undefined, limits);
  const params = { key: '/backups//archive.ufm', path: source, size: body.length, checksum,
    mimeType: 'application/gzip', originalName: 'archive.ufm', project: { id: 'project', name: 'Project' } };
  return { storage, params, row, ledger, adapter, source, target, body, uploads: () => uploads };
}

test('disk upload uses the file adapter and verifies cloud bytes before completing its space reservation', async t => {
  const f = await fixture(t);
  const uploaded = await f.storage.uploadFileToConfig('cloud', f.params);
  assert.deepEqual(uploaded, { cdnConfigId: 'cloud', storageKey: 'backups/archive.ufm', publicUrl: null });
  assert.deepEqual(await readFile(f.target), f.body);
  assert.equal(f.row.trackedStorageBytes, BigInt(f.body.length));
  assert.equal(f.row.manualTrafficUsedBytes, BigInt(f.body.length));
  assert.equal(f.ledger[0].owner, null);
});

test('disk upload cannot bypass cloud admission and never invokes an adapter when quota is exhausted', async t => {
  const f = await fixture(t, {}, { manualTrafficUsedBytes: 100n });
  await assert.rejects(f.storage.uploadFileToConfig('cloud', f.params), StorageLimitError);
  assert.equal(f.uploads(), 0);
  assert.equal(f.row.trackedStorageBytes, 0n);
});

test('disk upload rejects a changed source before reserving space or invoking an adapter', async t => {
  const f = await fixture(t);
  await writeFile(f.source, Buffer.alloc(f.body.length, 1));
  await assert.rejects(f.storage.uploadFileToConfig('cloud', f.params), /SHA256/);
  assert.equal(f.uploads(), 0);
  assert.equal(f.row.trackedStorageBytes, 0n);
  assert.equal(f.row.manualTrafficUsedBytes, 0n);
});

test('disk upload reconciles a proven absent failure and refunds unused verification traffic', async t => {
  const f = await fixture(t, { uploadFile: async () => { throw new Error('before write'); } });
  await assert.rejects(f.storage.uploadFileToConfig('cloud', f.params), /before write/);
  assert.equal(f.row.trackedStorageBytes, 0n);
  assert.equal(f.row.manualTrafficUsedBytes, 0n);
  assert.equal(f.ledger.length, 0);
});

test('disk upload rejects corrupted cloud bytes and preserves space for the existing object', async t => {
  const f = await fixture(t);
  f.adapter.getDownloadTarget = async () => {
    await writeFile(f.target, Buffer.alloc(f.body.length, 0));
    return { type: 'stream', stream: createReadStream(f.target), contentLength: f.body.length };
  };
  await assert.rejects(f.storage.uploadFileToConfig('cloud', f.params), /SHA256/);
  assert.equal(f.row.trackedStorageBytes, BigInt(f.body.length));
  assert.equal(f.row.manualTrafficUsedBytes, BigInt(f.body.length));
  assert.equal(f.ledger[0].owner, null);
});

test('disk upload supports a bounded buffer fallback when the adapter has no file method', async t => {
  let received;
  const f = await fixture(t, { uploadFile: undefined, upload: async (_config, params) => {
    received = params;
    await writeFile(f.target, params.buffer);
    return { storageKey: params.key };
  } });
  await f.storage.uploadFileToConfig('cloud', f.params);
  assert.deepEqual(received.buffer, f.body);
  assert.equal(received.key, 'backups/archive.ufm');
  assert.deepEqual(received.project, f.params.project);
});

test('disk upload refuses a large buffer fallback before reserving quota or reading the file', async t => {
  const f = await fixture(t, { uploadFile: undefined });
  await assert.rejects(f.storage.uploadFileToConfig('cloud', { ...f.params, path: 'not-a-file', size: 33 * 1024 * 1024 }), /32MiB|流式/);
  assert.equal(f.row.trackedStorageBytes, 0n);
  assert.equal(f.row.manualTrafficUsedBytes, 0n);
});
