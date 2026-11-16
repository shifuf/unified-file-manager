const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const axios = require('axios');

function fixture(refreshSession = async () => 'token') {
  const messages = [], navigations = [], calls = [];
  const auth = { loggedIn: true, refreshSession, logoutLocal() { calls.push('logout'); } };
  const module = { exports: {} };
  const source = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../../apps/web/src/api/http.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(source, { module, exports: module.exports, Blob, Date, Map, Promise,
    require(name) {
      if (name === 'axios') return axios;
      if (name === 'element-plus') return { ElMessage: { error: message => messages.push(message) } };
      if (name === '@/stores/auth') return { useAuthStore: () => auth };
      if (name === '@/router') return { __esModule: true, default: { push: route => navigations.push(route) } };
      throw new Error(name);
    },
  });
  return { http: module.exports.http, messages, navigations, calls };
}

test('download can opt into headers without changing ordinary API response data', async () => {
  const f = fixture();
  const adapter = async config => ({ data: new Blob(['bytes']), status: 200, statusText: 'OK', config, headers: { 'x-ufm-download-storage': 'cloud-source' } });
  const full = await f.http.get('/files/f/download', { _withResponse: true, adapter });
  assert.equal(full.headers['x-ufm-download-storage'], 'cloud-source');
  assert.equal(await full.data.text(), 'bytes');
  const ordinary = await f.http.get('/files/f/download', { adapter });
  assert.equal(await ordinary.text(), 'bytes');
});

test('canceled API reads are silent and do not expire the session', async () => {
  let refreshes = 0;
  const f = fixture(async () => { refreshes++; return 'token'; });
  const controller = new AbortController();
  const request = f.http.get('/projects/A', { signal: controller.signal, adapter: async config => {
    controller.abort();
    throw new axios.CanceledError('canceled', config);
  } });
  await assert.rejects(request, error => axios.isCancel(error));
  assert.deepEqual(f.messages, []);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.navigations, []);
  assert.equal(refreshes, 0);
});

test('read canceled while a shared token refresh is pending never replays or logs out', async () => {
  let release;
  let refreshes = 0;
  const refreshing = new Promise(resolve => { release = resolve; });
  const f = fixture(() => { refreshes++; return refreshing; });
  const controller = new AbortController();
  let requests = 0;
  const pending = f.http.get('/projects/A', { signal: controller.signal, adapter: async config => {
    requests++;
    throw new axios.AxiosError('Unauthorized', 'ERR_BAD_REQUEST', config, null, { status: 401, data: {} });
  } });
  while (!refreshes) await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  release(null);
  await assert.rejects(pending);
  assert.equal(requests, 1);
  assert.deepEqual(f.messages, []);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.navigations, []);
});

test('current API failures still display their server message', async () => {
  const f = fixture();
  await assert.rejects(f.http.get('/files', { adapter: async config => {
    throw new axios.AxiosError('Bad request', 'ERR_BAD_REQUEST', config, null, { status: 400, data: { message: '目录不可用' } });
  } }));
  assert.deepEqual(f.messages, ['目录不可用']);
});

test('a chunk 401 refreshes once and replays the same plan and chunk', async () => {
  let refreshes = 0, requests = 0;
  const f = fixture(async () => { refreshes++; return 'token'; });
  const urls = [];
  const result = await f.http.put('/projects/A/uploads/same-plan/chunks/2', 'retained chunk', { adapter: async config => {
    requests++;
    urls.push(config.url);
    if (requests === 1) throw new axios.AxiosError('Unauthorized', 'ERR_BAD_REQUEST', config, null, { status: 401, data: {} });
    assert.equal(config.data, 'retained chunk');
    return { status: 200, data: { received: 3 }, config };
  } });
  assert.equal(result.received, 3);
  assert.equal(refreshes, 1);
  assert.deepEqual(urls, ['/projects/A/uploads/same-plan/chunks/2', '/projects/A/uploads/same-plan/chunks/2']);
  assert.deepEqual(f.messages, []);
  assert.deepEqual(f.calls, []);
});

test('a read canceled while its blob error is being decoded stays silent', async () => {
  const f = fixture();
  const controller = new AbortController();
  const data = new Blob(['error']);
  data.text = async () => { controller.abort(); return '{"message":"stale server error"}'; };
  await assert.rejects(f.http.get('/projects/A', { signal: controller.signal, adapter: async config => {
    throw new axios.AxiosError('Bad request', 'ERR_BAD_REQUEST', config, null, { status: 400, data });
  } }));
  assert.deepEqual(f.messages, []);
});
