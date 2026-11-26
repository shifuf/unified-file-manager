const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
require('ts-node').register({ project: path.resolve(__dirname, '../../apps/api/tsconfig.json'), transpileOnly: true });

function matches(row, where = {}) {
  return Object.entries(where).every(([key, value]) => {
    if (value === undefined) return true;
    if (key === 'OR') return value.some(branch => matches(row, branch));
    if (key === 'AND') return value.every(branch => matches(row, branch));
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      return Object.entries(value).every(([op, expected]) => {
        if (op === 'lt') return row[key] != null && row[key] < expected;
        if (op === 'gt') return row[key] != null && row[key] > expected;
        if (op === 'in') return expected.includes(row[key]);
        throw new Error(`Unsupported fixture predicate: ${op}`);
      });
    }
    return row[key] === value;
  });
}

function fixture(options = {}) {
  const { FilePurgeWorker } = require('../../apps/api/src/tasks/file-purge.worker.ts');
  const files = (options.files ?? ['a', 'b'].map(id => ({ id, projectId: 'project', status: 'RECYCLED', storageKey: `key-${id}`, currentVersion: 2, originalName: `${id}.txt` }))).map(file => structuredClone(file));
  const row = { id: 'task', type: 'FILE_BATCH_PURGE', projectId: 'project', status: 'RUNNING', progress: 0,
    leaseOwner: null, leaseUntil: null, finishedAt: null, error: null, createdAt: new Date(),
    detail: { fileIds: ['a', 'b'], actorId: 'admin', nextIndex: 0, deleted: 0, alreadyAbsent: 0, failures: [], failedFileIds: [], batchSize: 1 }, ...options.task };
  const deletedObjects = new Set(), audit = [], events = [], calls = [], accessChecks = [];
  const hooks = { beforeClaim: null, duringRemove: null, duringFinish: null, denyProject: false, disabledActor: false, failIds: new Set() };
  const db = {
    task: {
      findFirst: async ({ where }) => matches(row, where) ? structuredClone(row) : null,
      findUnique: async () => structuredClone(row),
      updateMany: async ({ where, data }) => {
        if (data.leaseOwner && hooks.beforeClaim) { const hook = hooks.beforeClaim; hooks.beforeClaim = null; hook(row); }
        if (!matches(row, where)) return { count: 0 };
        Object.assign(row, structuredClone(data));
        return { count: 1 };
      },
    },
    user: { findUnique: async () => ({ id: 'admin', username: 'admin', displayName: 'Admin', role: 'SUPER_ADMIN', totpEnabled: false, enabled: !hooks.disabledActor }) },
    managedFile: { findUnique: async ({ where }) => structuredClone(files.find(file => file.id === where.id) ?? null) },
  };
  const storage = {
    removeFileObjects: async (id, options) => {
      calls.push(id);
      const file = files.find(file => file.id === id);
      assert.deepEqual(options.expectedHead, { id, projectId: 'project', storageKey: file.storageKey, currentVersion: 2 });
      assert.equal(options.allowActive, undefined);
      if (hooks.duringRemove) { const hook = hooks.duringRemove; hooks.duringRemove = null; await hook(row); }
      if (hooks.failIds.has(id)) throw new Error(`provider refused ${id}`);
      deletedObjects.add(file.storageKey);
      return [file.storageKey];
    },
    finishFileDeletion: async (expected, keys) => {
      assert.equal(deletedObjects.has(expected.storageKey), true, 'metadata cannot disappear before bytes are deleted');
      assert.deepEqual(keys, [expected.storageKey]);
      if (hooks.duringFinish) { const hook = hooks.duringFinish; hooks.duringFinish = null; await hook(row); }
      const index = files.findIndex(file => file.id === expected.id);
      if (index >= 0) files.splice(index, 1);
    },
  };
  const access = { assertProjectAccess: async (user, projectId, requireAdmin) => {
    accessChecks.push({ user: user.id, projectId, requireAdmin });
    if (hooks.denyProject) throw new Error('project disabled');
  } };
  const worker = new FilePurgeWorker(db, storage, { write: async log => audit.push(log) }, access, { emit: (event, payload) => events.push({ event, payload }) });
  return { worker, row, files, deletedObjects, calls, audit, events, hooks, accessChecks, db, storage, access };
}

test('purge worker deletes storage before records, persists batch checkpoints and audits actual deletion', async () => {
  const f = fixture();
  await f.worker.runOneBatch();
  assert.deepEqual(f.files.map(file => file.id), ['b']);
  assert.equal(f.row.status, 'RUNNING');
  assert.equal(f.row.detail.nextIndex, 1);
  assert.equal(f.row.detail.deleted, 1);
  assert.equal(f.row.progress, 50);
  await f.worker.runOneBatch();
  assert.deepEqual(f.files, []);
  assert.equal(f.row.status, 'COMPLETED');
  assert.equal(f.row.progress, 100);
  assert.equal(f.row.detail.deleted, 2);
  assert.equal(f.audit.length, 2);
  assert.ok(f.audit.every(log => log.action === 'FILE_PURGE' && log.actorId === 'admin' && log.projectId === 'project' && log.detail.storageRemoved));
  assert.deepEqual(f.events.map(event => event.event), ['file.purged', 'file.purged']);
  assert.equal(f.accessChecks.length, 2);
  assert.equal(f.row.leaseOwner, null);
});

test('provider failure retains file and failure IDs rather than completing with success', async () => {
  const f = fixture();
  f.hooks.failIds.add('a');
  await f.worker.runOneBatch();
  assert.equal(f.row.detail.nextIndex, 1);
  assert.deepEqual(f.row.detail.failedFileIds, ['a']);
  assert.match(f.row.detail.failures[0].error, /provider refused a/);
  await f.worker.runOneBatch();
  assert.equal(f.row.status, 'FAILED');
  assert.match(f.row.error, /1.*失败/);
  assert.deepEqual(f.files.map(file => file.id), ['a']);
  assert.equal(f.row.result.failed, 1);
  assert.equal(f.row.result.deleted, 1);
  assert.equal(f.audit.length, 1);
});

test('retrying an actual failed deletion executes the failed object and eventually removes the retained file', async () => {
  const f = fixture({ task: { title: 'purge files', detail: { fileIds: ['a', 'b'], actorId: 'admin', batchSize: 10 } } });
  f.hooks.failIds.add('a');
  await f.worker.runOneBatch();
  assert.equal(f.row.status, 'FAILED');
  assert.deepEqual(f.files.map(file => file.id), ['a']);
  const { TasksService } = require('../../apps/api/src/tasks/tasks.service.ts');
  f.db.task.create = async ({ data }) => { Object.assign(f.row, structuredClone(data), { id: 'retry' }); return structuredClone(f.row); };
  const service = new TasksService({ write: async log => f.audit.push(log) }, f.db, f.access);
  await service.retry('task', { id: 'admin', role: 'SUPER_ADMIN' });
  assert.equal(f.row.status, 'RUNNING');
  assert.deepEqual(f.row.detail.fileIds, ['a']);
  f.hooks.failIds.clear();
  await f.worker.runOneBatch();
  assert.equal(f.row.status, 'COMPLETED');
  assert.deepEqual(f.files, []);
  assert.deepEqual(f.calls, ['a', 'b', 'a']);
});

test('restart resumes an expired lease from durable checkpoint without deleting successful IDs again', async () => {
  const f = fixture();
  await f.worker.runOneBatch();
  f.row.leaseUntil = new Date(Date.now() - 1);
  const { FilePurgeWorker } = require('../../apps/api/src/tasks/file-purge.worker.ts');
  const restarted = new FilePurgeWorker(f.db, f.storage, { write: async log => f.audit.push(log) }, f.access, { emit() {} });
  await restarted.runOneBatch();
  assert.deepEqual(f.calls, ['a', 'b']);
  assert.equal(f.row.status, 'COMPLETED');
});

test('already deleted IDs are idempotently completed without removing active or foreign-project files', async () => {
  const f = fixture({ task: { detail: { fileIds: ['missing', 'active', 'foreign'], actorId: 'admin', batchSize: 10 } }, files: [
    { id: 'active', projectId: 'project', status: 'ACTIVE' },
    { id: 'foreign', projectId: 'another-project', status: 'RECYCLED' },
  ] });
  await f.worker.runOneBatch();
  assert.deepEqual(f.calls, []);
  assert.equal(f.row.status, 'FAILED');
  assert.equal(f.row.detail.alreadyAbsent, 1);
  assert.deepEqual(f.row.detail.failedFileIds, ['active', 'foreign']);
  assert.equal(f.files.length, 2);
});

test('disabled actors or projects fail every item without storage side effects', async () => {
  for (const hook of ['disabledActor', 'denyProject']) {
    const f = fixture({ task: { detail: { fileIds: ['a'], actorId: 'admin' } } });
    f.hooks[hook] = true;
    await f.worker.runOneBatch();
    assert.equal(f.row.status, 'FAILED', hook);
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.row.detail.failedFileIds, ['a']);
  }
});

test('live competing lease and racing claim prevent all deletion', async () => {
  const f = fixture({ task: { leaseOwner: 'other', leaseUntil: new Date(Date.now() + 300_000) } });
  await f.worker.runOneBatch();
  assert.deepEqual(f.calls, []);
  f.row.leaseOwner = null;
  f.row.leaseUntil = null;
  f.hooks.beforeClaim = row => { row.leaseOwner = 'winner'; row.leaseUntil = new Date(Date.now() + 300_000); };
  await f.worker.runOneBatch();
  assert.deepEqual(f.calls, []);
  assert.equal(f.row.leaseOwner, 'winner');
});

test('cancel before storage deletion preserves file and terminal status', async () => {
  const f = fixture();
  f.hooks.beforeClaim = row => { row.status = 'CANCELED'; row.leaseOwner = null; row.leaseUntil = null; };
  await f.worker.runOneBatch();
  assert.deepEqual(f.calls, []);
  assert.equal(f.row.status, 'CANCELED');
});

test('cancel during object deletion stops record removal, progress overwrite and next file', async () => {
  const f = fixture({ task: { detail: { fileIds: ['a', 'b'], actorId: 'admin', batchSize: 10 } } });
  f.hooks.duringRemove = row => { row.status = 'CANCELED'; row.leaseOwner = null; row.leaseUntil = null; };
  await f.worker.runOneBatch();
  assert.equal(f.row.status, 'CANCELED');
  assert.deepEqual(f.calls, ['a']);
  assert.deepEqual(f.files.map(file => file.id), ['a', 'b']);
  assert.equal(f.row.progress, 0);
  assert.deepEqual(f.audit, []);
});

test('lost or expired lease during deletion cannot finish metadata or publish a completed result', async () => {
  for (const mode of ['takeover', 'expired']) {
    const f = fixture();
    f.hooks.duringRemove = row => { if (mode === 'takeover') row.leaseOwner = 'new-owner'; else row.leaseUntil = new Date(Date.now() - 1); };
    await f.worker.runOneBatch();
    assert.equal(f.row.status, 'RUNNING');
    assert.equal(f.files.length, 2);
    assert.equal(f.row.progress, 0);
  }
});

test('a running legacy purge task with no IDs fails clearly instead of completing', async () => {
  const f = fixture({ task: { detail: { actorId: 'admin' } } });
  await f.worker.runOneBatch();
  assert.equal(f.row.status, 'FAILED');
  assert.match(f.row.error, /文件清单|回收站/);
  assert.deepEqual(f.calls, []);
});
