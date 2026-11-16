const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
require('ts-node').register({ project: path.resolve(__dirname, '../../apps/api/tsconfig.json'), transpileOnly: true });
const { plainToInstance } = require('class-transformer');
const { validateSync } = require('class-validator');
const { CreateCdnConfigDto } = require('../../apps/api/src/cdn/dto/create-cdn-config.dto.ts');
const { CdnService } = require('../../apps/api/src/cdn/cdn.service.ts');
const { StorageLimitsService } = require('../../apps/api/src/storage/storage-limits.service.ts');
const user = { id: 'admin', role: 'SUPER_ADMIN' };
function fixture(overrides = {}) {
  const row = { id: 'cloud', projectId: null, provider: 'UPYUN', name: 'cloud', config: {}, enabled: true,
    priority: 100, storageLimitEnabled: true, trafficLimitEnabled: true, trafficQuotaMode: 'FIXED',
    trafficPeriodKey: null, quotaRevision: 2, trackedStorageBytes: 12n, storageQuotaBytes: null,
    manualStorageUsedBytes: null, trafficQuotaBytes: 100n, manualTrafficUsedBytes: 40n,
    failoverThresholdPercent: 90, autoFailover: false, ...overrides };
  let locked = false, beforeLock, beforeSave;
  const db = { cdnConfig: {
    findFirst: async () => ({ ...row }),
    update: async ({ data }) => { beforeSave?.(); for (const [key, value] of Object.entries(data)) {
      if (value === undefined) continue;
      row[key] = value && typeof value === 'object' && 'increment' in value ? (row[key] ?? 0) + value.increment : value;
    } return { ...row }; },
  }, storageSpaceReservation: { deleteMany: async () => ({ count: 0 }) },
  $queryRaw: async () => { locked = true; beforeLock?.(); }, $transaction: async fn => fn(db) };
  const limits = new StorageLimitsService(db, {}, {}); limits.now = () => new Date('2026-11-14T06:00:00Z');
  const service = new CdnService({ write: async () => {} }, null, { get: () => undefined }, db, {}, undefined, limits);
  return { service, row, limits, locked: () => locked, onLock: fn => { beforeLock = fn; }, onSave: fn => { beforeSave = fn; } };
}
test('quota DTO rejects fractional, unsafe and negative byte values and invalid mode', () => {
  for (const invalid of [{ trafficQuotaBytes: 0.5 }, { manualTrafficUsedBytes: Number.MAX_SAFE_INTEGER + 1 },
    { storageQuotaBytes: -1 }, { trafficQuotaMode: 'DAILY' }, { trafficLimitEnabled: 'true' }]) {
    const dto = plainToInstance(CreateCdnConfigDto, { provider: 'UPYUN', name: 'test', config: {}, ...invalid });
    assert.ok(validateSync(dto).some(error => Object.keys(invalid).includes(error.property)), JSON.stringify(invalid));
  }
});
test('enabling traffic restriction requires a quota, while zero is an explicit exhausted budget', async () => {
  const f = fixture({ trafficLimitEnabled: false, trafficQuotaBytes: null });
  await assert.rejects(f.service.update('cloud', { trafficLimitEnabled: true }, user), /流量.*额度/);
  const result = await f.service.update('cloud', { trafficLimitEnabled: true, trafficQuotaBytes: 0 }, user);
  assert.equal(result.trafficExhausted, true);
});
test('renaming preserves live counters and does not advance their revision', async () => {
  const f = fixture();
  const result = await f.service.update('cloud', { name: 'renamed' }, user);
  assert.equal(f.row.manualTrafficUsedBytes, 40n); assert.equal(f.row.quotaRevision, 2);
  assert.equal(result.trafficRemainingBytes, '60');
});
test('switching fixed to monthly preserves live usage read under the lock', async () => {
  const f = fixture(); f.onLock(() => { f.row.manualTrafficUsedBytes = 55n; });
  const result = await f.service.update('cloud', { trafficQuotaMode: 'MONTHLY' }, user);
  assert.equal(f.locked(), true); assert.equal(f.row.manualTrafficUsedBytes, 55n);
  assert.equal(f.row.trafficPeriodKey, '2026-11'); assert.equal(result.trafficRemainingBytes, '45');
  assert.equal(f.row.quotaRevision, 3);
});
test('switching expired monthly budget to fixed uses effective current usage', async () => {
  const f = fixture({ trafficQuotaMode: 'MONTHLY', trafficPeriodKey: '2026-10', manualTrafficUsedBytes: 90n });
  const result = await f.service.update('cloud', { trafficQuotaMode: 'FIXED' }, user);
  assert.equal(result.trafficUsedBytes, '0'); assert.equal(f.row.trafficPeriodKey, null);
});
test('manual corrections establish a new revision and reset tracked space baseline', async () => {
  const f = fixture({ storageBaselineBytes: 9n });
  await f.service.update('cloud', { manualStorageUsedBytes: 80, manualTrafficUsedBytes: 5 }, user);
  assert.equal(f.row.trackedStorageBytes, 0n); assert.equal(f.row.manualTrafficUsedBytes, 5n); assert.equal(f.row.quotaRevision, 3);
  assert.equal(f.row.storageBaselineBytes, null);
});
test('quota increase and disabling preserve accrued usage', async () => {
  const f = fixture();
  await f.service.update('cloud', { trafficQuotaBytes: 200, trafficLimitEnabled: false }, user);
  assert.equal(f.row.manualTrafficUsedBytes, 40n); assert.equal(f.row.quotaRevision, 3);
});

test('unrelated saves cannot overwrite a concurrent monthly reset and reservation', async () => {
  for (const dto of [{ name: 'rename' }, { priority: 20 }, { autoFailover: true }]) {
    const f = fixture({ trafficQuotaMode: 'MONTHLY', trafficPeriodKey: '2026-10', manualTrafficUsedBytes: 90n });
    f.onSave(() => Object.assign(f.row, { trafficPeriodKey: '2026-11', manualTrafficUsedBytes: 20n, quotaRevision: 3 }));
    await f.service.update('cloud', dto, user);
    assert.equal(f.row.manualTrafficUsedBytes, 20n, JSON.stringify(dto));
    assert.equal(f.row.quotaRevision, 3);
  }
});

test('priority and automatic failover edits leave existing reservation revision valid', async () => {
  for (const dto of [{ priority: 20 }, { autoFailover: true }]) {
    const f = fixture();
    await f.service.update('cloud', dto, user);
    assert.equal(f.row.quotaRevision, 2, JSON.stringify(dto));
    assert.equal(f.row.manualTrafficUsedBytes, 40n);
  }
});

test('re-enabling expired monthly limit starts at zero unless usage is explicitly corrected', async () => {
  for (const [correction, expected] of [[undefined, 0n], [7, 7n]]) {
    const f = fixture({ trafficLimitEnabled: false, trafficQuotaMode: 'MONTHLY', trafficPeriodKey: '2026-10', manualTrafficUsedBytes: 100n });
    await f.service.update('cloud', { trafficLimitEnabled: true, ...(correction === undefined ? {} : { manualTrafficUsedBytes: correction }) }, user);
    assert.equal(f.row.manualTrafficUsedBytes, expected);
    assert.equal(f.row.trafficPeriodKey, '2026-11');
  }
});

test('disabling across month boundary preserves count and same-month re-enable retains count', async () => {
  const expired = fixture({ trafficQuotaMode: 'MONTHLY', trafficPeriodKey: '2026-10', manualTrafficUsedBytes: 90n });
  await expired.service.update('cloud', { trafficLimitEnabled: false }, user);
  assert.equal(expired.row.manualTrafficUsedBytes, 90n);
  const same = fixture({ trafficLimitEnabled: false, trafficQuotaMode: 'MONTHLY', trafficPeriodKey: '2026-11', manualTrafficUsedBytes: 27n });
  await same.service.update('cloud', { trafficLimitEnabled: true }, user);
  assert.equal(same.row.manualTrafficUsedBytes, 27n);
});
