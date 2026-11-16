const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
require('ts-node').register({ project: path.resolve(__dirname, '../../apps/api/tsconfig.json'), transpileOnly: true });
const { StorageMigrationWorker } = require('../../apps/api/src/tasks/storage-migration.worker.ts');

// DB-boundary fixture: execute the worker's real selection, claim and progress logic.
function matches(row, where = {}) {
  return Object.entries(where).every(([key, value]) => {
    if (value === undefined) return true;
    if (key === 'OR') return value.some(branch => matches(row, branch));
    if (key === 'AND') return value.every(branch => matches(row, branch));
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      return Object.entries(value).every(([op, expected]) => {
        if (op === 'lt') return row[key] !== null && row[key] < expected;
        if (op === 'gt') return row[key] !== null && row[key] > expected;
        if (op === 'in') return expected.includes(row[key]);
        if (op === 'not') return row[key] !== expected;
        throw new Error(`Unsupported fixture predicate: ${op}`);
      });
    }
    return row[key] === value;
  });
}

function fixture({ fileCount = 1, status = 'RUNNING', leaseOwner = null, leaseUntil = null, retry = false } = {}) {
  const row = { id: 'migration-task', projectId: 'project', type: 'STORAGE_MIGRATION', status,
    createdAt: new Date('2026-11-13T00:00:00Z'), progress: 0, leaseOwner, leaseUntil,
    detail: { sourceConfigId: 'source', targetConfigId: 'target', batchSize: 1, cursor: '', scanned: 0,
      migrated: 0, skipped: 0, failed: 0, failures: [], ...(retry ? { retryFileIds: ['file-1', 'file-2'], retryIndex: 0, total: 2 } : {}) },
    finishedAt: null, error: null };
  const files = Array.from({ length: fileCount }, (_, i) => ({ id: `file-${i + 1}`, projectId: 'project',
    cdnConfigId: 'source', cdnConfig: { id: 'source', provider: 'LOCAL' }, deletedAt: null,
    storageKey: `fixture/${i + 1}.txt`, mimeType: 'text/plain', originalName: `${i + 1}.txt`, size: 4n }));
  const copies = [], writes = [];
  const hooks = { beforeClaim: null, beforeFileCheck: null, duringCopy: null };
  let claimed = false;
  const db = {
    task: {
      findFirst: async ({ where }) => matches(row, where) ? structuredClone(row) : null,
      findUnique: async ({ select }) => {
        if (select && hooks.beforeFileCheck) { const hook = hooks.beforeFileCheck; hooks.beforeFileCheck = null; hook(row); }
        return structuredClone(row);
      },
      updateMany: async ({ where, data }) => {
        if (data.leaseOwner && hooks.beforeClaim) { const hook = hooks.beforeClaim; hooks.beforeClaim = null; hook(row); }
        const count = matches(row, where) ? 1 : 0;
        writes.push({ where: structuredClone(where), data: structuredClone(data), count });
        if (count) { Object.assign(row, structuredClone(data)); if (data.leaseOwner) claimed = true; }
        return { count };
      },
    },
    managedFile: {
      findMany: async ({ where, take }) => files.filter(file => matches(file, where)).sort((a, b) => a.id.localeCompare(b.id)).slice(0, take).map(file => structuredClone(file)),
      count: async ({ where }) => files.filter(file => matches(file, where)).length,
      updateMany: async ({ where, data }) => { const found = files.filter(file => matches(file, where)); for (const file of found) Object.assign(file, data); return { count: found.length }; },
    },
  };
  const storage = { copyToConfig: async (file, target) => {
    copies.push({ id: file.id, target });
    if (hooks.duringCopy) { const hook = hooks.duringCopy; hooks.duringCopy = null; hook(row); }
    return { cdnConfigId: target, storageKey: file.storageKey, publicUrl: null };
  } };
  return { row, files, copies, writes, hooks, worker: new StorageMigrationWorker(db, storage), db, storage, wasClaimed: () => claimed };
}

test('a migrated file is followed immediately by completion on the next batch despite the renewed own lease', async () => {
  const f = fixture();
  await f.worker.runOneBatch();
  assert.equal(f.row.status, 'RUNNING');
  assert.equal(f.row.progress, 99);
  assert.ok(f.row.leaseUntil > new Date(), 'progress renews an effective lease');
  const owner = f.row.leaseOwner;
  await f.worker.runOneBatch();
  assert.equal(f.row.status, 'COMPLETED', 'the owner must resume its own lease without waiting five minutes');
  assert.equal(f.row.progress, 100);
  assert.equal(f.row.detail.migrated, 1);
  assert.deepEqual(f.copies, [{ id: 'file-1', target: 'target' }]);
  assert.ok(owner);
  assert.equal(f.row.leaseOwner, null);
  assert.equal(f.row.leaseUntil, null);
});

test('two retry batches continue under the same owner and finish without lease expiry', async () => {
  const f = fixture({ fileCount: 2, retry: true });
  await f.worker.runOneBatch();
  const owner = f.row.leaseOwner;
  assert.equal(f.row.detail.retryIndex, 1);
  await f.worker.runOneBatch();
  assert.equal(f.row.status, 'COMPLETED');
  assert.equal(f.row.detail.retryIndex, 2);
  assert.equal(f.row.detail.migrated, 2);
  assert.deepEqual(f.copies.map(copy => copy.id), ['file-1', 'file-2']);
  assert.equal(f.writes.filter(write => write.data.leaseOwner === owner && write.count === 1).length, 2);
});

test('another worker cannot pick a task protected by a live lease', async () => {
  const f = fixture({ leaseOwner: 'another-worker', leaseUntil: new Date(Date.now() + 300_000) });
  await f.worker.runOneBatch();
  assert.equal(f.wasClaimed(), false);
  assert.deepEqual(f.copies, []);
  assert.equal(f.row.leaseOwner, 'another-worker');
});

test('an expired lease can be taken over and then completed by its new owner', async () => {
  const f = fixture({ leaseOwner: 'expired-worker', leaseUntil: new Date(Date.now() - 1_000) });
  await f.worker.runOneBatch();
  assert.notEqual(f.row.leaseOwner, 'expired-worker');
  assert.equal(f.row.detail.migrated, 1);
  await f.worker.runOneBatch();
  assert.equal(f.row.status, 'COMPLETED');
});

test('claim CAS cannot steal a live lease acquired after candidate selection', async () => {
  const f = fixture();
  f.hooks.beforeClaim = row => { row.leaseOwner = 'race-winner'; row.leaseUntil = new Date(Date.now() + 300_000); };
  await f.worker.runOneBatch();
  assert.equal(f.wasClaimed(), false);
  assert.deepEqual(f.copies, []);
  assert.equal(f.row.leaseOwner, 'race-winner');
  assert.equal(f.writes[0].count, 0);
});

for (const status of ['PAUSED', 'CANCELED']) {
  test(`${status} tasks are not claimed or resumed even with an own lease`, async () => {
    const f = fixture();
    await f.worker.runOneBatch();
    const before = structuredClone(f.row.detail);
    f.row.status = status;
    await f.worker.runOneBatch();
    assert.equal(f.row.status, status);
    assert.deepEqual(f.row.detail, before);
    assert.equal(f.copies.length, 1);
  });

  test(`${status} arriving between selection and claim makes the CAS fail`, async () => {
    const f = fixture();
    f.hooks.beforeClaim = row => { row.status = status; row.leaseOwner = null; row.leaseUntil = null; };
    await f.worker.runOneBatch();
    assert.equal(f.wasClaimed(), false);
    assert.equal(f.row.status, status);
    assert.deepEqual(f.copies, []);
  });

  test(`${status} before processing a file stops copying`, async () => {
    const f = fixture();
    f.hooks.beforeFileCheck = row => { row.status = status; row.leaseOwner = null; row.leaseUntil = null; };
    await f.worker.runOneBatch();
    assert.equal(f.row.status, status);
    assert.deepEqual(f.copies, []);
    assert.equal(f.row.detail.scanned, 0);
  });

  test(`${status} during an in-flight copy cannot be overwritten by progress or finish`, async () => {
    const f = fixture({ fileCount: 2, retry: true });
    f.hooks.duringCopy = row => { row.status = status; row.leaseOwner = null; row.leaseUntil = null; };
    await f.worker.runOneBatch();
    assert.equal(f.row.status, status);
    assert.equal(f.row.progress, 0);
    assert.equal(f.row.detail.scanned, 0);
    assert.equal(f.row.leaseOwner, null);
    assert.equal(f.copies.length, 1, 'already started copy may finish, but the next file must not run');
  });
}

test('ownership lost before processing a file cannot continue or overwrite task progress', async () => {
  const f = fixture();
  f.hooks.beforeFileCheck = row => { row.leaseOwner = 'new-owner'; row.leaseUntil = new Date(Date.now() + 300_000); };
  await f.worker.runOneBatch();
  assert.deepEqual(f.copies, []);
  assert.equal(f.row.detail.scanned, 0);
  assert.equal(f.row.leaseOwner, 'new-owner');
});
