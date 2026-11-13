const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const source = () => fs.readFileSync(path.resolve(__dirname, '../../apps/web/src/views/ProjectDetail.vue'), 'utf8');
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture(overrides = {}) {
  const calls = { replicas: [], files: [], downloads: [], summary: [] }, watchers = [], unmounts = [];
  const route = { params: { projectId: 'p1' } };
  const response = params => ({ items: [{ id: `page-${params.page || 1}` }], total: 45, page: params.page || 1, pageSize: params.pageSize || 20, counts: { READY: 45 } });
  const read = (key, params, options) => { calls[key].push({ params: { ...params }, options }); return overrides[key]?.(params, options) ?? Promise.resolve(response(params)); };
  const context = { AbortController, Map, Set, console, URL, window: { location: { origin: 'http://fixture' } },
    ref: value => ({ value }), reactive: value => value, computed: fn => ({ get value() { return fn(); } }),
    watch: (get, callback) => watchers.push(callback), onBeforeUnmount: callback => unmounts.push(callback), useRoute: () => route, useRouter: () => ({ push() {} }),
    ElMessage: { success() {}, error() {}, warning() {} }, ElMessageBox: { close() {} },
    projectApi: { get: async id => ({ id, storages: [], canManage: false }), stats: async () => ({}), hotspots: async () => ({}) },
    cdnApi: { list: async () => [], usage: async () => ({}) }, uploadCredentialApi: {}, http: {},
    replicaApi: { list: (id, options, params) => read('replicas', { projectId: id, ...params }, options) },
    fileApi: { list: (params, options) => read('files', params, options) },
    downloadStatsApi: { summary: (id, params, options) => read('summary', { projectId: id, ...params }, options), list: (id, params, options) => read('downloads', { projectId: id, ...params }, options) },
  };
  const script = source().match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1];
  const parsed = ts.createSourceFile('ProjectDetail.ts', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const code = parsed.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(parsed)).join('\n');
  const names = ['pageSizes', 'replicas', 'replicasLoading', 'replicasError', 'replicaPage', 'replicaPageSize', 'replicaTotal', 'files', 'filesLoading', 'filesError', 'filesPage', 'filesPageSize', 'filesTotal', 'downloadItems', 'downloadTotal', 'downloadPage', 'downloadPageSize', 'downloadDays', 'downloadLoading', 'downloadError', 'downloadSummary', 'downloadSummaryLoading', 'downloadSummaryError', 'detailFile', 'detailsVisible', 'project', 'projectStorages', 'loadDetail', 'loadReplicas', 'loadFiles', 'loadDownloadStats', 'loadDownloadItems', 'changeDownloadDays', 'changeReplicaPage', 'changeReplicaPageSize', 'changeFilesPage', 'changeFilesPageSize', 'changeDownloadPage', 'changeDownloadPageSize'];
  vm.runInNewContext(ts.transpileModule(`${code}\nObject.assign(globalThis, { ${names.map(name => `${name}: typeof ${name} === 'undefined' ? undefined : ${name}`).join(',')} });`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  return { ...context, calls, route, switchProject(id) { route.params.projectId = id; watchers[0](); }, unmount() { unmounts.forEach(fn => fn()); } };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('initial replica and recent-file reads are bounded to the default 20 rows', async () => {
  const f = fixture(); await f.loadDetail();
  for (const key of ['replicas', 'files', 'downloads']) {
    assert.equal(f.calls[key][0].params.page, 1, `${key} starts on page one`);
    assert.equal(f.calls[key][0].params.pageSize, 20, `${key} defaults to 20`);
    assert.equal(f.calls[key][0].params.limit, undefined, 'page reads do not append cursor batches');
  }
});

test('download pagination requests only details and uses independent page size', async () => {
  const f = fixture(); await f.loadDownloadStats();
  f.downloadPage.value = 2;
  await (f.loadDownloadItems || f.loadDownloadStats)();
  assert.equal(f.calls.summary.length, 1, 'flipping details does not reload the summary');
  assert.equal(f.calls.downloads.at(-1).params.page, 2);
  assert.equal(typeof f.changeDownloadPageSize, 'function');
  await f.changeDownloadPageSize(50);
  assert.equal(f.calls.downloads.at(-1).params.page, 1);
  assert.equal(f.calls.downloads.at(-1).params.pageSize, 50);
  assert.equal(f.calls.summary.length, 1);
});

test('page and size changes issue bounded reads, reset size changes, and reject invalid values', async () => {
  for (const prefix of ['Replica', 'Files', 'Download']) {
    const f = fixture(), key = prefix === 'Replica' ? 'replicas' : prefix === 'Files' ? 'files' : 'downloads';
    assert.equal(typeof f[`change${prefix}Page`], 'function', `${key} has a page handler`);
    await f[`change${prefix}Page`](2);
    assert.equal(f.calls[key].at(-1).params.page, 2);
    await f[`change${prefix}PageSize`](100);
    assert.equal(f.calls[key].at(-1).params.page, 1);
    assert.equal(f.calls[key].at(-1).params.pageSize, 100);
    await f[`change${prefix}PageSize`](13);
    assert.equal(f.calls[key].at(-1).params.pageSize, 20);
    await f[`change${prefix}Page`](2.5);
    assert.equal(f.calls[key].at(-1).params.page, 1);
  }
});

test('same-panel refresh cancels the old read without accepting its data or clearing current loading', async () => {
  const reads = [deferred(), deferred()]; let index = 0;
  const f = fixture({ replicas: () => reads[index++].promise });
  const old = f.loadReplicas(), fresh = f.loadReplicas();
  assert.equal(f.calls.replicas[0].options.signal.aborted, true);
  reads[0].resolve({ items: [{ id: 'old' }], total: 45, page: 1, counts: {} }); await old;
  assert.equal(f.replicas.value, null);
  assert.equal(f.replicasLoading.value, true);
  reads[1].resolve({ items: [{ id: 'fresh' }], total: 45, page: 1, counts: {} }); await fresh;
  assert.equal(f.replicas.value.items[0].id, 'fresh');
  assert.equal(f.replicasLoading.value, false);
});

test('a page change before its next request prevents the old page response from committing', async () => {
  const pending = deferred(), f = fixture({ replicas: () => pending.promise });
  assert.ok(f.replicaPage, 'replicas own a page state');
  const read = f.loadReplicas(); f.replicaPage.value = 2;
  pending.resolve({ items: [{ id: 'stale-page' }], total: 45, page: 1, counts: {} }); await read;
  assert.equal(f.replicas.value, null);
});

test('clamped server pages update the UI while preserving the returned final-page data', async () => {
  for (const [key, page, load] of [['replicas', 'replicaPage', 'loadReplicas'], ['files', 'filesPage', 'loadFiles'], ['downloads', 'downloadPage', 'loadDownloadItems']]) {
    const f = fixture({ [key]: () => Promise.resolve({ items: [{ id: 'last' }], total: 25, page: 2, counts: {} }) });
    assert.ok(f[page], `${key} owns page state`); f[page].value = 3;
    await f[load](); assert.equal(f[page].value, 2); assert.equal(f.calls[key].length, 1);
    assert.equal((key === 'replicas' ? f.replicas.value.items : key === 'files' ? f.files.value : f.downloadItems.value)[0].id, 'last');
  }
});

test('a disappearing last page refetches the final valid page when the response was not clamped', async () => {
  for (const [key, page, load] of [['replicas', 'replicaPage', 'loadReplicas'], ['files', 'filesPage', 'loadFiles'], ['downloads', 'downloadPage', 'loadDownloadItems']]) {
    const f = fixture({ [key]: params => Promise.resolve({ items: params.page === 2 ? [{ id: 'last' }] : [], total: 25, page: params.page, counts: {} }) });
    assert.ok(f[page]); f[page].value = 3; await f[load](); await settle();
    assert.equal(f.calls[key].length, 2); assert.equal(f.calls[key][1].params.page, 2); assert.equal(f[page].value, 2);
  }
});

test('range changes reset download page and abort both old summary and detail reads', async () => {
  const summaries = [deferred(), deferred()], details = [deferred(), deferred()]; let s = 0, d = 0;
  const f = fixture({ summary: () => summaries[s++].promise, downloads: () => details[d++].promise });
  const old = f.loadDownloadStats(); f.downloadPage.value = 3; f.downloadDays.value = 7;
  assert.equal(typeof f.changeDownloadDays, 'function'); const fresh = f.changeDownloadDays();
  assert.equal(f.calls.summary[0].options.signal.aborted, true); assert.equal(f.calls.downloads[0].options.signal.aborted, true);
  assert.equal(f.calls.downloads[1].params.page, 1); assert.equal(f.calls.downloads[1].params.days, 7);
  summaries[0].resolve({ totalCount: 99 }); details[0].resolve({ items: [{ id: 'old' }], total: 99, page: 3 }); await old;
  assert.equal(f.downloadSummary.value, null); assert.equal(f.downloadTotal.value, 0);
  summaries[1].resolve({ totalCount: 2 }); details[1].resolve({ items: [{ id: 'new' }], total: 2, page: 1 }); await fresh;
  assert.equal(f.downloadSummary.value.totalCount, 2); assert.equal(f.downloadTotal.value, 2);
});

test('project changes clear all panel rows, totals and paging and cancel old requests', async () => {
  const pending = deferred(), f = fixture({ replicas: params => params.projectId === 'p1' ? pending.promise : new Promise(() => {}) });
  assert.ok(f.replicaPage && f.filesPage && f.filesTotal);
  f.replicaPage.value = 3; f.filesPage.value = 3; f.downloadPage.value = 3;
  f.replicaTotal.value = 45; f.filesTotal.value = 45; f.downloadTotal.value = 45;
  const old = f.loadReplicas(); f.switchProject('p2');
  assert.equal(f.calls.replicas[0].options.signal.aborted, true);
  for (const name of ['replicaPage', 'filesPage', 'downloadPage']) assert.equal(f[name].value, 1);
  for (const name of ['replicaTotal', 'filesTotal', 'downloadTotal']) assert.equal(f[name].value, 0);
  pending.resolve({ items: [{ id: 'old-project' }], total: 45, page: 3, counts: {} }); await old;
  assert.equal(f.replicas.value, null); assert.equal(f.replicaTotal.value, 0);
  f.unmount(); assert.equal(f.calls.replicas.at(-1).options.signal.aborted, true);
});

test('panel failures remain independent and preserve the last successful rows', async () => {
  let failed = false; const pending = deferred();
  const f = fixture({ replicas: () => failed ? Promise.reject(new Error('fixture failure')) : Promise.resolve({ items: [{ id: 'known' }], total: 1, page: 1, counts: {} }), files: () => pending.promise });
  assert.equal(typeof f.loadFiles, 'function'); await f.loadReplicas(); failed = true;
  const files = f.loadFiles(); await f.loadReplicas();
  assert.equal(f.replicas.value.items[0].id, 'known'); assert.ok(f.replicasError.value);
  assert.equal(f.filesLoading.value, true); assert.equal(f.filesError.value, '');
  pending.reject(new Error('file fixture failure')); await files; assert.ok(f.filesError.value); assert.equal(f.filesLoading.value, false);
});

test('project configuration labels follow global cloud priority with ID ties and local fallback', () => {
  const f = fixture(); assert.ok(f.projectStorages);
  f.project.value = { storages: [
    { id: 'local', provider: 'LOCAL', priority: 0, enabled: true },
    { id: 'z', provider: 'QINIU', priority: 1, enabled: true },
    { id: 'a', provider: 'UPYUN', priority: 1, enabled: true },
    { id: 'disabled', provider: 'S3', priority: 2, enabled: false },
  ] };
  assert.deepEqual(Array.from(f.projectStorages.value, item => item.id), ['a', 'z', 'disabled', 'local']);
});

test('all three actual pagination templates stay visible at zero and wire page and size events to bounded reads', async () => {
  const compiler = require('@vue/compiler-dom'), vue = require('vue');
  const template = source().match(/<template>([\s\S]*?)<\/template>\s*<script/)[1], nodes = [];
  function find(node) { if (node.type === 1 && node.tag === 'el-pagination') nodes.push(node.loc.source); for (const child of node.children || []) find(child); }
  find(compiler.parse(template)); assert.equal(nodes.length, 3);
  for (const [index, key] of ['downloads', 'replicas', 'files'].entries()) {
    const f = fixture(), context = Object.fromEntries(Object.entries(f).map(([name, value]) => [name, value && 'value' in Object(value) ? value.value : value]));
    const render = new Function('Vue', compiler.compile(nodes[index], { mode: 'function' }).code)({ ...vue, resolveComponent: name => ({ name }) });
    const vnode = render(context, []);
    assert.equal(vnode.type.name, 'el-pagination', `${key} pagination renders for an empty result`);
    assert.equal(vnode.props.total, 0); assert.equal(vnode.props['page-size'], 20);
    assert.equal(vnode.props.layout, 'total, sizes, prev, pager, next, jumper');
    assert.deepEqual(Array.from(vnode.props['page-sizes']), [10, 20, 50, 100]);
    await vnode.props['onUpdate:currentPage'](2); assert.equal(f.calls[key].at(-1).params.page, 2);
    await vnode.props['onUpdate:pageSize'](50); assert.equal(f.calls[key].at(-1).params.page, 1); assert.equal(f.calls[key].at(-1).params.pageSize, 50);
  }
});
