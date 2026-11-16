const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function fixture(view, overrides = {}) {
  const source = fs.readFileSync(path.resolve(__dirname, `../../apps/web/src/views/${view}.vue`), 'utf8');
  const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1];
  const parsed = ts.createSourceFile(`${view}.ts`, script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const names = view === 'Files' ? ['captureProjectContext', 'createFolder', 'removeFolder', 'handleFolderCommand', 'readRouteFolderPath'] : ['captureContext', 'readPanel', 'createDirectory', 'removeDirectory', 'loadDirectories', 'openDirectory'];
  const statements = parsed.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text));
  const calls = { create: [], remove: [], list: [], warning: [], success: [], navigation: [], refresh: 0 };
  const context = { globalThis: undefined, AbortController, Map, Set, console,
    selectedProjectId: { value: 'p1' }, canManageSelectedProject: { value: true }, project: { value: { id: 'p1', canManage: true } }, projectId: { value: 'p1' },
    projectContextGeneration: 0, contextGeneration: 0, mountController: new AbortController(), panelReads: new Map(),
    filters: { folderPath: 'docs' }, folderTree: { value: [] }, projectFolders: { value: [] }, directoriesLoading: { value: false }, directoriesError: { value: '' },
    route: { query: { projectId: 'p1', folderPath: 'docs/sub' } },
    router: { push: async args => calls.navigation.push(args) },
    fileApi: {
      createFolder: async (...args) => { calls.create.push(args); return overrides.create?.(...args) ?? { folderPath: args[1] }; },
      removeFolder: async (...args) => { calls.remove.push(args); return overrides.remove?.(...args) ?? { success: true }; },
      listFolderTree: async (...args) => { calls.list.push(args); return overrides.list?.(...args) ?? []; },
    },
    ElMessageBox: { prompt: async () => overrides.prompt ? overrides.prompt() : { value: '2026/november' }, confirm: async () => overrides.confirm?.() },
    ElMessage: { warning: message => calls.warning.push(message), success: message => calls.success.push(message), error() {} },
    reload: async () => { calls.refresh++; },
  };
  context.globalThis = context;
  vm.runInNewContext(ts.transpileModule(`${statements.map(node => node.getText(parsed)).join('\n')}\nObject.assign(globalThis, {${names.map(name => `${name}:typeof ${name}==='undefined'?undefined:${name}`).join(',')}});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  return { ...context, source, calls, switchProject() { context.selectedProjectId.value = 'p2'; context.projectId.value = 'p2'; context.projectContextGeneration++; context.contextGeneration++; } };
}

for (const view of ['Files', 'ProjectDetail']) {
  const createName = view === 'Files' ? 'createFolder' : 'createDirectory';
  const removeName = view === 'Files' ? 'removeFolder' : 'removeDirectory';
  test(`${view} creates a nested directory under the chosen parent`, async () => {
    const f = fixture(view); assert.equal(typeof f[createName], 'function');
    await f[createName]('contracts');
    assert.deepEqual(Array.from(f.calls.create[0]), ['p1', 'contracts/2026/november']);
  });
  test(`${view} cancellation never calls directory deletion or creation`, async () => {
    for (const method of [createName, removeName]) {
      const cancel = () => Promise.reject('cancel');
      const f = fixture(view, { prompt: cancel, confirm: cancel }); assert.equal(typeof f[method], 'function');
      await f[method]('docs'); assert.equal(f.calls.remove.length, 0); assert.equal(f.calls.create.length, 0);
    }
  });
  test(`${view} deleting a directory with active descendant files instructs file cleanup`, async () => {
    const f = fixture(view), tree = [{ path: 'docs', fileCount: 0, children: [{ path: 'docs/sub', fileCount: 1, children: [] }] }];
    f.folderTree.value = tree; f.projectFolders.value = tree;
    assert.equal(typeof f[removeName], 'function'); await f[removeName]('docs');
    assert.equal(f.calls.remove.length, 0); assert.match(f.calls.warning[0], /先删除.*文件/);
  });
  test(`${view} deleting a directory with empty children instructs child cleanup`, async () => {
    const f = fixture(view), tree = [{ path: 'docs', fileCount: 0, children: [{ path: 'docs/sub', fileCount: 0, children: [] }] }];
    f.folderTree.value = tree; f.projectFolders.value = tree;
    assert.equal(typeof f[removeName], 'function'); await f[removeName]('docs');
    assert.equal(f.calls.remove.length, 0); assert.match(f.calls.warning[0], /先删除.*子目录/);
  });
  test(`${view} project switch during confirmation prevents deleting either project`, async () => {
    const confirmation = deferred(), f = fixture(view, { confirm: () => confirmation.promise });
    assert.equal(typeof f[removeName], 'function'); const pending = f[removeName]('docs'); f.switchProject(); confirmation.resolve(); await pending;
    assert.equal(f.calls.remove.length, 0);
  });
  test(`${view} project switch during an in-flight deletion retains the captured request scope`, async () => {
    const removal = deferred(), f = fixture(view, { remove: () => removal.promise });
    assert.equal(typeof f[removeName], 'function'); const pending = f[removeName]('docs');
    await new Promise(resolve => setImmediate(resolve)); f.switchProject(); removal.resolve({ success: true }); await pending;
    assert.deepEqual(Array.from(f.calls.remove[0]), ['p1', 'docs']); assert.equal(f.calls.success.length, 0);
    assert.equal(f.calls.refresh, 0); assert.equal(f.calls.list.length, 0);
  });
  test(`${view} root and missing management access never submit deletion`, async () => {
    const f = fixture(view); assert.equal(typeof f[removeName], 'function');
    await f[removeName](''); f.canManageSelectedProject.value = false; f.project.value.canManage = false;
    await f[removeName]('docs'); assert.equal(f.calls.remove.length, 0);
  });
}

test('Files directory menu dispatches new-child and empty-delete commands', async () => {
  const f = fixture('Files'); await f.handleFolderCommand('create-child', 'docs');
  assert.deepEqual(Array.from(f.calls.create[0]), ['p1', 'docs/2026/november']);
  await f.handleFolderCommand('delete-folder', 'docs'); assert.deepEqual(Array.from(f.calls.remove[0]), ['p1', 'docs']);
});

test('Files route folder selection accepts the project detail directory navigation', () => {
  const f = fixture('Files'); assert.equal(typeof f.readRouteFolderPath, 'function'); assert.equal(f.readRouteFolderPath(), 'docs/sub');
});

test('ProjectDetail directory read rejects a stale project response and navigation carries the directory', async () => {
  const read = deferred(), f = fixture('ProjectDetail', { list: () => read.promise });
  assert.equal(typeof f.loadDirectories, 'function'); const pending = f.loadDirectories(); f.switchProject(); read.resolve([{ path: 'old', fileCount: 0, children: [] }]); await pending;
  assert.equal(f.projectFolders.value.length, 0);
  assert.equal(typeof f.openDirectory, 'function'); await f.openDirectory('docs/sub');
  assert.equal(f.calls.navigation[0].path, '/files'); assert.equal(f.calls.navigation[0].query.projectId, 'p2'); assert.equal(f.calls.navigation[0].query.folderPath, 'docs/sub');
});
