const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
require('ts-node').register({ project: path.resolve(__dirname, '../../apps/api/tsconfig.json'), transpileOnly: true, moduleTypes: { '**/apps/web/**/*.ts': 'cjs' } });
test('saving policy without editing usage omits counters and rounded quota values', () => {
  const { limitFormValues, storageLimitPayload } = require('../../apps/web/src/utils/storage-limit-form.ts');
  const initial = limitFormValues({ trafficQuotaBytes: '12345678901', trafficUsedBytes: '123456789', manualStorageUsedBytes: '987654321' });
  const payload = storageLimitPayload({ ...initial, trafficQuotaMode: 'MONTHLY' }, initial);
  assert.equal(payload.trafficQuotaMode, 'MONTHLY');
  assert.equal('manualTrafficUsedBytes' in payload, false); assert.equal('manualStorageUsedBytes' in payload, false);
  assert.equal('trafficQuotaBytes' in payload, false);
});
test('manual usage edit sends exact converted bytes and clear resets it', () => {
  const { limitFormValues, storageLimitPayload } = require('../../apps/web/src/utils/storage-limit-form.ts');
  const initial = limitFormValues({ trafficUsedBytes: '100' });
  assert.equal(storageLimitPayload({ ...initial, manualTrafficUsedGiB: 2 }, initial).manualTrafficUsedBytes, 2147483648);
  assert.equal(storageLimitPayload({ ...initial, manualTrafficUsedGiB: null }, initial).manualTrafficUsedBytes, null);
});
test('form shows effective monthly usage instead of the previous month stored counter', () => {
  const { limitFormValues } = require('../../apps/web/src/utils/storage-limit-form.ts');
  assert.equal(limitFormValues({ trafficUsedBytes: '0', manualTrafficUsedBytes: '1073741824' }).manualTrafficUsedGiB, 0);
});
test('form rejects unsafe, negative and non-finite byte conversions', () => {
  const { limitFormValues, storageLimitPayload } = require('../../apps/web/src/utils/storage-limit-form.ts');
  for (const value of [-1, Infinity, NaN, 100000000]) assert.throws(() => storageLimitPayload({ ...limitFormValues({}), trafficQuotaGiB: value }), /范围/);
});
test('effective space display does not count platform-reported uploads twice', () => {
  const { storageSpaceView } = require('../../apps/web/src/utils/storage-limit-form.ts');
  const config = { provider: 'QINIU', storageQuotaBytes: '100', trackedStorageBytes: '60', storageBaselineBytes: '0', failoverThresholdPercent: 90 };
  assert.deepEqual(storageSpaceView(config, { storageUsedBytes: 60 }), { used: 60, quota: 100, paused: false, unknown: false });
  assert.equal(storageSpaceView({ ...config, manualStorageUsedBytes: '40' }, { storageUsedBytes: 60 }).paused, true);
  assert.equal(storageSpaceView({ ...config, storageLimitEnabled: false, manualStorageUsedBytes: '90' }).paused, false);
});
