const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
require('ts-node').register({ project: path.resolve(__dirname, '../../apps/api/tsconfig.json'), transpileOnly: true });
const { ProjectsService } = require('../../apps/api/src/projects/projects.service.ts');
const user = { id: 'admin', role: 'SUPER_ADMIN' };
const config = (id, provider, priority, enabled = true) => ({ id, name: id, provider, priority, enabled, projectId: null, createdAt: new Date(0), config: { secret: 'private-cloud-value' } });

function fixture(bound) {
  const local = config('local-fallback', 'LOCAL', 1);
  const project = { id: 'p', name: 'Project', description: null, appId: 'app', appSecretVault: 'private-project-value', allowedDomains: [], enabled: true, createdAt: new Date(0), updatedAt: new Date(0), _count: { files: 2 }, storageBindings: bound.map(c => ({ projectId: 'p', configId: c.id, config: c })) };
  let reads = 0;
  const assertQuery = args => {
    assert.equal(args.where.deletedAt, null);
    assert.deepEqual(args.include._count.select.files.where, { status: 'ACTIVE', deletedAt: null });
    assert.ok(args.include.storageBindings, 'binding relation must be fetched');
  };
  const db = {
    project: { findMany: async args => { assertQuery(args); return [project]; }, findFirst: async args => { assertQuery(args); assert.equal(args.where.id, 'p'); return project; }, update: async () => assert.fail('read must not update project') },
    cdnConfig: { findFirst: async args => { reads++; assert.deepEqual(args.where, { provider: 'LOCAL', projectId: null, enabled: true }); return local; }, update: async () => assert.fail('read must not modify local configuration') },
    projectStorageBinding: { upsert: async () => assert.fail('read must not assign fallback') },
  };
  const service = new ProjectsService({}, { get: () => undefined }, {}, { assertProjectAccess: async () => {} }, db);
  return { service, reads: () => reads };
}

test('project list includes all enabled and disabled bindings with local fallback and only safe fields', async () => {
  const { service } = fixture([config('z', 'UPYUN', 10), config('a', 'QINIU', 10, false)]);
  const [result] = await service.list({}, user);
  assert.deepEqual(result.storages, [
    { id: 'a', name: 'a', provider: 'QINIU', enabled: false, priority: 10 },
    { id: 'z', name: 'z', provider: 'UPYUN', enabled: true, priority: 10 },
    { id: 'local-fallback', name: 'local-fallback', provider: 'LOCAL', enabled: true, priority: 1 },
  ]);
  assert.equal(result.fileCount, 2);
  assert.ok(!JSON.stringify(result).includes('private'));
});

test('project detail does not replace bound enabled local safety copy with a fallback', async () => {
  const { service, reads } = fixture([config('local-bound', 'LOCAL', 20), config('cloud', 'UPYUN', 1)]);
  const result = await service.get('p', user);
  assert.deepEqual(result.storages.map(c => c.id), ['cloud', 'local-bound']);
  assert.equal(reads(), 0, 'existing enabled LOCAL binding needs no fallback lookup');
});

test('disabled local remains visible alongside safe enabled fallback without read side effects', async () => {
  const { service } = fixture([config('local-disabled', 'LOCAL', 1, false)]);
  const result = await service.get('p', user);
  assert.deepEqual(result.storages.map(c => [c.id, c.enabled]), [['local-disabled', false], ['local-fallback', true]]);
});

test('legacy project-owned local binding does not suppress the enabled global safety fallback', async () => {
  const legacy = { ...config('legacy-local', 'LOCAL', 1), projectId: 'p' };
  const { service } = fixture([legacy]);
  const result = await service.get('p', user);
  assert.deepEqual(result.storages.map(c => c.id), ['legacy-local', 'local-fallback']);
});

test('project update response keeps binding summaries and active-only file counts', async () => {
  const local = config('local-bound', 'LOCAL', 20);
  const project = { id: 'p', name: 'Project', description: null, appId: 'app', enabled: true,
    createdAt: new Date(0), updatedAt: new Date(0), storageBindings: [{ config: local }], _count: { files: 2 } };
  const db = {
    project: {
      findFirst: async () => ({ webdavEnabled: false, webdavUsername: null, webdavPasswordHash: null }),
      update: async args => {
        assert.ok(args.include.storageBindings);
        assert.deepEqual(args.include._count.select.files.where, { status: 'ACTIVE', deletedAt: null });
        return project;
      },
    },
  };
  const service = new ProjectsService({ write: async () => {} }, {}, {}, { assertProjectAccess: async () => {} }, db);
  const result = await service.update('p', {}, user);
  assert.deepEqual(result.storages, [{ id: 'local-bound', name: 'local-bound', provider: 'LOCAL', enabled: true, priority: 20 }]);
});
