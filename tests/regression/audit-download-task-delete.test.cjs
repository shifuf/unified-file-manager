const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
require('ts-node').register({ project: path.resolve(__dirname, '../../apps/api/tsconfig.json'), transpileOnly: true });
const { DownloadStatsService } = require('../../apps/api/src/files/download-stats.service.ts');
const { TasksService } = require('../../apps/api/src/tasks/tasks.service.ts');
const source = { strategy: 'CLOUD_PRIORITY', selected: { configId: 'local', configName: '本地安全副本', provider: 'LOCAL' }, attempts: [
  { configId: 'cloud', configName: '七牛云主存储', provider: 'QINIU', outcome: 'FAILED', reason: '对象校验失败' },
  { configId: 'local', configName: '本地安全副本', provider: 'LOCAL', outcome: 'SELECTED' },
] };

test('persisted download audit distinguishes CDN failure from origin success and drops unknown route values', async () => {
 const audits = [], selected = { configId: 'upyun', configName: 'UPYUN', provider: 'UPYUN' };
 const service = new DownloadStatsService({ auditLog: { create: async ({ data }) => audits.push(data) } });
 await service.persistAudit({ projectId: 'p', fileId: 'f', bytes: 4, source: 'PUBLIC', storageSource: {
  strategy: 'CLOUD_PRIORITY', selected, attempts: [
   { ...selected, route: 'CDN', outcome: 'FAILED', reason: 'checksum mismatch' },
   { ...selected, route: 'ORIGIN', outcome: 'SELECTED' },
   { ...selected, route: 'https://secret.example/path', outcome: 'SKIPPED' },
  ],
 } });
 assert.deepEqual(audits[0].detail.storageSource.attempts.map(item => item.route), ['CDN', 'ORIGIN', undefined]);
});

test('WebDAV HEAD and redirect GET audit the same storage as the response header', async () => {
  const { dispatchDav } = require('../../apps/api/src/webdav/webdav-verbs.ts');
  for (const method of ['HEAD', 'GET']) {
    const audits = [], headers = {};
    const statsService = new DownloadStatsService({ auditLog: { create: async ({ data }) => { audits.push(data); } } });
    statsService.persist = async () => {};
    const response = { setHeader: (name, value) => { headers[name] = value; }, status() { return this; }, end() {}, redirect() {} };
    await dispatchDav({ statsService, treeService: { stat: async () => ({ size: 4, isCollection: false }) },
      fileService: { readFile: async () => ({ file: { id: 'f', originalName: 'x.txt', mimeType: 'text/plain', updatedAt: new Date() }, redirectUrl: 'https://storage.test/x', storageSource: source }) },
    }, method, { projectId: 'p', username: 'reader' }, 'x.txt', { headers: {}, get: () => undefined }, response);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(audits.length, 1);
    assert.deepEqual(JSON.parse(decodeURIComponent(headers['X-UFM-Download-Storage'])), source);
    assert.deepEqual(audits[0].detail.storageSource, source, method);
  }
});

test('final download source is audited once for every channel, including fallback and safe DAV attribution', async () => {
  const audits = [], db = { auditLog: { create: async ({ data }) => { audits.push(data); } } };
  const service = new DownloadStatsService(db);
  service.persist = async () => {};
  for (const channel of ['ADMIN', 'OPEN_API', 'PUBLIC', 'SHARE', 'FOLDER_SHARE', 'WEBDAV', 'BATCH']) {
    service.record({ projectId: 'p', fileId: 'f', originalName: 'x.txt', bytes: 4, source: channel,
      actorId: channel === 'WEBDAV' ? 'webdav:reader' : channel === 'ADMIN' ? 'admin' : null,
      rangeStart: 2, rangeEnd: 5, storageSource: source, ip: '127.0.0.1' });
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(audits.length, 7);
  for (const log of audits) {
    assert.deepEqual(log.detail.storageSource, source);
    assert.equal(log.detail.originalName, 'x.txt');
    assert.equal(log.detail.rangeStart, 2);
    assert.equal(log.detail.rangeEnd, 5);
    assert.ok(log.detail.downloadSourceLabel);
    assert.ok(log.detail.message.includes('七牛云主存储'));
  }
  assert.equal(audits[0].actorId, 'admin');
  assert.equal(audits[3].action, 'FILE_SHARE_DOWNLOAD');
  assert.equal(audits[4].action, 'FOLDER_SHARE_DOWNLOAD');
  assert.equal(audits[5].actorId, null, 'DAV principal is not a User foreign key');
  assert.equal(audits[5].detail.actor, 'webdav:reader');
});

test('audit failure and statistics failure remain independent and do not break download', async () => {
  let auditCount = 0;
  const service = new DownloadStatsService({ auditLog: { create: async () => { auditCount++; } } });
  service.persist = async () => { throw new Error('stats unavailable'); };
  service.logger = { warn() {} };
  service.record({ projectId: 'p', fileId: 'f', source: 'PUBLIC', bytes: 3, storageSource: source });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(auditCount, 1);
  let statsCount = 0;
  service.persist = async () => { statsCount++; };
  service.prisma.auditLog.create = async () => { throw new Error('audit unavailable'); };
  service.record({ projectId: 'p', source: 'ADMIN', bytes: 2, storageSource: source });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(statsCount, 1);
});

function taskDb(rows, options = {}) {
  const state = { rows: structuredClone(rows), logs: [], rollbacks: 0 };
  const db = { $transaction: async callback => {
    const previous = structuredClone(state.rows);
    const previousLogs = state.logs.length;
    try {
      return await callback({ task: {
        findMany: async ({ where }) => state.rows.filter(t => where.id.in.includes(t.id)),
        deleteMany: async ({ where }) => {
          if (options.race) state.rows.find(t => t.id === options.race).status = 'RUNNING';
          const matches = state.rows.filter(t => where.id.in.includes(t.id) && where.status.in.includes(t.status));
          state.rows = state.rows.filter(t => !matches.includes(t));
          return { count: matches.length };
        },
      }, auditLog: { create: async ({ data }) => { if (options.auditFails) throw new Error('audit failure'); state.logs.push(data); } } });
    } catch (e) { state.rows = previous; state.logs.length = previousLogs; state.rollbacks++; throw e; }
  } };
  const service = new TasksService({ write: async () => assert.fail('audit must join deletion transaction') }, db, { assertProjectAccess: async () => {} });
  return { state, service };
}
const admin = { id: 'admin', role: 'SUPER_ADMIN' };
const task = (id, status = 'COMPLETED') => ({ id, status, projectId: 'p', type: 'FILE_BATCH_COPY', title: id });

test('batch delete deduplicates IDs, deletes only task rows and audits each task in the same transaction', async () => {
  const { service, state } = taskDb([task('a'), task('b', 'FAILED'), task('c', 'CANCELED'), task('keep')]);
  const result = await service.batchRemove(['a', 'b', 'c', 'a'], admin);
  assert.deepEqual(result, { success: true, deleted: 3 });
  assert.deepEqual(state.rows.map(t => t.id), ['keep']);
  assert.deepEqual(state.logs.map(l => l.detail.taskId), ['a', 'b', 'c']);
  assert.ok(state.logs.every(l => l.action === 'TASK_DELETE' && l.actorId === 'admin'));
});

test('running, paused, queued and unknown tasks reject the entire batch', async () => {
  for (const status of ['RUNNING', 'PAUSED', 'PENDING', 'QUEUED', 'UNKNOWN']) {
    const { service, state } = taskDb([task('a'), task('b', status)]);
    await assert.rejects(service.batchRemove(['a', 'b'], admin), /只能删除|尚未结束/);
    assert.equal(state.rows.length, 2); assert.equal(state.logs.length, 0);
  }
});

test('unauthorized, missing and invalid task selections cannot cause partial deletion', async () => {
  const { service, state } = taskDb([task('a')]);
  await assert.rejects(service.batchRemove(['a'], { id: 'outsider', role: 'PROJECT_ADMIN' }));
  await assert.rejects(service.batchRemove(['a', 'missing'], admin), /不存在/);
  for (const ids of [[], [''], [' '], [3], Array.from({ length: 101 }, (_, i) => 't' + i)]) {
    await assert.rejects(service.batchRemove(ids, admin), /选择|任务/);
  }
  assert.equal(state.rows.length, 1); assert.equal(state.logs.length, 0);
});

test('status race or audit error rolls back the complete deletion', async () => {
  for (const options of [{ race: 'b' }, { auditFails: true }]) {
    const { service, state } = taskDb([task('a'), task('b')], options);
    await assert.rejects(service.batchRemove(['a', 'b'], admin));
    assert.equal(state.rows.length, 2); assert.equal(state.logs.length, 0); assert.equal(state.rollbacks, 1);
  }
});

test('single task deletion protects paused tasks through the same rules', async () => {
  const { service, state } = taskDb([task('a', 'PAUSED')]);
  await assert.rejects(service.remove('a', admin), /只能删除|尚未结束/);
  assert.equal(state.rows.length, 1);
});

function loadWeb(file) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../../apps/web/src/utils/' + file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { exports: module.exports, module });
  return module.exports;
}

test('all task statuses use Chinese labels and only terminal tasks are selectable', () => {
  const view = loadWeb('task-view.ts');
  const labels = { PENDING: '等待执行', QUEUED: '排队中', RUNNING: '运行中', PAUSED: '已暂停', COMPLETED: '已完成', FAILED: '失败', CANCELED: '已取消' };
  for (const [status, label] of Object.entries(labels)) {
    assert.equal(view.taskStatusLabel(status), label);
    assert.equal(view.canDeleteTask({ status }), ['COMPLETED', 'FAILED', 'CANCELED'].includes(status));
  }
  assert.equal(view.taskStatusLabel('UNEXPECTED'), '未知状态');
  assert.equal(view.canDeleteTask({ status: 'UNEXPECTED' }), false);
});

test('audit source view uses structured metadata and safely degrades historic or invalid logs', () => {
  const view = loadWeb('audit-download-view.ts');
  assert.deepEqual(JSON.parse(JSON.stringify(view.auditDownloadSource({ storageSource: source }))), source);
  for (const detail of [null, {}, { source: 'open-api' }, { storageSource: { selected: {}, attempts: [] } }]) {
    assert.equal(view.auditDownloadSource(detail), null);
  }
  assert.equal(view.isDownloadAudit('FILE_DOWNLOAD'), true);
  assert.equal(view.isDownloadAudit('FILE_SHARE_DOWNLOAD'), true);
  assert.equal(view.isDownloadAudit('TASK_DELETE'), false);
});

test('audit source understands every configured provider and strips unrelated secret fields', () => {
  const view = loadWeb('audit-download-view.ts');
  for (const provider of ['LOCAL', 'QINIU', 'UPYUN', 'ALIYUN', 'S3']) {
    const metadata = structuredClone(source);
    metadata.selected.provider = provider;
    metadata.selected.url = 'https://signed.test/?secret=value';
    const value = view.auditDownloadSource({ storageSource: metadata });
    assert.equal(value?.selected.provider, provider);
    assert.equal(value.selected.url, undefined);
  }
});

test('bulk delete DTO rejects missing, empty, wrong and over-limit task IDs', async () => {
  const { validate } = require('class-validator');
  const { BatchDeleteTasksDto } = require('../../apps/api/src/tasks/dto/batch-delete-tasks.dto.ts');
  for (const taskIds of [undefined, [], [''], [8], ['x'.repeat(129)], Array.from({ length: 101 }, (_, i) => 't' + i)]) {
    const dto = Object.assign(new BatchDeleteTasksDto(), { taskIds });
    assert.ok((await validate(dto)).length);
  }
  assert.equal((await validate(Object.assign(new BatchDeleteTasksDto(), { taskIds: ['a', 'b'] }))).length, 0);
});

function taskMethods(extra = {}) {
  const text = fs.readFileSync(path.resolve(__dirname, '../../apps/web/src/views/Tasks.vue'), 'utf8').match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1];
  const parsed = ts.createSourceFile('Tasks.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const names = ['deleteTasks', 'reload', 'handleSelectionChange', 'searchTasks', 'removeSelectedTasks'];
  const functions = parsed.statements.filter(n => ts.isFunctionDeclaration(n) && names.includes(n.name.text)).map(n => n.getText(parsed)).join('\n');
  const context = { ...loadWeb('task-view.ts'), deleting: { value: false }, loading: { value: false }, selectedTask: { value: null }, detailVisible: { value: false }, selectedTasks: { value: [task('old')] }, taskTable: { value: { clearSelection() {} } },
    pageResult: { items: [], total: 21, page: 2, pageSize: 20 }, filters: { projectId: '', status: '', type: '' }, router: { replace() {} }, taskApi: {}, ElMessage: { success() {} }, ElMessageBox: {}, ...extra };
  vm.runInNewContext('let reloadVersion = 0;\n' + ts.transpileModule(functions, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  return context;
}

test('canceling delete keeps selection and makes no request; double invocation only sends once', async () => {
  let calls = 0, confirm;
  const api = { batchRemove: async () => { calls++; return { deleted: 1 }; }, list: async () => ({ items: [], total: 0, page: 1, pageSize: 20 }) };
  const context = taskMethods({ taskApi: api, ElMessageBox: { confirm: async () => { throw 'cancel'; } } });
  await context.deleteTasks([task('a')]);
  assert.equal(calls, 0); assert.equal(context.deleting.value, false); assert.equal(context.selectedTasks.value.length, 1);
  context.ElMessageBox.confirm = () => new Promise(resolve => { confirm = resolve; });
  const pending = context.deleteTasks([task('a')]);
  await context.deleteTasks([task('a')]);
  confirm(); await pending;
  assert.equal(calls, 1); assert.equal(context.selectedTasks.value.length, 0);
});

test('empty final page moves to the last valid page and refresh clears selection', async () => {
  const pages = [];
  const context = taskMethods({ taskApi: { list: async ({ page }) => { pages.push(page); return { items: page === 1 ? [task('keep')] : [], total: 20, page, pageSize: 20 }; } } });
  await context.reload();
  assert.deepEqual(pages, [2, 1]);
  assert.equal(context.pageResult.page, 1);
  assert.equal(context.selectedTasks.value.length, 0);
  assert.equal(context.loading.value, false);
});

test('older task list responses cannot overwrite a newer filter or selection', async () => {
  const pending = [];
  const context = taskMethods({ taskApi: { list: () => new Promise(resolve => pending.push(resolve)) } });
  const first = context.reload();
  context.filters.status = 'FAILED';
  const second = context.searchTasks();
  pending[1]({ items: [task('new', 'FAILED')], total: 1, page: 1, pageSize: 20 });
  await second;
  context.handleSelectionChange([task('new', 'FAILED')]);
  pending[0]({ items: [task('old')], total: 1, page: 1, pageSize: 20 });
  await first;
  assert.equal(context.pageResult.items[0].id, 'new');
  assert.equal(context.selectedTasks.value[0].id, 'new');
});
