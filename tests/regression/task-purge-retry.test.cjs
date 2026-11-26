const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
require('ts-node').register({ project: path.resolve(__dirname, '../../apps/api/tsconfig.json'), transpileOnly: true });
const { TasksService } = require('../../apps/api/src/tasks/tasks.service.ts');

const admin = { id: 'admin', username: 'admin', displayName: 'Admin', role: 'SUPER_ADMIN', totpEnabled: false };
function retries(type, detail, result = null) {
  const original = { id: 'failed', projectId: 'project', type, title: 'failed operation', status: 'FAILED', detail, result, error: 'storage unavailable' };
  const rows = [original], logs = [];
  const prisma = { task: {
    findUnique: async ({ where }) => structuredClone(rows.find(row => row.id === where.id)),
    create: async ({ data }) => { const row = { id: `retry-${rows.length}`, ...structuredClone(data) }; rows.push(row); return structuredClone(row); },
  } };
  return { rows, logs, service: new TasksService({ write: async log => logs.push(log) }, prisma, { assertProjectAccess: async () => {} }) };
}

test('purge retry queues only failed IDs with a durable actor and never reports success before deleting', async () => {
  const f = retries('FILE_BATCH_PURGE', { fileIds: ['deleted', 'failed'], failedFileIds: ['failed'] });
  const result = await f.service.retry('failed', admin);
  assert.equal(result.status, 'RUNNING');
  assert.equal(result.progress, 0);
  assert.equal(result.finishedAt, null);
  assert.deepEqual(result.detail.fileIds, ['failed']);
  assert.deepEqual(result.detail.failedFileIds, []);
  assert.equal(result.detail.actorId, 'admin');
  assert.equal(result.detail.nextIndex, 0);
  assert.equal(result.result, undefined);
  assert.equal(f.logs[0].action, 'TASK_RETRY');
});

test('purge retry can recover file IDs from detailed historical failures', async () => {
  const f = retries('FILE_BATCH_PURGE', { failures: [{ fileId: 'failed', error: 'permission denied' }] });
  const result = await f.service.retry('failed', admin);
  assert.equal(result.status, 'RUNNING');
  assert.deepEqual(result.detail.fileIds, ['failed']);
});

test('retry after a batch interruption includes unprocessed IDs as well as checkpointed failures', async () => {
  const f = retries('FILE_BATCH_PURGE', { fileIds: ['failed', 'done', 'not-started'], failedFileIds: ['failed'], nextIndex: 2 });
  const result = await f.service.retry('failed', admin);
  assert.deepEqual(result.detail.fileIds, ['failed', 'not-started']);
});

test('purge retry without recoverable IDs rejects rather than generating a completed task', async () => {
  const f = retries('FILE_BATCH_PURGE', { failed: 3 });
  await assert.rejects(f.service.retry('failed', admin), /回收站|文件清单/);
  assert.equal(f.rows.length, 1);
  assert.equal(f.logs.length, 0);
});

test('unsupported task retries reject without adding fake completed records', async () => {
  for (const type of ['FILE_BATCH_COPY', 'FILE_BATCH_DELETE', 'PROJECT_IMPORT', 'PROJECT_STORAGE_PURGE']) {
    const f = retries(type, { fileIds: ['file'] });
    await assert.rejects(f.service.retry('failed', admin), /不支持|对应功能/);
    assert.equal(f.rows.length, 1, type);
  }
});

test('malformed purge task IDs and cross-projectless purge tasks cannot be scheduled', async () => {
  for (const fileIds of [[], [''], [3], ['a'.repeat(129)], 'file']) {
    const f = retries('FILE_BATCH_PURGE', { fileIds });
    await assert.rejects(f.service.retry('failed', admin));
    assert.equal(f.rows.length, 1);
  }
  const f = retries('FILE_BATCH_PURGE', { fileIds: ['file'] });
  f.rows[0].projectId = null;
  await assert.rejects(f.service.retry('failed', admin));
  assert.equal(f.rows.length, 1);
});

test('task retry availability exposes only executable failed tasks', () => {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../../apps/web/src/utils/task-view.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports });
  const { canRetryTask } = module.exports;
  assert.equal(typeof canRetryTask, 'function');
  for (const type of ['STORAGE_MIGRATION', 'STORAGE_REPLICA_SYNC']) {
    assert.equal(canRetryTask({ type, status: 'FAILED' }), true);
    assert.equal(canRetryTask({ type, status: 'RUNNING' }), false);
  }
  assert.equal(canRetryTask({ type: 'FILE_BATCH_PURGE', status: 'FAILED', projectId: 'p', detail: { fileIds: ['f'] } }), true);
  assert.equal(canRetryTask({ type: 'FILE_BATCH_PURGE', status: 'FAILED', projectId: 'p', detail: { failures: [{ fileId: 'f' }] } }), true);
  assert.equal(canRetryTask({ type: 'FILE_BATCH_PURGE', status: 'FAILED', projectId: 'p', detail: { failed: 2 } }), false);
  assert.equal(canRetryTask({ type: 'FILE_BATCH_COPY', status: 'FAILED' }), false);
});
