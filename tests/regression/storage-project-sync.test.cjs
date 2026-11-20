const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
require('ts-node').register({ project: path.resolve(__dirname, '../../apps/api/tsconfig.json'), transpileOnly: true });
const { ProjectAccessService } = require('../../apps/api/src/projects/project-access.service.ts');
const admin = { id: 'admin', role: 'SUPER_ADMIN' };
const status = code => error => error.getStatus?.() === code;

function fixture() {
  const config = { id: 'drive', provider: 'ALIYUN_DRIVE', enabled: true, projectId: null };
  const projects = [{ id: 'one', name: '第一项目', enabled: true, deletedAt: null }, { id: 'two', name: '第二项目', enabled: true, deletedAt: null }];
  const bindings = new Set(['one', 'two']), queued = [], events = [];
  const matchesProject = (project, where) => (!where.id || (typeof where.id === 'string' ? project.id === where.id : where.id.in.includes(project.id)))
    && (where.enabled === undefined || project.enabled === where.enabled) && (where.deletedAt === undefined || project.deletedAt === where.deletedAt);
  const prisma = {
    cdnConfig: { findFirst: async ({ where }) => { events.push('config'); return config.id === where.id && config.enabled && config.projectId === null ? config : null; } },
    project: {
      findFirst: async ({ where }) => { events.push(`access:${where.id}`); return projects.find(project => matchesProject(project, where)) ?? null; },
      findMany: async ({ where }) => { events.push('projects'); return projects.filter(project => matchesProject(project, where)); },
    },
    projectStorageBinding: { findMany: async ({ where }) => { events.push('bindings'); return [...bindings].filter(projectId => where.projectId.in.includes(projectId)).map(projectId => ({ projectId, configId: 'drive' })); } },
    $queryRaw: async () => [],
    $transaction: async callback => { events.push('transaction'); return callback(prisma); },
  };
  const manifest = { capabilities: { remoteFiles: true, backupOnly: true } };
  const adapter = { listRemoteFiles: async () => {}, readRemoteFile: async () => {} };
  const registry = { manifest: () => manifest, adapter: () => adapter };
  const replicas = { enqueueProjectSync: async (projectId, configId, client) => {
    assert.equal(client, prisma); events.push(`queue:${projectId}`);
    queued.push({ projectId, configId }); return { taskId: `task-${projectId}`, requeued: projectId === 'one' ? 4 : 2 };
  } };
  const { StorageProjectSyncService } = require('../../apps/api/src/storage/storage-project-sync.service.ts');
  const service = new StorageProjectSyncService(prisma, registry, new ProjectAccessService(prisma), replicas);
  return { service, config, projects, bindings, queued, events, prisma, registry, manifest, adapter };
}

test('project cloud sync queues each selected bound project with task IDs and requeue counts after complete preflight', async () => {
  const f = fixture();
  const result = await f.service.enqueue('drive', ['two', 'one'], admin);
  assert.deepEqual(result, { queuedProjects: 2, projects: [
    { projectId: 'two', projectName: '第二项目', taskId: 'task-two', requeued: 2 },
    { projectId: 'one', projectName: '第一项目', taskId: 'task-one', requeued: 4 },
  ] });
  assert.deepEqual(f.queued, [{ projectId: 'two', configId: 'drive' }, { projectId: 'one', configId: 'drive' }]);
  assert.ok(f.events.indexOf('bindings') < f.events.indexOf('queue:two'));
  assert.ok(f.events.indexOf('projects') < f.events.indexOf('queue:two'));
});

test('project cloud sync rejects non-admins before configuration reads or queue writes', async () => {
  const f = fixture();
  await assert.rejects(f.service.enqueue('drive', ['one'], { ...admin, role: 'PROJECT_ADMIN' }), status(403));
  assert.deepEqual(f.events, []); assert.deepEqual(f.queued, []);
});

test('project cloud sync rejects malformed target selections and config IDs before database work', async () => {
  const f = fixture();
  for (const projectIds of [undefined, [], ['one', 'one'], ['one', ''], ['one', '../two'], ['one', 12], Array.from({ length: 21 }, (_, i) => `p${i}`)]) {
    await assert.rejects(f.service.enqueue('drive', projectIds, admin), status(400));
  }
  for (const configId of ['', '../drive', 'https://drive.invalid']) await assert.rejects(f.service.enqueue(configId, ['one'], admin), status(400));
  assert.deepEqual(f.events, []); assert.deepEqual(f.queued, []);
});

test('project cloud sync requires an enabled global Aliyun Drive configuration and installed remote-files plugin', async () => {
  const scenarios = [
    f => { f.config.enabled = false; },
    f => { f.config.projectId = 'one'; },
    f => { f.config.provider = 'S3'; },
    f => { f.manifest.capabilities.remoteFiles = false; },
    f => { f.registry.adapter = () => { throw new Error('plugin missing'); }; },
    f => { delete f.adapter.listRemoteFiles; },
    f => { delete f.adapter.readRemoteFile; },
  ];
  for (const change of scenarios) {
    const f = fixture(); change(f);
    await assert.rejects(f.service.enqueue('drive', ['one'], admin), error => [400, 404].includes(error.getStatus?.()));
    assert.deepEqual(f.queued, []);
  }
});

test('every selected project must exist and be enabled before any project is queued', async () => {
  for (const change of [f => { f.projects[1].enabled = false; }, f => { f.projects[1].deletedAt = new Date(); }, f => { f.projects.pop(); }]) {
    const f = fixture(); change(f);
    await assert.rejects(f.service.enqueue('drive', ['one', 'two'], admin), status(404));
    assert.deepEqual(f.queued, []);
  }
});

test('one unbound project rejects the complete selection before queue writes', async () => {
  const f = fixture(); f.bindings.delete('two');
  await assert.rejects(f.service.enqueue('drive', ['one', 'two'], admin), status(400));
  assert.deepEqual(f.queued, []);
});

test('project cloud sync rechecks project enabled state inside the queue transaction', async () => {
  const f = fixture(), transact = f.prisma.$transaction;
  f.prisma.$transaction = callback => { f.projects[1].enabled = false; return transact(callback); };
  await assert.rejects(f.service.enqueue('drive', ['one', 'two'], admin), status(404));
  assert.deepEqual(f.queued, []);
});

test('project sync DTO accepts one to twenty unique safe project IDs', async () => {
  const { validate } = require('class-validator');
  const { plainToInstance } = require('class-transformer');
  const { StorageProjectSyncDto } = require('../../apps/api/src/storage/dto/storage-project-sync.dto.ts');
  for (const projectIds of [['one'], Array.from({ length: 20 }, (_, i) => `p${i}`)]) {
    assert.equal((await validate(plainToInstance(StorageProjectSyncDto, { projectIds }))).length, 0);
  }
  for (const projectIds of [undefined, [], ['one', 'one'], ['one', '../two'], [3], Array.from({ length: 21 }, (_, i) => `p${i}`)]) {
    assert.ok((await validate(plainToInstance(StorageProjectSyncDto, { projectIds }))).length > 0);
  }
});
