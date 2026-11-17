const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Readable } = require('node:stream');
require('ts-node').register({ project: path.resolve(__dirname, '../../apps/api/tsconfig.json'), transpileOnly: true });
const { StorageLimitsService, StorageLimitError } = require('../../apps/api/src/storage/storage-limits.service.ts');

function fixture(overrides = {}) {
  const row = { id: 'cloud', name: 'cloud', provider: 'S3', config: {}, enabled: true,
    storageLimitEnabled: true, trafficLimitEnabled: true, trafficQuotaMode: 'FIXED', trafficPeriodKey: null,
    quotaRevision: 0, trackedStorageBytes: 0n, storageQuotaBytes: 100n, manualStorageUsedBytes: 0n,
    trafficQuotaBytes: 100n, manualTrafficUsedBytes: 0n, failoverThresholdPercent: 90, ...overrides };
  const ledger = [];
  let sequence = 0, queue = Promise.resolve();
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
    delete: async ({ where }) => { const at = ledger.findIndex(item => item.id === where.id); return ledger.splice(at, 1)[0]; },
  }, $queryRaw: async () => [], $transaction: async callback => {
    const previous = queue; let release; queue = new Promise(resolve => { release = resolve; });
    await previous; try { return await callback(db); } finally { release(); }
  } };
  const service = new StorageLimitsService(db, { adapter: () => ({ getUsage: async () => ({}) }) }, { get: () => undefined });
  return { row, db, service, ledger };
}

test('concurrent traffic reservations cannot spend the same persistent balance', async () => {
  const { row, service } = fixture();
  const results = await Promise.allSettled([service.reserveRead(row, 60n), service.reserveRead(row, 60n)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(row.manualTrafficUsedBytes, 60n);
  assert.ok(results.find(r => r.status === 'rejected').reason instanceof StorageLimitError);
});

test('backup uploads reserve storage but need no download traffic even when traffic is exhausted', async () => {
  const f = fixture({ provider: 'ALIYUN_DRIVE', trafficQuotaBytes: 0n });
  f.service.registry.manifest = () => ({ capabilities: { backupOnly: true } });
  const reservation = await f.service.reserveUpload(f.row, 10n, 'backup-key');
  assert.equal(reservation.verification.bytes, null); assert.equal(f.row.manualTrafficUsedBytes, 0n);
  assert.equal(f.row.trackedStorageBytes, 10n);
  await f.service.finishUpload(reservation, 'PRESENT');
  assert.equal(f.ledger[0].owner, null);
  await assert.rejects(f.service.reserveUpload(f.row, 100n, 'too-large'), /空间/);
});

test('failed partial reads charge consumed bytes and refund only the unused reservation', async () => {
  const { row, service } = fixture();
  const ticket = await service.reserveRead(row, 80n);
  await service.settleRead(ticket, 17n);
  assert.equal(row.manualTrafficUsedBytes, 17n);
});

test('old settlement cannot overwrite an administrator correction', async () => {
  const { row, service } = fixture();
  const ticket = await service.reserveRead(row, 80n);
  row.quotaRevision++; row.manualTrafficUsedBytes = 11n;
  await service.settleRead(ticket, 3n);
  assert.equal(row.manualTrafficUsedBytes, 11n);
});

test('Shanghai month boundary resets effective and persistent usage while old settlement stays isolated', async () => {
  const { row, service } = fixture({ trafficQuotaMode: 'MONTHLY', trafficPeriodKey: '2026-11' });
  service.now = () => new Date('2026-11-30T15:59:59.999Z');
  const old = await service.reserveRead(row, 80n);
  service.now = () => new Date('2026-11-30T16:00:00.000Z');
  assert.equal(service.describe(row).trafficUsedBytes, '0');
  assert.equal(service.describe(row).trafficPeriodKey, '2026-12');
  await service.reserveRead(row, 20n);
  await service.settleRead(old, 5n);
  assert.equal(row.manualTrafficUsedBytes, 20n);
  assert.equal(row.trafficPeriodKey, '2026-12');
  assert.equal(row.quotaRevision, 1);
});

test('fixed traffic counters do not reset at month boundaries and reject incomplete-object allowance', async () => {
  const { row, service } = fixture({ manualTrafficUsedBytes: 95n });
  service.now = () => new Date('2027-01-01T00:00:00Z');
  assert.equal(service.describe(row).trafficUsedBytes, '95');
  await assert.rejects(service.reserveRead(row, 6n), StorageLimitError);
  assert.equal(row.manualTrafficUsedBytes, 95n);
});

test('traffic exhaustion blocks uploads but full storage does not block reads', async () => {
  const { row, service } = fixture({ manualStorageUsedBytes: 100n });
  await service.reserveRead(row, 10n);
  await assert.rejects(service.reserveUpload(row, 1n), StorageLimitError);
  row.manualStorageUsedBytes = 0n; row.manualTrafficUsedBytes = 100n;
  await assert.rejects(service.reserveUpload(row, 1n), StorageLimitError);
});

test('space reservations include the whole incoming object and serialize concurrent uploads', async () => {
  const { row, service } = fixture({ manualStorageUsedBytes: 20n, trafficLimitEnabled: false });
  const results = await Promise.allSettled([service.reserveUpload(row, 60n), service.reserveUpload(row, 60n)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(row.trackedStorageBytes, 60n);
});

test('provider-reported uploads are not added twice to tracked space', async () => {
  const { row, service } = fixture({ manualStorageUsedBytes: null, storageBaselineBytes: null, trafficLimitEnabled: false });
  let reported = 0;
  service.registry.adapter = () => ({ getUsage: async () => ({ storageUsedBytes: reported, storageQuotaBytes: 100 }) });
  await service.reserveUpload(row, 60n);
  reported = 60;
  await service.reserveUpload(row, 1n);
  assert.equal(row.trackedStorageBytes, 61n);
});

test('provider baseline protects old objects while a stale platform measurement catches up', async () => {
  const { row, service } = fixture({ manualStorageUsedBytes: null, storageBaselineBytes: null, trafficLimitEnabled: false });
  service.registry.adapter = () => ({ getUsage: async () => ({ storageUsedBytes: 30, storageQuotaBytes: 100 }) });
  await service.reserveUpload(row, 50n);
  await assert.rejects(service.reserveUpload(row, 21n), StorageLimitError);
  assert.equal(row.trackedStorageBytes, 50n);
});

test('disabled limits permit traffic and storage above the configured budgets without clearing counters', async () => {
  const { row, service } = fixture({ storageLimitEnabled: false, trafficLimitEnabled: false,
    manualStorageUsedBytes: 1000n, manualTrafficUsedBytes: 1000n });
  await service.reserveRead(row, 500n);
  await service.reserveUpload(row, 500n);
  assert.equal(row.manualTrafficUsedBytes, 1000n);
  assert.equal(service.describe(row).trafficExhausted, false);
});

test('disabled cloud is rejected by both direct read and specific-upload admission', async () => {
  const { row, service } = fixture({ enabled: false });
  await assert.rejects(service.reserveRead(row, 1n), StorageLimitError);
  await assert.rejects(service.reserveUpload(row, 1n), StorageLimitError);
});

test('unknown-size streams are bounded by the reserved remaining balance', async () => {
  const { row, service } = fixture({ manualTrafficUsedBytes: 95n });
  const ticket = await service.reserveRead(row);
  const received = [];
  await assert.rejects(service.consumeRead(ticket, Readable.from([Buffer.from('123456789')]), async stream => {
    for await (const chunk of stream) received.push(chunk);
  }), StorageLimitError);
  assert.ok(Buffer.concat(received).length <= 5);
  assert.equal(row.manualTrafficUsedBytes, 100n);
});

test('disabled monthly counter is preserved for display across the month boundary', () => {
  const { row, service } = fixture({ trafficLimitEnabled: false, trafficQuotaMode: 'MONTHLY', trafficPeriodKey: '2026-10', manualTrafficUsedBytes: 72n });
  service.now = () => new Date('2026-11-14T00:00:00Z');
  assert.equal(service.describe(row).trafficUsedBytes, '72');
});

test('non-replica downloads and specific uploads cannot bypass exhausted or disabled cloud admission', async () => {
  const { StorageService } = require('../../apps/api/src/storage/storage.service.ts');
  const { row, db, service: limits } = fixture({ manualTrafficUsedBytes: 100n });
  let uploads = 0, reads = 0;
  const storage = new StorageService({ get: () => undefined }, db, { adapter: () => ({
    upload: async () => { uploads++; return { storageKey: 'key' }; },
    getDownloadTarget: async () => { reads++; return { type: 'stream', stream: Readable.from([Buffer.from('abc')]) }; },
  }) }, undefined, limits);
  await assert.rejects(storage.getDownloadTarget({ projectId: 'p', storageKey: 'key', size: 3n, cdnConfig: row }), StorageLimitError);
  await assert.rejects(storage.uploadToConfig(row.id, { key: 'key', buffer: Buffer.from('abc') }), StorageLimitError);
  row.trafficLimitEnabled = false; row.enabled = false;
  await assert.rejects(storage.uploadToConfig(row.id, { key: 'key', buffer: Buffer.from('abc') }), StorageLimitError);
  assert.equal(uploads, 0); assert.equal(reads, 0);
});

test('failed upstream stream deducts its delivered prefix before refunding unread bytes', async () => {
  const { row, service } = fixture();
  const ticket = await service.reserveRead(row, 50n);
  async function* input() { yield Buffer.from('seven!!'); throw new Error('network broke'); }
  await assert.rejects(service.consumeRead(ticket, Readable.from(input()), async stream => {
    for await (const _chunk of stream) { /* consume the delivered prefix */ }
  }), /network broke/);
  assert.equal(row.manualTrafficUsedBytes, 7n);
});

test('an unknown-size adapter object cannot be accepted as a quota-truncated valid object', async () => {
  const { ReplicaService } = require('../../apps/api/src/storage/replica.service.ts');
  const { row, db, service: limits } = fixture({ manualTrafficUsedBytes: 95n });
  const reader = new ReplicaService({ get: () => undefined }, db, { adapter: () => ({
    getDownloadTarget: async (_config, _key, range) => ({ type: 'stream',
      stream: Readable.from([Buffer.from(range ? '12345' : '123456789')]), contentLength: range ? 5 : 9 }),
  }) }, limits);
  await assert.rejects(reader.readVerified(row, 'key'), StorageLimitError);
});

test('unknown-size signed HTTP read rejects partial response when Content-Range total exceeds its allowance', async t => {
  const { ReplicaService } = require('../../apps/api/src/storage/replica.service.ts');
  const { row, db, service: limits } = fixture({ manualTrafficUsedBytes: 95n });
  t.mock.method(global, 'fetch', async () => new Response('12345', { status: 206, headers: { 'Content-Range': 'bytes 0-4/9' } }));
  const reader = new ReplicaService({ get: () => undefined }, db, { adapter: () => ({ getDownloadUrl: async () => 'http://unit.invalid/object' }) }, limits);
  await assert.rejects(reader.readVerified(row, 'key'), StorageLimitError);
  assert.equal(row.manualTrafficUsedBytes, 95n);
});

test('failed pre-write uploads release proven-absent space so repeated retry can succeed', async () => {
  const { StorageService } = require('../../apps/api/src/storage/storage.service.ts');
  const f = fixture({ trafficLimitEnabled: false }); let stored = false, fail = true;
  const registry = { adapter: () => ({
    upload: async (_c, params) => { if (fail) throw new Error('before write'); stored = true; return { storageKey: params.key }; },
    objectExists: async () => stored,
    getDownloadTarget: async () => ({ type: 'stream', stream: Readable.from([Buffer.alloc(40)]) }),
  }) };
  f.service.registry = registry;
  const storage = new StorageService({ get: () => undefined }, f.db, registry, undefined, f.service);
  for (let i = 0; i < 3; i++) await assert.rejects(storage.uploadToConfig('cloud', { key: 'key', buffer: Buffer.alloc(40) }), /before write/);
  assert.equal(f.row.trackedStorageBytes, 0n); assert.equal(f.ledger.length, 0);
  fail = false;
  await storage.uploadToConfig('cloud', { key: 'key', buffer: Buffer.alloc(40) });
  await storage.uploadToConfig('cloud', { key: 'key', buffer: Buffer.alloc(40) });
  assert.equal(f.row.trackedStorageBytes, 40n); assert.equal(f.ledger.length, 1);
});

test('ambiguous same-key retries reuse one space reservation and an old writer cannot release a successor', async () => {
  const f = fixture({ trafficLimitEnabled: false });
  const first = await f.service.reserveUpload(f.row, 60n, 'same-key');
  await assert.rejects(f.service.reserveUpload(f.row, 60n, 'same-key'), StorageLimitError);
  await f.service.finishUpload(first, 'UNKNOWN');
  const second = await f.service.reserveUpload(f.row, 60n, 'same-key');
  assert.equal(f.row.trackedStorageBytes, 60n);
  await f.service.finishUpload(first, 'ABSENT');
  assert.equal(f.row.trackedStorageBytes, 60n); assert.equal(f.ledger[0].owner, second.space.owner);
  await f.service.finishUpload(second, 'ABSENT');
  assert.equal(f.row.trackedStorageBytes, 0n);
});

test('traffic-only revision changes keep a key accounted once and permit safe absence release', async () => {
  const f = fixture({ trafficLimitEnabled: false });
  const first = await f.service.reserveUpload(f.row, 40n, 'revision-key');
  await f.service.finishUpload(first, 'UNKNOWN');
  f.row.quotaRevision++;
  const retry = await f.service.reserveUpload(f.row, 40n, 'revision-key');
  assert.equal(f.row.trackedStorageBytes, 40n);
  f.row.quotaRevision++;
  await f.service.finishUpload(retry, 'ABSENT');
  assert.equal(f.row.trackedStorageBytes, 0n);
});

test('manual baseline reset invalidates an old space settlement without clearing a new reservation', async () => {
  const f = fixture({ trafficLimitEnabled: false });
  const old = await f.service.reserveUpload(f.row, 40n, 'reset-key');
  f.row.quotaRevision++; f.row.trackedStorageBytes = 0n; f.ledger.length = 0;
  const fresh = await f.service.reserveUpload(f.row, 40n, 'reset-key');
  await f.service.finishUpload(old, 'ABSENT');
  assert.equal(f.row.trackedStorageBytes, 40n); assert.equal(f.ledger[0].owner, fresh.space.owner);
});

test('expired writer lease is reusable but its late failure cannot clear the replacement', async () => {
  const f = fixture({ trafficLimitEnabled: false });
  f.service.now = () => new Date('2026-11-14T00:00:00Z');
  const old = await f.service.reserveUpload(f.row, 40n, 'lease-key');
  f.service.now = () => new Date('2026-11-14T00:26:00Z');
  const fresh = await f.service.reserveUpload(f.row, 40n, 'lease-key');
  await f.service.finishUpload(old, 'ABSENT');
  assert.equal(f.row.trackedStorageBytes, 40n); assert.equal(f.ledger[0].owner, fresh.space.owner);
});
