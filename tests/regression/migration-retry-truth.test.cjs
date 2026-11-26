const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
require('ts-node').register({ project: path.resolve(__dirname, '../../apps/api/tsconfig.json'), transpileOnly: true });
const { StorageMigrationWorker } = require('../../apps/api/src/tasks/storage-migration.worker.ts');

function fixture(ids, files) {
  const row = { id: 'migration', type: 'STORAGE_MIGRATION', projectId: 'p', status: 'RUNNING', leaseOwner: null, leaseUntil: null,
    detail: { sourceConfigId: 'source', targetConfigId: 'target', cursor: '', scanned: 0, migrated: 0, failed: 0, skipped: 0, failures: [],
      retryFileIds: ids, retryIndex: 0, total: ids.length, batchSize: 1 } };
  const copies = [];
  const matches = (row, where) => Object.entries(where).every(([key, value]) => {
    if (value === undefined) return true;
    if (key === 'OR') return value.some(branch => matches(row, branch));
    if (value && typeof value === 'object' && !(value instanceof Date)) return Object.entries(value).every(([operator, expected]) => {
      if (operator === 'in') return expected.includes(row[key]);
      if (operator === 'lt') return row[key] != null && row[key] < expected;
      throw new Error(`unexpected ${operator}`);
    });
    return row[key] === value;
  });
  const db = { task: {
    findFirst: async ({ where }) => matches(row, where) ? structuredClone(row) : null,
    findUnique: async () => structuredClone(row),
    updateMany: async ({ where, data }) => { if (!matches(row, where)) return { count: 0 }; Object.assign(row, structuredClone(data)); return { count: 1 }; },
  }, managedFile: {
    findMany: async ({ where, take }) => files.filter(file => matches(file, where)).sort((a, b) => a.id.localeCompare(b.id)).slice(0, take),
    updateMany: async ({ where, data }) => { const matching = files.filter(file => matches(file, where)); matching.forEach(file => Object.assign(file, data)); return { count: matching.length }; },
  } };
  return { row, copies, worker: new StorageMigrationWorker(db, { copyToConfig: async file => { copies.push(file.id); } }) };
}
const file = id => ({ id, projectId: 'p', cdnConfigId: 'source', cdnConfig: { id: 'source' }, storageKey: `${id}.txt`, originalName: id, mimeType: 'text/plain', size: 1n });

test('a missing first retry ID does not complete migration before processing remaining file IDs', async () => {
  const f = fixture(['gone', 'remaining'], [file('remaining')]);
  await f.worker.runOneBatch();
  assert.equal(f.row.status, 'RUNNING');
  assert.equal(f.row.detail.retryIndex, 1);
  assert.equal(f.row.detail.skipped, 1);
  await f.worker.runOneBatch();
  assert.equal(f.row.status, 'COMPLETED');
  assert.deepEqual(f.copies, ['remaining']);
  assert.equal(f.row.detail.scanned, 2);
});

test('retry IDs advance in durable requested order, including absent IDs inside the batch', async () => {
  const f = fixture(['z', 'gone', 'a'], [file('a'), file('z')]);
  f.row.detail.batchSize = 2;
  await f.worker.runOneBatch();
  assert.equal(f.row.detail.retryIndex, 2);
  assert.deepEqual(f.copies, ['z']);
  await f.worker.runOneBatch();
  assert.equal(f.row.status, 'COMPLETED');
  assert.deepEqual(f.copies, ['z', 'a']);
  assert.equal(f.row.detail.skipped, 1);
});

test('migration lacking source or target fails instead of treating every item as a successful skip', async () => {
  for (const field of ['sourceConfigId', 'targetConfigId']) {
    const f = fixture(['a'], [file('a')]);
    f.row.detail[field] = '';
    await f.worker.runOneBatch();
    assert.equal(f.row.status, 'FAILED');
    assert.deepEqual(f.copies, []);
    assert.match(f.row.error, /存储配置|来源|目标/);
  }
});

test('a file still pointing at an unavailable source configuration is failed rather than skipped successfully', async () => {
  const original = file('a');
  original.cdnConfig = null;
  const f = fixture(['a'], [original]);
  await f.worker.runOneBatch();
  assert.equal(f.row.status, 'FAILED');
  assert.equal(f.row.detail.failed, 1);
  assert.equal(f.row.detail.skipped, 0);
  assert.match(f.row.detail.failures[0].error, /来源存储/);
  assert.deepEqual(f.copies, []);
});
