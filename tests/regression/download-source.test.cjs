const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
require('ts-node').register({ project: path.resolve(__dirname, '../../apps/api/tsconfig.json'), transpileOnly: true });
const { writeDownloadStorageHeader, downloadStorageMessage } = require('../../apps/api/src/storage/download-source.util.ts');

test('long source names and many failures cannot exceed the proxy header budget', () => {
  const selected = { configId: 'local', configName: '本地安全副本'.repeat(20), provider: 'LOCAL' };
  const attempts = Array.from({ length: 8 }, (_, i) => ({ configId: 'cloud-' + i, configName: '云存储平台'.repeat(25), provider: 'S3', outcome: 'FAILED', reason: '对象 SHA256 校验失败。' }));
  attempts.push({ ...selected, outcome: 'SELECTED' });
  let header;
  writeDownloadStorageHeader({ setHeader(name, value) { assert.equal(name, 'X-UFM-Download-Storage'); header = value; } }, { strategy: 'CLOUD_PRIORITY', selected, attempts });
  assert.ok(Buffer.byteLength(header) <= 3072, 'header must leave space for normal headers');
  const source = JSON.parse(decodeURIComponent(header));
  assert.deepEqual(source.selected, selected);
  assert.ok(source.omittedAttempts > 0);
  assert.equal(source.attempts.length + source.omittedAttempts, attempts.length);
});

test('readable history distinguishes actual LOCAL fallback from failed cloud platform', () => {
  const message = downloadStorageMessage({ strategy: 'CLOUD_PRIORITY', selected: { configId: 'l', configName: '安全副本', provider: 'LOCAL' }, attempts: [
    { configId: 'q', configName: '七牛主存储', provider: 'QINIU', outcome: 'FAILED', reason: '对象 SHA256 校验失败。' },
    { configId: 'l', configName: '安全副本', provider: 'LOCAL', outcome: 'SELECTED' },
  ] });
  assert.match(message, /下载存储：安全副本（LOCAL）/);
  assert.match(message, /七牛主存储（QINIU）：对象 SHA256 校验失败/);
});
