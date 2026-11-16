const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../..');
require('ts-node').register({ project: path.join(root, 'apps/api/tsconfig.json'), transpileOnly: true });
const { LocalStorageAdapter } = require('../../apps/api/src/storage/adapters/local.adapter.ts');
const fixtureRoot = path.join(root, '.runtime/acceptance-20261113/regression', Date.now().toString(36));
fs.mkdirSync(fixtureRoot, { recursive: true });
const adapter = new LocalStorageAdapter();
const config = { id: 'regression-local', provider: 'LOCAL', name: 'regression', config: { root: fixtureRoot } };
async function collect(target) {
  assert.equal(target.type, 'stream');
  const chunks = [];
  for await (const chunk of target.stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
test('LOCAL upload/download preserves bytes and inclusive byte range', async () => {
  const data = crypto.randomBytes(4099);
  const key = '中文目录/验收.bin';
  await adapter.upload(config, { key, buffer: data, mimeType: 'application/octet-stream' });
  assert.equal(await adapter.objectExists(config, key), true);
  assert.deepEqual(await collect(await adapter.getDownloadTarget(config, key)), data);
  assert.deepEqual(await collect(await adapter.getDownloadTarget(config, key, { start: 11, end: 42 })), data.subarray(11, 43));
});
test('LOCAL missing object raises an error rather than a successful empty download', async () => {
  await assert.rejects(adapter.getDownloadTarget(config, 'missing-object.bin'));
});
test('LOCAL directory is not a downloadable object', async () => {
  fs.mkdirSync(path.join(fixtureRoot, 'directory'), { recursive: true });
  await assert.rejects(adapter.getDownloadTarget(config, 'directory'));
});
test('LOCAL rejects paths escaping the configured root before writing', async () => {
  await assert.rejects(adapter.upload(config, { key: '../outside.bin', buffer: Buffer.from('must not write'), mimeType: 'application/octet-stream' }), /路径越界/);
});
