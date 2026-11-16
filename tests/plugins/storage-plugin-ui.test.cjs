const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
require('ts-node').register({ project: path.resolve(__dirname, '../../apps/api/tsconfig.json'), transpileOnly: true, moduleTypes: { '**/apps/web/**/*.ts': 'cjs' } });

test('download audit accepts installed third-party provider identities', () => {
  const { auditDownloadSource } = require('../../apps/web/src/utils/audit-download-view.ts');
  const selected = { configId: 'r2-1', configName: 'R2 archives', provider: 'CLOUDFLARE_R2' };
  assert.deepEqual(auditDownloadSource({ storageSource: { strategy: 'CLOUD_PRIORITY', selected, attempts: [{ ...selected, outcome: 'SELECTED' }] } }),
    { strategy: 'CLOUD_PRIORITY', selected, attempts: [{ ...selected, outcome: 'SELECTED' }] });
  assert.equal(auditDownloadSource({ storageSource: { strategy: 'CLOUD_PRIORITY', selected: { ...selected, provider: '' }, attempts: [] } }), null);
});

test('schema form preserves false and zero defaults and excludes masked credentials on edit', () => {
  const { buildPluginConfigValues, collectPluginConfigValues } = require('../../apps/web/src/utils/storage-plugin-form.ts');
  const fields = [
    { key: 'token', label: 'Token', type: 'string', secret: true, required: true },
    { key: 'port', label: 'Port', type: 'number', default: 0, required: true },
    { key: 'tls', label: 'TLS', type: 'boolean', default: false, required: true },
    { key: 'mode', label: 'Mode', type: 'select', options: [{ label: 'Private', value: 'private' }], default: 'private' },
  ];
  const values = buildPluginConfigValues(fields, { token: '******' });
  assert.deepEqual(values, { token: '******', port: 0, tls: false, mode: 'private' });
  assert.deepEqual(collectPluginConfigValues(fields, values, true), { port: 0, tls: false, mode: 'private' });
  assert.throws(() => collectPluginConfigValues(fields, values, false), /Token/);
  assert.throws(() => collectPluginConfigValues(fields, { ...values, mode: 'invalid' }, true), /Mode/);
  assert.throws(() => collectPluginConfigValues(fields, { ...values, port: Infinity }, true), /Port/);
});

test('schema form rejects blank required fields and invalid URLs before submitting a draft', () => {
  const { collectPluginConfigValues } = require('../../apps/web/src/utils/storage-plugin-form.ts');
  const fields = [{ key: 'bucket', label: 'Bucket', type: 'string', required: true }, { key: 'endpoint', label: 'Endpoint', type: 'string', url: true }];
  assert.throws(() => collectPluginConfigValues(fields, { bucket: '  ' }, false), /Bucket/);
  assert.throws(() => collectPluginConfigValues(fields, { bucket: 'a', endpoint: 'javascript:alert(1)' }, false), /Endpoint/);
  assert.deepEqual(collectPluginConfigValues(fields, { bucket: ' a ', endpoint: '' }, false), { bucket: 'a', endpoint: '' });
});
