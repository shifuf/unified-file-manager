const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const vue = require('vue');
const { parse, compileScript } = require('@vue/compiler-sfc');

// Execute the actual page setup. Only transport, routing and confirmation UI are
// external doubles; Vue refs and the production event handlers remain real.
function pageFixture({ confirm = async () => {}, mutate = async () => {} } = {}) {
  const filename = path.resolve(__dirname, '../../apps/web/src/views/Shares.vue');
  const { descriptor } = parse(fs.readFileSync(filename, 'utf8'), { filename });
  const script = compileScript(descriptor, { id: 'share-lifecycle' });
  const source = ts.transpileModule(script.content, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const module = { exports: {} }, requests = [], messages = [];
  const share = { id: 'share-1', fileId: 'file-1', fileName: '保留源文件.txt', enabled: true, status: 'ACTIVE', url: '/shares/share-1' };
  let reads = 0;
  const fileApi = {
    listAllShares: async () => { reads++; return { items: [{ ...share }], total: 1, page: 1, pageSize: 20 }; },
    updateShare: async (id, body) => { requests.push({ method: 'PUT', id, body }); await mutate(); share.enabled = body.enabled; share.status = body.enabled ? 'ACTIVE' : 'DISABLED'; return { ...share }; },
    deleteShare: async id => { requests.push({ method: 'DELETE', id }); await mutate(); return { success: true }; },
  };
  vm.runInNewContext(source, {
    module, exports: module.exports,
    require(name) {
      if (name === 'vue') return { ...vue, onMounted: () => {} };
      if (name === 'vue-router') return { useRoute: () => ({ query: {} }), useRouter: () => ({ replace: async () => {} }) };
      if (name === 'element-plus') return { ElMessage: { success: text => messages.push(text), warning: text => messages.push(text) }, ElMessageBox: { confirm } };
      if (name === '@/api/modules') return { fileApi, projectApi: { list: async () => [] } };
      if (name === '@/utils/io') return { copyText: async () => {} };
      if (name === '@/utils/share-url') return { safeShareUrl: value => value };
      if (name.endsWith('.vue')) return { __esModule: true, default: {} };
      return require(name);
    },
  }, { filename });
  const scope = vue.effectScope();
  const state = scope.run(() => module.exports.default.setup({}, { expose() {} }));
  return { state, share, requests, messages, reads: () => reads, dispose: () => scope.stop() };
}

test('share manager pauses and resumes with enabled payloads then refreshes server state', async t => {
  const f = pageFixture(); t.after(f.dispose);
  await f.state.setShareEnabled(f.share, false);
  assert.equal(f.share.enabled, false);
  assert.equal(f.state.pageResult.items[0].status, 'DISABLED');
  await f.state.setShareEnabled(f.share, true);
  assert.equal(f.share.enabled, true);
  assert.deepEqual(JSON.parse(JSON.stringify(f.requests)), [
    { method: 'PUT', id: 'share-1', body: { enabled: false } },
    { method: 'PUT', id: 'share-1', body: { enabled: true } },
  ]);
  assert.equal(f.reads(), 2);
});

test('a pending confirmation or request blocks a repeated lifecycle action for that share', async t => {
  let release;
  const f = pageFixture({ confirm: () => new Promise(resolve => { release = resolve; }) }); t.after(f.dispose);
  const first = f.state.setShareEnabled(f.share, false);
  await f.state.setShareEnabled(f.share, false);
  await f.state.deleteShare(f.share);
  assert.equal(f.requests.length, 0);
  release(); await first;
  assert.equal(f.requests.length, 1);
  assert.equal(f.state.pendingShareIds.value.has(f.share.id), false);
});

test('cancelling or closing pause and delete confirmations leaves the share untouched', async t => {
  for (const action of ['cancel', 'close']) {
    const f = pageFixture({ confirm: async () => { throw action; } }); t.after(f.dispose);
    await f.state.setShareEnabled(f.share, false);
    await f.state.deleteShare(f.share);
    assert.equal(f.requests.length, 0);
    assert.equal(f.share.enabled, true);
    assert.equal(f.reads(), 0);
    assert.equal(f.state.pendingShareIds.value.size, 0);
  }
});

test('permanent share deletion confirms source file preservation and refreshes the list', async t => {
  const confirmations = [];
  const f = pageFixture({ confirm: async (text, title) => { confirmations.push({ text, title }); } }); t.after(f.dispose);
  await f.state.deleteShare(f.share);
  assert.deepEqual(JSON.parse(JSON.stringify(f.requests)), [{ method: 'DELETE', id: 'share-1' }]);
  assert.match(confirmations[0].text, /不会删除源文件/);
  assert.match(confirmations[0].title, /删除分享/);
  assert.equal(f.reads(), 1);
  assert.equal(f.share.fileId, 'file-1');
});

test('failed lifecycle requests release the busy row and preserve its visible state', async t => {
  const f = pageFixture({ mutate: async () => { throw new Error('service unavailable'); } }); t.after(f.dispose);
  await f.state.setShareEnabled(f.share, false);
  await f.state.deleteShare(f.share);
  assert.equal(f.share.enabled, true);
  assert.equal(f.state.pendingShareIds.value.size, 0);
  assert.equal(f.reads(), 0);
});
