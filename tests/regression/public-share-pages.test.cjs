const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const vue = require('vue');
const { parse, compileScript, compileTemplate } = require('@vue/compiler-sfc');
const { renderToString } = require('vue/server-renderer');

const webRoot = path.resolve(__dirname, '../../apps/web/src');
const fileInfo = { token: 'opaque-token', fileName: 'report.zip', size: 15, category: 'ARCHIVE', hasPassword: false, previewable: false, previewOnly: false };
const folderInfo = { projectName: '项目资料', folderPath: 'reports', hasPassword: false, previewOnly: false };
const httpError = (status, message) => Object.assign(new Error(`Request failed with status code ${status}`), {
  response: { status, data: { message } },
});

function utilityFixture() {
  const document = { title: '统一文件管理系统' };
  const cache = new Map();
  function load(filename) {
    if (cache.has(filename)) return cache.get(filename);
    const module = { exports: {} };
    const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    vm.runInNewContext(source, { module, exports: module.exports, document, Blob, require: name => name.startsWith('@/') ? load(path.join(webRoot, `${name.slice(2)}.ts`)) : require(name) });
    cache.set(filename, module.exports);
    return module.exports;
  }
  return { document, utility: load(path.join(webRoot, 'utils/public-share.ts')) };
}

// Run the actual SFC setup and template. Only the external API, DOM and UI widgets
// are replaced; Vue reactivity, watchers, template branches and child SFCs are real.
function pageFixture(name, { routeName = 'share-access', params = { token: 'token' }, getInfo = async () => fileInfo, listFiles = async () => ({ items: [] }) } = {}) {
  const mounted = [], disposed = [], messages = [], requests = [];
  const route = vue.reactive({ name: routeName, params });
  const scope = vue.effectScope();
  const http = {
    get: async (url, options) => { requests.push({ method: 'GET', url, options }); return getInfo(url); },
    post: async (url, body, options) => { requests.push({ method: 'POST', url, body, options }); return listFiles(url, body); },
  };
  const publicShareApi = {
    get: (token, options) => http.get(`/shares/${token}`, options),
    resolve: (customPath, options) => http.get('/shares/resolve', { ...options, params: { path: customPath } }),
    preview: async () => new Blob(['preview']),
    createDownloadSession: async () => ({ url: '/native-download', expiresAt: '2026-12-01T00:00:00Z' }),
  };
  const cache = new Map();
  function execute(source, filename) {
    const module = { exports: {} };
    const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    vm.runInNewContext(output, { module, exports: module.exports, Blob, URL, AbortController, console,
      document: { title: '统一文件管理系统' },
      require(importName) {
        if (importName === 'vue') return { ...vue, onMounted: fn => mounted.push(fn), onBeforeUnmount: fn => disposed.push(fn) };
        if (importName === 'vue-router') return { useRoute: () => route };
        if (importName === 'element-plus') return { ElMessage: { error: value => messages.push(value), warning: value => messages.push(value), success: () => {} }, ElMessageBox: { alert: async () => {} } };
        if (importName === '@/api/modules') return { publicShareApi };
        if (importName === '@/api/http') return { http };
        if (importName === '@/utils/io') return { saveBlob: () => {} };
        if (importName.startsWith('@/')) {
          const localPath = path.join(webRoot, importName.slice(2));
          return localPath.endsWith('.vue') ? loadSfc(localPath) : execute(fs.readFileSync(`${localPath}.ts`, 'utf8'), `${localPath}.ts`);
        }
        return require(importName);
      },
    }, { filename });
    return module.exports;
  }
  function loadSfc(filename) {
    if (cache.has(filename)) return cache.get(filename);
    const { descriptor } = parse(fs.readFileSync(filename, 'utf8'), { filename });
    const script = compileScript(descriptor, { id: filename });
    const component = execute(script.content, filename).default;
    const template = compileTemplate({ source: descriptor.template.content, filename, id: filename, ssr: true, ssrCssVars: [], compilerOptions: { bindingMetadata: script.bindings } });
    assert.deepEqual(template.errors, []);
    component.ssrRender = execute(template.code, `${filename}:template`).ssrRender;
    const result = { __esModule: true, default: component };
    cache.set(filename, result);
    return result;
  }
  const component = loadSfc(path.join(webRoot, 'views', name)).default;
  const state = scope.run(() => component.setup({}, { expose() {} }));
  return {
    state, route, requests, messages,
    mount: () => state.loadShareInfo ? state.loadShareInfo() : state.loadInfo(),
    dispose: () => { disposed.forEach(fn => fn()); scope.stop(); },
    async render() {
      const app = vue.createSSRApp({ ...component, setup: () => state });
      for (const [name, tag] of Object.entries({ ElForm: 'form', ElFormItem: 'label', ElInput: 'input', ElButton: 'button', ElTag: 'span', ElIcon: 'span', ElSkeleton: 'div', ElAlert: 'div', ElEmpty: 'div' })) {
        app.component(name, { inheritAttrs: false, setup: (_, { attrs, slots }) => () => vue.h(tag, attrs, [attrs.description, attrs.title, slots.default?.(), slots.extra?.()]) });
      }
      app.directive('loading', { getSSRProps: () => ({}) });
      return renderToString(app);
    },
  };
}

for (const [name, routeName] of [['ShareAccess.vue', 'share-access'], ['ShareAccess.vue', 'share-access-custom'], ['FolderShareAccess.vue', 'folder-share-access']]) {
  test(`${routeName} renders an unavailable page with the site name for a missing share`, async t => {
    const f = pageFixture(name, { routeName, params: routeName === 'share-access-custom' ? { pathMatch: ['missing', 'share'] } : { token: 'missing' }, getInfo: async () => { throw httpError(404, '分享链接不存在或已失效。'); } });
    t.after(f.dispose);
    await f.mount();
    const html = await f.render();
    assert.match(html, /统一文件管理系统/);
    assert.match(html, /分享链接已失效/);
    assert.match(html, /联系分享者/);
    assert.match(html, /href="\/"/);
    assert.doesNotMatch(html, /Request failed|下载文件|目录为空|正在加载分享信息/);
    assert.deepEqual(f.messages, []);
    assert.equal(f.requests[0].options?._silent, true);
  });
}

for (const [name, info] of [['ShareAccess.vue', fileInfo], ['FolderShareAccess.vue', folderInfo]]) {
  test(`${name} shows a recoverable network page and retry restores the share`, async t => {
    let offline = true;
    const f = pageFixture(name, { getInfo: async () => { if (offline) throw new Error('Network Error'); return info; } });
    t.after(f.dispose);
    const initial = await f.render();
    assert.match(initial, /正在加载分享/);
    assert.doesNotMatch(initial, /下载文件|目录为空/);
    await f.mount();
    const failed = await f.render();
    assert.match(failed, /连接暂时中断/);
    assert.match(failed, /重新加载/);
    assert.doesNotMatch(failed, /Network Error/);
    offline = false;
    await (name === 'ShareAccess.vue' ? f.state.loadShareInfo() : f.state.loadInfo());
    const restored = await f.render();
    assert.match(restored, new RegExp(info.fileName || info.projectName));
    assert.doesNotMatch(restored, /连接暂时中断/);
    assert.match(restored, /统一文件管理系统/);
  });
}

test('metadata failures distinguish expired shares, access restrictions, rate limits and server failures', async t => {
  for (const [status, message, expected] of [[400, '分享链接已过期。', /分享链接已失效/], [403, '目录分享已停用。', /分享链接已失效/], [410, 'Gone', /分享链接已失效/], [403, '当前 IP 无权访问该分享。', /暂时无法访问此分享/], [429, 'Too many requests', /访问过于频繁/], [500, 'Internal server error https://upstream.invalid/?token=example-private-token', /分享暂时无法加载/]]) {
    const f = pageFixture('ShareAccess.vue', { getInfo: async () => { throw httpError(status, message); } });
    t.after(f.dispose);
    await f.mount();
    const html = await f.render();
    assert.match(html, expected);
    assert.doesNotMatch(html, /Internal server error|Too many requests|upstream.invalid|private-token/);
    assert.deepEqual(f.messages, []);
  }
});

test('changing folder routes clears old files and ignores an earlier directory listing', async t => {
  let releaseOld;
  const oldListing = new Promise(resolve => { releaseOld = resolve; });
  const f = pageFixture('FolderShareAccess.vue', {
    params: { token: 'old' },
    getInfo: async () => folderInfo,
    listFiles: async url => url.includes('/old/') ? oldListing : { items: [{ id: 'new', originalName: 'new-folder-file.txt', size: 1 }] },
  });
  t.after(f.dispose);
  const mounting = f.mount();
  await new Promise(resolve => setImmediate(resolve));
  f.state.password.value = 'old-password';
  f.route.params.token = 'new';
  await vue.nextTick();
  await new Promise(resolve => setImmediate(resolve));
  releaseOld({ items: [{ id: 'old', originalName: 'old-folder-file.txt', size: 1 }] });
  await mounting;
  assert.equal(f.state.password.value, '');
  const html = await f.render();
  assert.match(html, /new-folder-file.txt/);
  assert.doesNotMatch(html, /old-folder-file.txt/);
});

test('configured branding stays visible above share content and an empty title falls back to the site name', async t => {
  for (const title of ['', '团队资料站']) {
    const f = pageFixture('ShareAccess.vue', { getInfo: async () => ({ ...fileInfo, brand: { title, logoUrl: '/broken-logo.svg', subtitle: '文件分享' } }) });
    t.after(f.dispose);
    await f.mount();
    const html = await f.render();
    assert.match(html, new RegExp(title || '统一文件管理系统'));
    assert.ok(html.indexOf('<header') < html.indexOf('share-panel'), 'brand header precedes the content panel');
  }
});

test('changing a share route clears stale file/password/preview state and ignores the old request', async t => {
  let releaseOld;
  const oldRequest = new Promise(resolve => { releaseOld = resolve; });
  const f = pageFixture('ShareAccess.vue', { getInfo: async url => url.endsWith('/old') ? oldRequest : { ...fileInfo, fileName: 'new-share.zip' }, params: { token: 'old' } });
  t.after(f.dispose);
  const mounting = f.mount();
  f.state.password.value = 'old-password';
  f.state.previewText.value = 'old private content';
  f.route.params.token = 'new';
  await vue.nextTick();
  await new Promise(resolve => setImmediate(resolve));
  releaseOld({ ...fileInfo, fileName: 'old-share.zip' });
  await mounting;
  assert.equal(f.state.password.value, '');
  assert.equal(f.state.previewText.value, null);
  const html = await f.render();
  assert.match(html, /new-share.zip/);
  assert.doesNotMatch(html, /old-share.zip|old private content/);
});

test('folder shares separate password errors, unlocked empty directories and list network failures', async t => {
  let outcome = 'password';
  const f = pageFixture('FolderShareAccess.vue', { getInfo: async () => ({ ...folderInfo, hasPassword: true }), listFiles: async () => {
    if (outcome === 'password') throw httpError(403, '分享密码错误。');
    if (outcome === 'network') throw new Error('Network Error');
    return { items: [] };
  } });
  t.after(f.dispose);
  await f.mount();
  assert.match(await f.render(), /输入分享密码后/);
  f.state.password.value = 'wrong';
  await f.state.loadFiles();
  assert.match(await f.render(), /分享密码错误/);
  assert.doesNotMatch(await f.render(), /目录为空/);
  outcome = 'network';
  await f.state.loadFiles();
  assert.match(await f.render(), /重新加载/);
  assert.doesNotMatch(await f.render(), /目录为空|Network Error/);
  outcome = 'empty';
  await f.state.loadFiles();
  assert.match(await f.render(), /目录为空/);
  assert.doesNotMatch(await f.render(), /分享密码错误|连接暂时中断/);
});

test('the site name survives another public page changing document.title', () => {
  const f = utilityFixture();
  f.document.title = '客户A · 公开资源库';
  assert.equal(f.utility.getShareSiteName(), '统一文件管理系统');
});

test('share action errors hide unknown server messages and provider URLs in JSON and blobs', async () => {
  const { utility } = utilityFixture();
  for (const message of ['Internal server error', 'Request failed with status code 404', '存储访问失败 https://upstream.invalid/object?token=example-private-token']) {
    for (const asBlob of [false, true]) {
      const error = httpError(500, message);
      if (asBlob) error.response.data = new Blob([JSON.stringify({ message })], { type: 'application/json' });
      assert.equal(await utility.readPublicShareMessage(error, '下载暂时无法开始，请稍后重试。'), '下载暂时无法开始，请稍后重试。');
    }
  }
});

test('known share action errors retain useful password, limit and ban guidance without private details', async () => {
  const { utility } = utilityFixture();
  const passwordError = httpError(400, '分享密码错误。');
  passwordError.response.data = new Blob([JSON.stringify(passwordError.response.data)], { type: 'application/json' });
  assert.match(await utility.readPublicShareMessage(passwordError, '预览失败'), /分享密码错误/);
  assert.match(await utility.readPublicShareMessage(httpError(429, '该 IP 已被临时禁止下载，请 10 分钟后再试。'), '下载失败'), /10 分钟后再试/);
  const ban = await utility.readPublicShareMessage(httpError(403, '该 IP 已被永久禁止下载分享文件：管理员备注 https://internal.invalid/?token=example-private-token'), '下载失败');
  assert.match(ban, /禁止下载/);
  assert.doesNotMatch(ban, /管理员备注|internal.invalid|private-token/);
});
