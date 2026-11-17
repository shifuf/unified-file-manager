const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
require('ts-node').register({ project: path.resolve(__dirname, '../../apps/api/tsconfig.json'), transpileOnly: true });
const { CdnService } = require('../../apps/api/src/cdn/cdn.service.ts');

test('backup health checks metadata, skips content reads and still deletes its probe after a failed confirmation', async () => {
  for (const fail of [false, true]) {
    const calls = [];
    const adapter = {
      upload: async () => calls.push('upload'),
      verifyBackup: async (_, params) => { calls.push('metadata'); assert.equal(params.size, 2); if (fail) throw new Error('摘要不符'); },
      getDownloadTarget: () => assert.fail('backup health must never download'),
      getDownloadUrl: () => assert.fail('backup health must never request a URL'),
      remove: async () => calls.push('delete'),
    };
    const manifest = { fields: [], capabilities: { backupOnly: true } };
    const service = new CdnService({}, { manifest: () => manifest, adapter: () => adapter }, { get: (_, value) => value }, {}, {});
    const checks = await service.testRemoteConfig('ALIYUN_DRIVE', 'backup', {});
    assert.deepEqual(calls, ['upload', 'metadata', 'delete']);
    assert.equal(checks.find(check => check.name === 'backup').status, fail ? 'FAIL' : 'PASS');
    if (!fail) assert.equal(checks.find(check => check.name === 'download').status, 'SKIP');
  }
});
