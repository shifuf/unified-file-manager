/* Real Vue/Element Plus component, isolated Vite server, intercepted cloud APIs. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/shifuf/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const output = path.resolve(__dirname, '../../.runtime/remote-files-preview');
const longName = '云盘中的完整原始名称-设计素材与跨部门交付资料ABCDEFGHIJKLMNOPQRSTUVWXYZ-最终确认版本.pdf';
const file = (id, name = `${id}.txt`, extra = {}) => ({ id, parentId: 'configured-root', name, type: 'file', size: 1024, updatedAt: '2026-11-20T08:00:00.000Z', ...extra });
const folder = { id: 'folder-one', parentId: 'configured-root', name: '项目资料', type: 'folder', size: 0, project: { id: 'source-project', name: '云端来源项目' } };
const rootPage = { parentId: 'configured-root', items: [folder, file('file-a', 'a'.repeat(64), { originalName: longName }), file('file-hash', 'b'.repeat(64))], nextCursor: 'next-page' };
const results = [];
let fixture, url;

async function choose(dialog, name) {
  const checkbox = dialog.getByRole('checkbox', { name: `选择 ${name}`, exact: true });
  await checkbox.locator('..').click();
  assert.equal(await checkbox.isChecked(), true);
}
async function projects(f, names = ['合成项目']) {
  const select = f.dialog.getByRole('combobox', { name: f.kind === 'project' ? '要同步的项目' : '目标项目', exact: true });
  await select.focus();
  await select.press('ArrowDown');
  for (const name of names) await f.page.getByRole('option', { name, exact: true }).click();
  await select.press('Escape');
}
const importRequests = f => f.requests.filter(request => request.method === 'POST');
const cloudListRequests = f => f.requests.filter(request => request.method === 'GET' && !request.path.includes('/jobs/'));
async function idle(f) { await f.page.waitForFunction(() => !document.querySelector('.remote-files-dialog .el-loading-mask')); }

async function setup(browser, options = {}) {
  const state = await fixture(browser, options.width || 390);
  const requests = [];
  let listCalls = 0, importCalls = 0, projectCalls = 0, activeImports = 0, maxImports = 0;
  let jobCounter = 0, pollCalls = 0, downloadCalls = 0;
  const jobs = new Map();
  let holdReady = !options.holdImport;
  if (options.holdImport) options.holdImport.then(() => { holdReady = true; });
  function finishImport(body, attempt) {
    if (options.importResult) return options.importResult(body, attempt);
    const targets = body.asBackup ? [undefined] : body.projectIds || [body.projectId];
    const items = body.fileIds.flatMap(id => targets.map(projectId => ({ id, name: id === 'file-a' ? longName : `${id}.txt`, status: 'IMPORTED', fileId: `local-${id}-${projectId || 'backup'}`, ...(projectId ? { projectId, projectName: projectId === 'project-one' ? '合成项目' : '交付项目' } : {}) })));
    return { imported: items.length, failed: 0, items };
  }
  await state.page.route('**/api/projects{,?*}', async route => {
    projectCalls++;
    if (options.failProjectsFirst && projectCalls === 1) return route.fulfill({ status: 503, json: { message: '项目读取失败' } });
    return route.fulfill({ json: options.projects || [
      { id: 'project-one', name: '合成项目', enabled: true, canManage: true },
      { id: 'project-two', name: '交付项目', enabled: true, canManage: true },
      { id: 'forbidden', name: '无权限项目', enabled: true, canManage: false },
    ] });
  });
  const remoteRoute = async route => {
    const request = route.request(), location = new URL(request.url());
    const body = request.postDataJSON();
    requests.push({ method: request.method(), path: location.pathname, params: Object.fromEntries(location.searchParams), body });
    if (location.pathname.endsWith('/import-jobs') || location.pathname.endsWith('/download-jobs')) {
      const kind = location.pathname.endsWith('/import-jobs') ? 'IMPORT' : 'DOWNLOAD';
      const attempt = kind === 'IMPORT' ? ++importCalls : ++downloadCalls;
      if (options.failStartFirst && attempt === 1) return route.fulfill({ status: 503, json: { message: '后台任务提交未确认。' } });
      activeImports++; maxImports = Math.max(maxImports, activeImports);
      const id = `job-${++jobCounter}`;
      const job = { id, kind, status: 'RUNNING', body, attempt, remainingPolls: options.runningPolls || 0 };
      jobs.set(id, job);
      return route.fulfill({ status: 202, json: { id, kind, status: 'RUNNING' } });
    }
    const jobMatch = /\/jobs\/([^/]+)(\/download)?$/.exec(location.pathname);
    if (jobMatch) {
      const job = jobs.get(jobMatch[1]);
      if (!job) return route.fulfill({ status: 404, json: { message: '任务不存在' } });
      if (jobMatch[2]) {
        if (job.kind !== 'DOWNLOAD' || job.status !== 'SUCCEEDED') return route.fulfill({ status: 409, json: { message: '文件尚未校验完成' } });
        jobs.delete(job.id);
        return route.fulfill({ body: 'synthetic-file', headers: { 'content-disposition': 'attachment; filename="fixture.txt"' } });
      }
      pollCalls++;
      if (options.failPollFirst && pollCalls === 1) return route.fulfill({ status: 503, json: { message: '任务查询连接中断' } });
      if (options.expireFirst && pollCalls === 1) { jobs.delete(job.id); activeImports--; return route.fulfill({ status: 404, json: { message: '任务已过期' } }); }
      if (job.status === 'RUNNING') {
        if (!holdReady || job.remainingPolls-- > 0) return route.fulfill({ json: { id: job.id, kind: job.kind, status: 'RUNNING' } });
        activeImports--;
        if (options.failImportFirst && job.kind === 'IMPORT' && job.attempt === 1 || options.failDownloadFirst && job.kind === 'DOWNLOAD' && job.attempt === 1) {
          job.status = 'FAILED'; job.error = job.kind === 'IMPORT' ? '云盘读取中断，请重试。' : '云端下载校验失败，请重试。';
        } else {
          job.status = 'SUCCEEDED';
          if (job.kind === 'IMPORT') job.result = finishImport(job.body, job.attempt);
          else { job.name = longName; job.size = 1024; }
        }
      }
      return route.fulfill({ json: { id: job.id, kind: job.kind, status: job.status, ...(job.result ? { result: job.result } : {}), ...(job.error ? { error: job.error } : {}), ...(job.name ? { name: job.name, size: job.size } : {}) } });
    }
    if (location.pathname.endsWith('/download')) return route.fulfill({ body: 'synthetic-file' });
    listCalls++;
    if (options.failFirst && listCalls === 1) return route.fulfill({ status: 503, json: { message: '云盘连接暂时不可用' } });
    if (options.list) return options.list(route, location, listCalls);
    if (options.empty) return route.fulfill({ json: { parentId: 'configured-root', items: [], nextCursor: null } });
    if (location.searchParams.get('parentId') === folder.id) return route.fulfill({ json: { parentId: folder.id, items: [file('nested-file', '目录内文件.txt', { parentId: folder.id })], nextCursor: null } });
    if (location.searchParams.get('cursor')) return route.fulfill({ json: { parentId: 'configured-root', items: [file('page-two', '下一页.txt')], nextCursor: null } });
    return route.fulfill({ json: rootPage });
  };
  await state.page.route('**/api/storage-configs/cloud/remote-files**', remoteRoute);
  // A popup's first navigation is not intercepted by page.route.
  await state.context.route('**/api/storage-configs/cloud/remote-files/jobs/*/download', remoteRoute);
  await state.page.route('**/api/storage-configs/cloud/project-sync', async route => {
    const body = route.request().postDataJSON();
    requests.push({ method: route.request().method(), path: new URL(route.request().url()).pathname, params: {}, body });
    importCalls++;
    if (options.holdImport) await options.holdImport;
    if (options.failImportFirst && importCalls === 1) return route.fulfill({ status: 503, json: { message: '同步任务提交失败，请重试。' } });
    const names = new Map((options.projects || [{ id: 'project-one', name: '合成项目' }, { id: 'project-two', name: '交付项目' }]).map(project => [project.id, project.name]));
    return route.fulfill({ json: { queuedProjects: body.projectIds.length, projects: body.projectIds.map(projectId => ({ projectId, projectName: names.get(projectId), taskId: `task-${projectId}`, requeued: 3 })) } });
  });
  state.page.setDefaultTimeout(30000);
  await state.page.addInitScript(config => { window.__REMOTE_FIXTURE_CONFIG__ = config; }, options.config || { id: 'cloud', name: '合成云盘', projects: [{ id: 'project-one' }, { id: 'project-two' }] });
  await state.page.goto(url + '/__remote_sync_fixture_page' + (options.kind === 'project' ? '?kind=project' : ''), { waitUntil: 'domcontentloaded', timeout: 45000 });
  const dialog = state.page.getByRole('dialog', { name: options.kind === 'project' ? '按项目同步到阿里云盘 · 合成云盘' : '云盘文件 · 合成云盘', exact: true });
  await dialog.waitFor();
  await idle({ ...state, dialog });
  return { ...state, dialog, requests, kind: options.kind, maxImports: () => maxImports };
}

async function check(name, fn) {
  if (process.env.REMOTE_UI_CASE && !name.includes(process.env.REMOTE_UI_CASE)) return;
  await fn();
  results.push({ name, passed: true });
  console.log('PASS', name);
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
}

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const port = await new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
  const { createServer } = await import('vite');
  const server = await createServer({
    configFile: path.resolve(__dirname, '../../apps/web/vite.config.ts'),
    root: path.resolve(__dirname, '../../apps/web'),
    cacheDir: path.resolve(__dirname, '../../.runtime/remote-files-vite-cache'),
    server: { port, host: '127.0.0.1', strictPort: true, open: false },
    plugins: [{ name: 'remote-sync-acceptance-entry', configureServer(server) { server.middlewares.use((request, response, next) => {
      if (request.url?.split('?')[0] !== '/__remote_sync_fixture_page') return next();
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end('<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><script type="module">import {mount} from "/__remote_sync_fixture";mount(new URLSearchParams(location.search).get("kind"));</script></body></html>');
    }); }, resolveId(id) { if (id === '/__remote_sync_fixture') return '\0remote-sync-acceptance-entry'; }, load(id) {
      if (id === '\0remote-sync-acceptance-entry') return `import {createApp,h,ref} from 'vue'; import {createPinia} from 'pinia'; import {createRouter,createMemoryHistory} from 'vue-router'; import '/src/assets/styles.css'; import RemoteFiles from '/src/components/StorageRemoteFiles.vue'; import ProjectSync from '/src/components/StorageProjectSync.vue'; export function mount(kind){const root=document.createElement('div');document.body.append(root);const visible=ref(true);window.__closeRemoteFixture=()=>visible.value=false;const router=createRouter({history:createMemoryHistory(),routes:[{path:'/',component:{render:()=>null}},{path:'/tasks',component:{render:()=>h('p','任务管理')}}]});createApp({render:()=>h(kind==='project'?ProjectSync:RemoteFiles,{modelValue:visible.value,'onUpdate:modelValue':v=>visible.value=v,config:window.__REMOTE_FIXTURE_CONFIG__})}).use(createPinia()).use(router).mount(root);}`;
    } }],
  });
  let browser;
  try {
    await server.listen();
    process.env.ACCEPTANCE_WEB_URL = `http://127.0.0.1:${port}`;
    ({ fixture, url } = require('./fixtures/admin-layout.cjs'));
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
    await check('文件夹和当前页可选择；多个目标逐项返回项目身份', async () => {
      const f = await setup(browser);
      try {
        const selectPage = f.dialog.getByRole('checkbox', { name: '全选当前页', exact: true });
        assert.equal(await selectPage.count(), 1, 'current page needs a select-all checkbox');
        await selectPage.locator('..').click();
        assert.equal(await f.dialog.getByRole('checkbox', { name: '选择 项目资料', exact: true }).isChecked(), true);
        await projects(f, ['合成项目', '交付项目']);
        await f.dialog.getByRole('textbox', { name: '目标目录', exact: true }).fill('云盘取回/资料');
        await f.dialog.getByRole('button', { name: '同步所选', exact: true }).click();
        await f.dialog.getByText('已同步 6 项（文件 × 项目）。', { exact: true }).waitFor();
        assert.deepEqual(importRequests(f).map(request => request.body), [
          { projectIds: ['project-one', 'project-two'], fileIds: ['file-a'], folderPath: '云盘取回/资料' },
          { projectIds: ['project-one', 'project-two'], fileIds: ['file-hash'], folderPath: '云盘取回/资料' },
          { projectIds: ['project-one', 'project-two'], fileIds: ['nested-file'], folderPath: '云盘取回/资料/项目资料' },
        ]);
        assert.equal(await f.dialog.locator('.remote-import-result li').count(), 6);
        await f.dialog.locator('.remote-import-result').getByText('合成项目', { exact: true }).first().waitFor();
        await f.dialog.locator('.remote-import-result').getByText('交付项目', { exact: true }).first().waitFor();
        assert.equal(f.maxImports(), 1);
        assert.deepEqual(f.errors, []);
      } finally { await f.context.close(); }
    });
    await check('当前目录递归读取所有分页并逐文件保留相对目录', async () => {
      const f = await setup(browser, { list: (route, location) => {
        const id = location.searchParams.get('parentId');
        if (id === 'folder-one') return route.fulfill({ json: { parentId: id, items: [file('deep', '深层.txt', { parentId: id })], nextCursor: null } });
        if (location.searchParams.get('cursor')) return route.fulfill({ json: { parentId: 'configured-root', items: [file('f20'), file('f0')], nextCursor: null } });
        return route.fulfill({ json: { parentId: 'configured-root', items: [folder, ...Array.from({ length: 20 }, (_, i) => file(`f${i}`))], nextCursor: 'page-two' } });
      } });
      try {
        await projects(f);
        await f.dialog.getByRole('button', { name: '同步当前目录', exact: true }).click();
        await f.dialog.getByText('已同步 22 项（文件 × 项目）。', { exact: true }).waitFor();
        assert.deepEqual(importRequests(f).map(request => ({ files: request.body.fileIds, folder: request.body.folderPath, projects: request.body.projectIds })), [
          ...Array.from({ length: 21 }, (_, i) => ({ files: [`f${i}`], folder: undefined, projects: ['project-one'] })),
          { files: ['deep'], folder: '项目资料', projects: ['project-one'] },
        ]);
        assert.equal(cloudListRequests(f).length, 26, 'opening, complete discovery and immediate per-file snapshot refresh all read their pages');
        assert.equal(f.maxImports(), 1);
        assert.deepEqual(f.errors, []);
      } finally { await f.context.close(); }
    });
    await check('目录第二页失败不会导入半份列表，重试保留所选目录与目标', async () => {
      let failed = false;
      const f = await setup(browser, { list: (route, location) => {
        if (location.searchParams.get('parentId') !== 'folder-one') return route.fulfill({ json: rootPage });
        if (location.searchParams.get('cursor')) {
          if (!failed) { failed = true; return route.fulfill({ status: 503, json: { message: '目录第二页读取失败' } }); }
          return route.fulfill({ json: { parentId: 'folder-one', items: [file('child-b', 'B.txt', { parentId: 'folder-one' })], nextCursor: null } });
        }
        return route.fulfill({ json: { parentId: 'folder-one', items: [file('child-a', 'A.txt', { parentId: 'folder-one' })], nextCursor: 'next-child' } });
      } });
      try {
        await choose(f.dialog, '项目资料'); await projects(f);
        await f.dialog.getByRole('button', { name: '同步所选', exact: true }).click();
        await f.dialog.getByText('目录第二页读取失败', { exact: true }).waitFor();
        assert.equal(importRequests(f).length, 0);
        assert.equal(await f.dialog.getByRole('checkbox', { name: '选择 项目资料', exact: true }).isChecked(), true);
        await f.dialog.getByRole('button', { name: '重试未完成项', exact: true }).click();
        await f.dialog.getByText('已同步 2 项（文件 × 项目）。', { exact: true }).waitFor();
        assert.deepEqual(importRequests(f).map(request => request.body), [
          { projectIds: ['project-one'], fileIds: ['child-a'], folderPath: '项目资料' },
          { projectIds: ['project-one'], fileIds: ['child-b'], folderPath: '项目资料' },
        ]);
        assert.deepEqual(f.errors, []);
      } finally { await f.context.close(); }
    });
    await check('循环分页明确中止并且不发起导入', async () => {
      const f = await setup(browser, { list: route => route.fulfill({ json: { parentId: 'configured-root', items: [file('a')], nextCursor: 'same' } }) });
      try {
        await projects(f); await f.dialog.getByRole('button', { name: '同步当前目录', exact: true }).click();
        await f.dialog.getByText(/云盘分页标记重复/).waitFor();
        assert.equal(importRequests(f).length, 0);
        assert.equal(f.requests.filter(request => request.method === 'GET').length, 3);
        assert.equal(await f.dialog.getByRole('button', { name: '重试未完成项', exact: true }).isEnabled(), true);
        assert.deepEqual(f.errors, []);
      } finally { await f.context.close(); }
    });
    await check('部分目标失败只重试失败的文件项目组合', async () => {
      const f = await setup(browser, { importResult: (body, count) => {
        const items = body.fileIds.flatMap(id => body.projectIds.map(projectId => ({ id, name: id, projectId, projectName: projectId === 'project-one' ? '合成项目' : '交付项目', status: count === 1 && projectId === 'project-two' ? 'FAILED' : 'IMPORTED', ...(count === 1 && projectId === 'project-two' ? { error: '目标项目空间不足' } : { fileId: 'local' }) })));
        return { imported: items.filter(item => item.status === 'IMPORTED').length, failed: items.filter(item => item.status === 'FAILED').length, items };
      } });
      try {
        await choose(f.dialog, longName); await projects(f, ['合成项目', '交付项目']);
        await f.dialog.getByRole('button', { name: '同步所选', exact: true }).click();
        await f.dialog.getByText('已同步 1 项（文件 × 项目），1 项失败。', { exact: true }).waitFor();
        await f.dialog.getByText('目标项目空间不足', { exact: true }).waitFor();
        await f.dialog.getByRole('button', { name: '重试未完成项', exact: true }).click();
        await f.dialog.getByText('已同步 2 项（文件 × 项目）。', { exact: true }).waitFor();
        assert.deepEqual(importRequests(f).map(request => request.body.projectIds), [['project-one', 'project-two'], ['project-two']]);
        assert.equal(await f.dialog.locator('.remote-import-result li').count(), 2);
        assert.deepEqual(f.errors, []);
      } finally { await f.context.close(); }
    });
    await check('同步中显示完成总数并阻止关闭和重复操作', async () => {
      let release;
      const holdImport = new Promise(resolve => { release = resolve; });
      const f = await setup(browser, { holdImport });
      try {
        await choose(f.dialog, longName); await projects(f, ['合成项目', '交付项目']);
        await f.dialog.getByRole('button', { name: '同步所选', exact: true }).click();
        await f.dialog.getByText('同步进度：完成 0 / 2 项（文件 × 项目）。', { exact: true }).waitFor();
        const progress = f.dialog.getByRole('progressbar', { name: '云盘同步进度', exact: true });
        assert.equal(await progress.getAttribute('value'), '0'); assert.equal(await progress.getAttribute('max'), '2');
        assert.equal(await f.dialog.getByRole('button', { name: '关闭', exact: true }).isDisabled(), true);
        assert.equal(await f.dialog.getByRole('button', { name: '同步所选', exact: true }).isDisabled(), true);
        assert.equal(await f.dialog.getByRole('button', { name: '同步当前目录', exact: true }).isDisabled(), true);
        const downloadButtons = f.dialog.getByRole('button', { name: '下载', exact: true });
        for (const button of await downloadButtons.all()) assert.equal(await button.isDisabled(), true, 'downloads cannot start while the per-user transfer slot is active');
        await f.page.keyboard.press('Escape'); assert.equal(await f.dialog.isVisible(), true);
        assert.equal(importRequests(f).length, 1);
        release(); await f.dialog.getByText('已同步 2 项（文件 × 项目）。', { exact: true }).waitFor();
        assert.deepEqual(f.errors, []);
      } finally { release(); await f.context.close(); }
    });
    await check('请求中断保留选择且可重试未完成批次', async () => {
      const f = await setup(browser, { failImportFirst: true });
      try {
        await choose(f.dialog, longName); await projects(f);
        await f.dialog.getByRole('button', { name: '同步所选', exact: true }).click();
        await f.dialog.getByText('云盘读取中断，请重试。', { exact: true }).waitFor();
        assert.equal(await f.dialog.getByRole('checkbox', { name: `选择 ${longName}`, exact: true }).isChecked(), true);
        await f.dialog.getByRole('button', { name: '重试未完成项', exact: true }).click();
        await f.dialog.getByText('已同步 1 项（文件 × 项目）。', { exact: true }).waitFor();
        assert.equal(importRequests(f).length, 2);
        assert.deepEqual(f.errors, []);
      } finally { await f.context.close(); }
    });
    await check('长任务的后续批次和失败重试都会刷新源分页快照', async () => {
      let fresh = false, clock = 0, listedAt = -Infinity;
      const files = Array.from({ length: 21 }, (_, i) => file(`f${i}`, `文件${i}.txt`));
      const f = await setup(browser, {
        list: route => { fresh = true; listedAt = clock; return route.fulfill({ json: { parentId: 'configured-root', items: files, nextCursor: null } }); },
        importResult: (body, count) => {
          const expired = !fresh || clock - listedAt > 300000;
          fresh = false; clock += 360001;
          const failed = expired || count === 1;
          const items = body.fileIds.flatMap(id => body.projectIds.map(projectId => ({ id, name: id, projectId, status: failed ? 'FAILED' : 'IMPORTED', ...(failed ? { error: expired ? '云盘快照已过期' : '目标暂时不可写' } : { fileId: `local-${id}` }) })));
          return { imported: failed ? 0 : items.length, failed: failed ? items.length : 0, items };
        },
      });
      try {
        await f.dialog.getByRole('checkbox', { name: '全选当前页', exact: true }).locator('..').click();
        await projects(f); await f.dialog.getByRole('button', { name: '同步所选', exact: true }).click();
        await f.dialog.getByText('已同步 20 项（文件 × 项目），1 项失败。', { exact: true }).waitFor();
        assert.equal(await f.dialog.getByText('云盘快照已过期', { exact: true }).count(), 0);
        await f.dialog.getByRole('button', { name: '重试未完成项', exact: true }).click();
        await f.dialog.getByText('已同步 21 项（文件 × 项目）。', { exact: true }).waitFor();
        assert.deepEqual(f.requests.filter(request => !request.path.includes('/jobs/')).map(request => request.method), ['GET', ...Array.from({ length: 22 }, () => ['GET', 'POST']).flat()]);
        assert.deepEqual(importRequests(f).map(request => request.body.fileIds.length), Array(22).fill(1));
        assert.deepEqual(f.errors, []);
      } finally { await f.context.close(); }
    });
    await check('源文件删除或变化阻止导入，原业务目录安全保留', async () => {
      for (const changed of ['missing', 'size']) {
        const f = await setup(browser, { list: (route, _location, count) => route.fulfill({ json: { parentId: 'configured-root', items: count > 1
          ? changed === 'missing' ? [] : [file('source', '原始.txt', { size: 2048 })]
          : [file('source', '原始.txt')], nextCursor: null } }) });
        try {
          await choose(f.dialog, '原始.txt'); await projects(f);
          await f.dialog.getByRole('button', { name: '同步所选', exact: true }).click();
          await f.dialog.getByText(changed === 'missing' ? /不存在或分页位置已变化/ : /已变化，请刷新列表/).waitFor();
          assert.equal(importRequests(f).length, 0);
          assert.equal(await f.dialog.getByRole('checkbox', { name: '选择 原始.txt', exact: true }).isChecked(), true);
          assert.deepEqual(f.errors, []);
        } finally { await f.context.close(); }
      }
      const metadata = await setup(browser, { list: route => route.fulfill({ json: { parentId: 'configured-root', items: [file('source', '原始.txt', { folderPath: '业务/指南' })], nextCursor: null } }) });
      try {
        await choose(metadata.dialog, '原始.txt'); await projects(metadata);
        await metadata.dialog.getByRole('textbox', { name: '目标目录', exact: true }).fill('取回');
        await metadata.dialog.getByRole('button', { name: '同步所选', exact: true }).click();
        await metadata.dialog.getByText('已同步 1 项（文件 × 项目）。', { exact: true }).waitFor();
        assert.equal(importRequests(metadata)[0].body.folderPath, '取回/业务/指南');
        assert.deepEqual(metadata.errors, []);
      } finally { await metadata.context.close(); }
    });
    await check('320和390px完整原名与来源项目可见，分页与目录返回正常', async () => {
      for (const width of [320, 390]) {
        const f = await setup(browser, { width });
        try {
          const title = f.dialog.getByText(longName, { exact: true }); await title.waitFor();
          const dimensions = await title.evaluate(element => ({ body: document.documentElement.scrollWidth, viewport: innerWidth, width: element.clientWidth, content: element.scrollWidth, height: element.clientHeight, line: parseFloat(getComputedStyle(element).lineHeight) }));
          assert.ok(dimensions.body <= width + 1, JSON.stringify(dimensions));
          assert.ok(dimensions.content <= dimensions.width + 1, JSON.stringify(dimensions));
          assert.ok(dimensions.height > dimensions.line, 'full original name must wrap');
          await f.dialog.getByText('所属项目：云端来源项目（source-project）', { exact: true }).waitFor();
          await f.dialog.getByText('未获取到原文件名，显示云端名称。', { exact: true }).waitFor();
          assert.equal(f.requests.length, 1);
          await f.dialog.getByRole('button', { name: '加载更多', exact: true }).click();
          await f.dialog.getByText('下一页.txt', { exact: true }).waitFor();
          await f.dialog.getByRole('button', { name: '打开文件夹 项目资料', exact: true }).click();
          await f.dialog.getByText('目录内文件.txt', { exact: true }).waitFor();
          await f.dialog.getByRole('button', { name: '返回上级目录', exact: true }).click(); await title.waitFor();
          const download = f.dialog.locator('.remote-file-row').filter({ hasText: longName }).getByRole('button', { name: '下载', exact: true });
          assert.equal(await download.isEnabled(), true);
          assert.equal(await f.dialog.getByRole('link', { name: '保存已校验文件', exact: true }).count(), 0);
          await f.dialog.screenshot({ path: path.join(output, `remote-files-${width}.png`) });
          assert.deepEqual(f.errors, []);
        } finally { await f.context.close(); }
      }
    });
    await check('空目录和无目标项目提供状态且不发送导入', async () => {
      const f = await setup(browser, { empty: true, projects: [] });
      try {
        await f.dialog.getByText('此目录暂无文件。', { exact: true }).waitFor();
        await f.dialog.getByText('暂无可管理的启用项目；仍可下载文件或导入系统备份。', { exact: true }).waitFor();
        assert.equal(await f.dialog.getByRole('button', { name: '同步所选', exact: true }).isDisabled(), true);
        assert.equal(await f.dialog.getByRole('button', { name: '同步当前目录', exact: true }).isDisabled(), true);
        await f.dialog.getByRole('button', { name: '刷新列表', exact: true }).click(); await idle(f);
        assert.ok(f.requests.every(request => request.method === 'GET'));
        assert.deepEqual(f.errors, []);
      } finally { await f.context.close(); }
      const empty = await setup(browser, { empty: true });
      try {
        await projects(empty); await empty.dialog.getByRole('button', { name: '同步当前目录', exact: true }).click();
        await empty.dialog.getByText('当前目录及子目录没有可同步的文件。', { exact: true }).waitFor();
        assert.equal(importRequests(empty).length, 0);
      } finally { await empty.context.close(); }
    });
    await check('项目和云端列表错误可重试且不会误报为空目录', async () => {
      const f = await setup(browser, { failFirst: true, failProjectsFirst: true });
      try {
        await f.dialog.getByText('云盘连接暂时不可用', { exact: true }).waitFor();
        await f.dialog.getByText('项目读取失败', { exact: true }).waitFor();
        assert.equal(await f.dialog.getByText('此目录暂无文件。', { exact: true }).count(), 0);
        await f.dialog.getByRole('button', { name: '重试列表', exact: true }).click(); await f.dialog.getByText(longName, { exact: true }).waitFor();
        await f.dialog.getByRole('button', { name: '重试项目', exact: true }).click(); await projects(f);
        assert.equal(importRequests(f).length, 0);
        assert.deepEqual(f.errors, []);
      } finally { await f.context.close(); }
    });
    await check('选择超过20文件仍可分批，目标最多20项且过滤无权限项目', async () => {
      const f = await setup(browser, { projects: [
        ...Array.from({ length: 21 }, (_, i) => ({ id: `p${i}`, name: `目标${i}`, enabled: true, canManage: true })),
        { id: 'forbidden', name: '无权限项目', enabled: true, canManage: false },
      ], list: route => route.fulfill({ json: { parentId: 'configured-root', items: Array.from({ length: 21 }, (_, i) => file(`f${i}`)), nextCursor: null } }) });
      try {
        await f.dialog.getByRole('checkbox', { name: '全选当前页', exact: true }).locator('..').click();
        assert.equal(await f.dialog.getByRole('checkbox', { name: '选择 f20.txt', exact: true }).isChecked(), true);
        await projects(f, Array.from({ length: 20 }, (_, i) => `目标${i}`));
        await f.dialog.getByRole('combobox', { name: '目标项目', exact: true }).focus();
        await f.dialog.getByRole('combobox', { name: '目标项目', exact: true }).press('ArrowDown');
        assert.equal(await f.page.getByRole('option', { name: '目标20', exact: true }).getAttribute('aria-disabled'), 'true');
        assert.equal(await f.page.getByRole('option', { name: '无权限项目', exact: true }).count(), 0);
        await f.page.keyboard.press('Escape');
        await f.dialog.getByRole('button', { name: '同步所选', exact: true }).click();
        await f.dialog.getByText('已同步 420 项（文件 × 项目）。', { exact: true }).waitFor();
        assert.deepEqual(importRequests(f).map(request => request.body.fileIds.length), Array(21).fill(1));
        assert.equal(f.maxImports(), 1);
        assert.deepEqual(f.errors, []);
      } finally { await f.context.close(); }
    });
    await check('单文件系统备份导入无需项目且不会恢复数据', async () => {
      const f = await setup(browser, { projects: [] });
      try {
        await f.dialog.locator('.remote-file-row').filter({ hasText: longName }).getByRole('button', { name: '作为系统备份导入', exact: true }).click();
        await f.dialog.getByText('已导入 1 份系统备份。', { exact: true }).waitFor();
        assert.deepEqual(importRequests(f)[0].body, { fileIds: ['file-a'], asBackup: true });
        assert.ok(f.requests.every(request => !request.path.includes('/restore')));
        assert.deepEqual(f.errors, []);
      } finally { await f.context.close(); }
    });
    await check('后台取回RUNNING期间保持进度与锁定，完成后才显示逐项目结果', async () => {
      const f = await setup(browser, { runningPolls: 2 });
      try {
        await choose(f.dialog, longName); await projects(f);
        await f.dialog.getByRole('button', { name: '同步所选', exact: true }).click();
        await f.dialog.getByText('同步进度：完成 0 / 1 项（文件 × 项目）。', { exact: true }).waitFor();
        assert.equal(await f.dialog.getByRole('button', { name: '关闭', exact: true }).isDisabled(), true);
        assert.equal(await f.dialog.locator('.remote-import-result').count(), 0);
        await f.dialog.getByText('已同步 1 项（文件 × 项目）。', { exact: true }).waitFor();
        assert.equal(importRequests(f).length, 1);
        assert.ok(importRequests(f)[0].path.endsWith('/import-jobs'));
        assert.equal(f.requests.filter(request => request.path.includes('/jobs/')).length, 3);
        assert.ok(f.requests.every(request => !request.path.endsWith('/import')));
        assert.deepEqual(f.errors, []);
      } finally { await f.context.close(); }
    });
    await check('后台查询失联保留任务编号，继续查询不重新读源页或提交', async () => {
      const f = await setup(browser, { failPollFirst: true, list: (route, _location, count) => count > 2
        ? route.fulfill({ status: 503, json: { message: '源目录此时不可用' } }) : route.fulfill({ json: rootPage }) });
      try {
        await choose(f.dialog, longName); await projects(f);
        await f.dialog.getByRole('button', { name: '同步所选', exact: true }).click();
        await f.dialog.getByText('连接暂时中断，任务仍可能在后台处理中。请继续查询未完成任务，避免重复提交。', { exact: true }).waitFor();
        assert.equal(await f.dialog.getByRole('button', { name: '同步所选', exact: true }).isDisabled(), true);
        assert.equal(importRequests(f).length, 1);
        await f.dialog.getByRole('button', { name: '重试未完成项', exact: true }).click();
        await f.dialog.getByText('已同步 1 项（文件 × 项目）。', { exact: true }).waitFor();
        assert.equal(importRequests(f).length, 1);
        assert.equal(cloudListRequests(f).length, 2);
        assert.deepEqual(f.requests.filter(request => request.path.includes('/jobs/')).map(request => request.path), [
          '/api/storage-configs/cloud/remote-files/jobs/job-1', '/api/storage-configs/cloud/remote-files/jobs/job-1',
        ]);
        assert.deepEqual(f.errors, []);
      } finally { await f.context.close(); }
    });
    await check('后台任务过期和提交未确认均明确提示并只按手动操作重试', async () => {
      for (const option of [{ expireFirst: true }, { failStartFirst: true }]) {
        const f = await setup(browser, option);
        try {
          await choose(f.dialog, longName); await projects(f);
          await f.dialog.getByRole('button', { name: '同步所选', exact: true }).click();
          await f.dialog.getByText(option.expireFirst ? '后台任务已过期或服务已重启，请重新提交。' : /请求可能已提交，请稍后重试/).waitFor();
          assert.equal(importRequests(f).length, 1);
          assert.equal(await f.dialog.getByRole('checkbox', { name: `选择 ${longName}`, exact: true }).isChecked(), true);
          await f.dialog.getByRole('button', { name: '重试未完成项', exact: true }).click();
          await f.dialog.getByText('已同步 1 项（文件 × 项目）。', { exact: true }).waitFor();
          assert.equal(importRequests(f).length, 2);
          assert.deepEqual(f.errors, []);
        } finally { await f.context.close(); }
      }
    });
    await check('下载先后台校验，完成后手动保存且就绪链接只消费一次', async () => {
      let release;
      const holdImport = new Promise(resolve => { release = resolve; });
      const f = await setup(browser, { holdImport });
      try {
        const row = f.dialog.locator('.remote-file-row').filter({ hasText: longName });
        await row.getByRole('button', { name: '下载', exact: true }).click();
        await f.dialog.getByText('正在后台取回并校验下载文件，完成后可保存到本地。', { exact: true }).waitFor();
        assert.equal(await f.dialog.getByRole('button', { name: '关闭', exact: true }).isDisabled(), true);
        assert.equal(await row.getByRole('link', { name: '保存已校验文件', exact: true }).count(), 0);
        assert.equal(f.requests.filter(request => request.path.endsWith('/download')).length, 0);
        release();
        const link = row.getByRole('link', { name: '保存已校验文件', exact: true }); await link.waitFor();
        assert.equal(await link.getAttribute('href'), '/api/storage-configs/cloud/remote-files/jobs/job-1/download');
        assert.equal(await link.getAttribute('rel'), 'noopener noreferrer');
        assert.equal(f.requests.filter(request => request.path.endsWith('/download')).length, 0, 'ready files must not auto-consume their one-time URL');
        const downloads = [];
        f.page.on('download', download => downloads.push(download));
        f.context.on('page', popup => popup.on('download', download => downloads.push(download)));
        await link.click();
        await f.page.waitForTimeout(500);
        assert.equal(f.requests.filter(request => request.path.endsWith('/download')).length, 1, JSON.stringify({ requests: f.requests.map(request => request.path), pages: f.context.pages().map(page => page.url()) }));
        assert.equal(downloads.length, 1, 'the verified one-time stream should produce one browser download');
        assert.equal(await downloads[0].failure(), null);
        await row.getByRole('button', { name: '下载', exact: true }).waitFor();
        assert.equal(importRequests(f).length, 1);
        assert.ok(importRequests(f)[0].path.endsWith('/file-a/download-jobs'));
        assert.deepEqual(f.errors, []);
      } finally { release(); await f.context.close(); }
    });
    await check('下载查询失联继续同一任务，校验失败可手动重新准备', async () => {
      for (const option of [{ failPollFirst: true }, { failDownloadFirst: true }]) {
        const f = await setup(browser, option);
        try {
          const row = f.dialog.locator('.remote-file-row').filter({ hasText: longName });
          await row.getByRole('button', { name: '下载', exact: true }).click();
          await f.dialog.getByText(option.failPollFirst ? /连接暂时中断，任务仍可能在后台处理中/ : '云端下载校验失败，请重试。').waitFor();
          assert.equal(await row.getByRole('link', { name: '保存已校验文件', exact: true }).count(), 0);
          await f.dialog.getByRole('button', { name: '重试未完成项', exact: true }).click();
          await row.getByRole('link', { name: '保存已校验文件', exact: true }).waitFor();
          assert.equal(importRequests(f).length, option.failPollFirst ? 1 : 2);
          assert.equal(f.requests.filter(request => request.path.endsWith('/download')).length, 0);
          assert.deepEqual(f.errors, []);
        } finally { await f.context.close(); }
      }
    });
    await check('父页面关闭时停止短轮询，后台任务无需取消也不会重新提交', async () => {
      let release;
      const holdImport = new Promise(resolve => { release = resolve; });
      const f = await setup(browser, { holdImport });
      try {
        await choose(f.dialog, longName); await projects(f);
        await f.dialog.getByRole('button', { name: '同步所选', exact: true }).click();
        await f.dialog.getByText('同步进度：完成 0 / 1 项（文件 × 项目）。', { exact: true }).waitFor();
        await f.page.waitForTimeout(100);
        await f.page.evaluate(() => window.__closeRemoteFixture());
        await f.dialog.waitFor({ state: 'hidden' });
        const polls = f.requests.filter(request => request.path.includes('/jobs/')).length;
        await f.page.waitForTimeout(1300);
        assert.equal(f.requests.filter(request => request.path.includes('/jobs/')).length, polls);
        assert.equal(importRequests(f).length, 1);
        assert.ok(f.requests.every(request => request.method !== 'DELETE'));
        assert.deepEqual(f.errors, []);
      } finally { release(); await f.context.close(); }
    });
    await check('上传同步单选多选发送所选项目并显示排队结果与任务链接', async () => {
      for (const names of [['合成项目'], ['合成项目', '交付项目']]) {
        const f = await setup(browser, { kind: 'project' });
        try {
          await projects(f, names);
          await f.dialog.getByRole('button', { name: '上传并按项目整理', exact: true }).click();
          await f.dialog.getByText(`已为 ${names.length} 个项目提交同步任务。`, { exact: true }).waitFor();
          assert.deepEqual(importRequests(f)[0], { method: 'POST', path: '/api/storage-configs/cloud/project-sync', params: {}, body: { projectIds: names.length === 1 ? ['project-one'] : ['project-one', 'project-two'] } });
          assert.equal(await f.dialog.locator('.project-sync-result li').count(), names.length);
          await f.dialog.getByText('3 个已有副本将重新整理', { exact: false }).first().waitFor();
          const tasks = f.dialog.getByRole('link', { name: '查看同步任务', exact: true });
          assert.equal(await tasks.getAttribute('href'), '/tasks');
          await tasks.click(); await f.dialog.waitFor({ state: 'hidden' });
          assert.deepEqual(f.errors, []);
        } finally { await f.context.close(); }
      }
    });
    await check('上传同步只列出已分配启用且可管理项目，无项目禁用提交', async () => {
      const f = await setup(browser, { kind: 'project', config: { id: 'cloud', name: '合成云盘', projects: [{ id: 'project-one' }, { id: 'forbidden' }, { id: 'disabled' }] }, projects: [
        { id: 'project-one', name: '合成项目', enabled: true, canManage: true },
        { id: 'unassigned', name: '未分配项目', enabled: true, canManage: true },
        { id: 'disabled', name: '禁用项目', enabled: false, canManage: true },
        { id: 'forbidden', name: '无权限项目', enabled: true, canManage: false },
      ] });
      try {
        await projects(f);
        const select = f.dialog.getByRole('combobox', { name: '要同步的项目', exact: true }); await select.focus(); await select.press('ArrowDown');
        assert.equal(await f.page.getByRole('option').count(), 1);
        assert.equal(importRequests(f).length, 0);
        assert.deepEqual(f.errors, []);
      } finally { await f.context.close(); }
      const empty = await setup(browser, { kind: 'project', projects: [] });
      try {
        await empty.dialog.getByText('暂无可同步的启用项目，请先在存储配置中分配项目。', { exact: true }).waitFor();
        assert.equal(await empty.dialog.getByRole('button', { name: '上传并按项目整理', exact: true }).isDisabled(), true);
        assert.equal(importRequests(empty).length, 0);
        assert.deepEqual(empty.errors, []);
      } finally { await empty.context.close(); }
    });
    await check('上传同步列表与提交错误可重试，失败保留已选项目', async () => {
      const f = await setup(browser, { kind: 'project', failProjectsFirst: true, failImportFirst: true });
      try {
        await f.dialog.getByText('项目读取失败', { exact: true }).waitFor();
        await f.dialog.getByRole('button', { name: '重试', exact: true }).click();
        await projects(f);
        await f.dialog.getByRole('button', { name: '上传并按项目整理', exact: true }).click();
        await f.dialog.getByText('同步任务提交失败，请重试。', { exact: true }).waitFor();
        await f.dialog.getByText('已选 1 / 20 个项目', { exact: true }).waitFor();
        assert.equal(importRequests(f).length, 1);
        await f.dialog.getByRole('button', { name: '上传并按项目整理', exact: true }).click();
        await f.dialog.getByText('已为 1 个项目提交同步任务。', { exact: true }).waitFor();
        assert.equal(importRequests(f).length, 2);
        assert.deepEqual(f.errors, []);
      } finally { await f.context.close(); }
    });
    await check('上传同步390px长项目名称完整换行且提交时禁用关闭重复操作', async () => {
      const name = '跨部门交付设计素材与产品资料ABCDEFGHIJKLMNOPQRSTUVWXYZ-完整项目名称-最终确认版本';
      let release;
      const holdImport = new Promise(resolve => { release = resolve; });
      const f = await setup(browser, { kind: 'project', width: 390, holdImport, projects: [{ id: 'project-one', name, enabled: true, canManage: true }] });
      try {
        await projects(f, [name]);
        await f.dialog.getByRole('button', { name: '上传并按项目整理', exact: true }).click();
        assert.equal(await f.dialog.getByRole('button', { name: '关闭', exact: true }).isDisabled(), true);
        assert.equal(await f.dialog.getByRole('button', { name: '上传并按项目整理', exact: true }).isDisabled(), true);
        await f.page.keyboard.press('Escape'); assert.equal(await f.dialog.isVisible(), true);
        release();
        const title = f.dialog.locator('.project-sync-result').getByText(name, { exact: true }); await title.waitFor();
        const dimensions = await title.evaluate(element => ({ width: element.clientWidth, content: element.scrollWidth, body: document.documentElement.scrollWidth, height: element.clientHeight, line: parseFloat(getComputedStyle(element).lineHeight) || parseFloat(getComputedStyle(element).fontSize) * 1.2 }));
        assert.ok(dimensions.body <= 391, JSON.stringify(dimensions));
        assert.ok(dimensions.content <= dimensions.width + 1, JSON.stringify(dimensions));
        assert.ok(dimensions.height > dimensions.line, `complete project name should wrap: ${JSON.stringify(dimensions)}`);
        assert.equal(importRequests(f).length, 1);
        await f.dialog.screenshot({ path: path.join(output, 'project-sync-390.png') });
        assert.deepEqual(f.errors, []);
      } finally { release(); await f.context.close(); }
    });
  } finally {
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
    await browser?.close();
    await server.close();
  }
})().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
