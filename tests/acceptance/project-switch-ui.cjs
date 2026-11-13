// Real Vue routes and Element Plus; synthetic API fixtures only, no database/cloud writes.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/shifuf/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const base = process.env.ACCEPTANCE_WEB || 'http://localhost:5175';
if (!['localhost', '127.0.0.1'].includes(new URL(base).hostname)) throw new Error('Local test only');
let browser;
const now = '2026-11-13T00:00:00.000Z';
const projects = ['A', 'B', 'C'].map(id => ({ id, name: `项目${id}`, appId: `app-${id}`, description: `说明${id}`, canManage: true, allowedDomains: [], fileCount: 1, totalSize: 10, enabled: true, activeCdnName: `存储${id}`, createdAt: now, updatedAt: now }));
const profile = { id: 'fixture-user', username: 'fixture-admin', displayName: '隔离验收', role: 'SUPER_ADMIN', enabled: true, mustChangePassword: false };
function file(id) { return { id: `file-${id}`, projectId: id, originalName: `文件${id}.txt`, folderPath: null, tags: [], size: 10, category: 'DOCUMENT', cdnProvider: 'LOCAL', status: 'ACTIVE', previewable: false, currentVersion: 1, createdAt: now, updatedAt: now }; }
async function setup({ slow = [], failure = [], paginatedReplica = false, authExpiryOnce = false } = {}) {
  browser ||= await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  const context = await browser.newContext({ viewport: { width: 1500, height: 1100 } });
  await context.addInitScript(p => localStorage.setItem('ufm_user_profile', JSON.stringify(p)), profile);
  const page = await context.newPage();
  page.setDefaultTimeout(3500);
  const requests = [], errors = [], failed = [], gates = new Map();
  let sessionExpired = false, expiredChunk = false;
  for (const key of slow) gates.set(key, {});
  page.on('pageerror', e => errors.push(e.message));
  page.on('requestfailed', r => failed.push(new URL(r.url()).pathname));
  await page.route('**/api/**', async route => {
    const req = route.request(), url = new URL(req.url());
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const api = url.pathname.replace(/^\/api/, ''), id = url.searchParams.get('projectId') || api.split('/')[2];
    requests.push({ path: api, query: url.search, method: req.method(), body: req.headers()['content-type']?.includes('application/json') ? req.postDataJSON() : undefined });
    const key = api === '/files' ? `/files:${id}` : gates.has(`${api}:${req.method()}`) ? `${api}:${req.method()}` : api;
    if (gates.has(key)) await new Promise(resolve => { gates.get(key).release = resolve; });
    let data = [], status = 200;
    if (authExpiryOnce && api.endsWith('/fixture-upload/chunks/0') && !expiredChunk) { expiredChunk = true; sessionExpired = true; status = 401; data = { message: '登录过期' }; }
    else if (sessionExpired && (api === '/auth/refresh' || api === '/auth/profile')) { status = 401; data = { message: '登录过期' }; }
    else if (api === '/auth/login') { sessionExpired = false; data = { requiresTotp: false, user: profile }; }
    else if (failure.includes(key)) { status = 500; data = { message: `边界失败${id}` }; }
    else if (api === '/auth/profile') data = profile;
    else if (api === '/projects') data = projects;
    else if (api === '/notifications') data = { items: [], unreadCount: 0 };
    else if (api === '/version/check') data = { state: 'unavailable', currentVersion: '0.1.1' };
    else if (/^\/projects\/[ABC]$/.test(api)) data = projects.find(p => p.id === id);
    else if (api.endsWith('/stats')) data = { fileCount: 1, totalSize: { A: 111, B: 222, C: 333 }[id], duplicateCount: 0, uploadTrend: [], categoryBreakdown: [] };
    else if (api === '/files') data = { items: [file(id)], total: 1, page: 1, pageSize: Number(url.searchParams.get('pageSize')) || 20 };
    else if (api === `/projects/${id}/files` && req.method() === 'POST') data = [file(id)];
    else if (api.endsWith('/uploads/presign')) data = { supported: false };
    else if (api.endsWith('/uploads/init')) data = { uploadId: 'fixture-upload', received: [], totalChunks: req.postDataJSON().totalChunks };
    else if (api.endsWith('/uploads/fixture-upload/complete')) data = file(id);
    else if (api === '/files/file-A/shares' && req.method() === 'POST') data = { id: 'share-A', fileId: 'file-A', url: base + '/shares/synthetic', downloadUrl: base + '/api/shares/synthetic/download', enabled: true };
    else if (api.endsWith('/files/folders')) data = [`目录${id}`];
    else if (api.endsWith('/files/folder-tree')) data = [{ name: `目录${id}`, path: `目录${id}`, fileCount: 1, children: [] }];
    else if (api.endsWith('/folder-public')) data = [{ id: `policy-${id}`, projectId: id, folderPath: `目录${id}`, isPublic: true, createdAt: now, updatedAt: now }];
    else if (api.endsWith('/storage-configs')) data = [{ id: `config-${id}`, name: `存储${id}`, provider: 'LOCAL', active: true, enabled: true, config: {}, createdAt: now, updatedAt: now }];
    else if (api.endsWith('/hotspots')) data = { days: 7, byReferer: [], byFile: [] };
    else if (api.endsWith('/download-stats/summary')) data = { totalBytes: 0, totalCount: 0, successCount: 0, failedCount: 0, bySource: [], byFile: [] };
    else if (api.endsWith('/download-stats')) data = { items: [], total: 0 };
    else if (api.endsWith('/storage/replicas') && req.method() === 'GET') data = { items: [{ id: `replica-${id}${url.searchParams.has('cursor') ? '-more' : ''}`, configId: `config-${id}`, configName: `存储${id}`, provider: 'LOCAL', storageKey: url.searchParams.has('cursor') ? 'next-object' : `key-${id}`, size: '10', status: 'FAILED', attempts: 2, lastError: '校验失败', verifiedAt: null }], counts: { READY: 0, PENDING: 0, FAILED: paginatedReplica ? 2 : 1, MISSING: 0 }, nextCursor: paginatedReplica && !url.searchParams.has('cursor') ? 'list-next' : null };
    else if (/\/storage\/replicas\/(sync|inspect|retry)$/.test(api)) data = paginatedReplica ? { scanned: 20, queued: 20, ready: 19, failed: 1, nextCursor: req.postDataJSON().cursor ? null : 'batch-next' } : { queued: 1, nextCursor: null };
    try { await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) }); } catch { /* canceled reads close their route */ }
  });
  const navigate = target => page.evaluate(target => document.querySelector('#app').__vue_app__.config.globalProperties.$router.push(target), target);
  const release = key => gates.get(key)?.release?.();
  const releaseAll = () => gates.forEach(g => g.release?.());
  return { context, page, requests, errors, failed, navigate, release, releaseAll };
}
async function run(options, body) { const f = await setup(options); try { await body(f); assert.deepEqual(f.errors, []); } catch (error) { console.error(JSON.stringify({ errors: f.errors, requests: f.requests, url: f.page.url(), text: (await f.page.locator('body').innerText()).slice(0, 600) })); throw error; } finally { f.releaseAll(); await f.context.close(); } }
after(async () => browser?.close());

test('file list renders before its slow folder panel completes', () => run({ slow: ['/projects/A/files/folders', '/projects/A/files/folder-tree'] }, async ({ page, release }) => {
  await page.goto(base + '/files?projectId=A');
  await page.getByText('文件A.txt', { exact: true }).waitFor({ timeout: 2500 });
  // Element Plus keeps a fading mask for 300ms after loading is cleared.
  // Keep both folder responses blocked while waiting for that transition.
  await page.locator('.data-table .el-loading-mask').waitFor({ state: 'hidden', timeout: 2500 });
  assert.equal(await page.locator('.data-table .el-loading-mask').count(), 0);
  release('/projects/A/files/folders'); release('/projects/A/files/folder-tree');
  await page.locator('.folder-node').getByText('目录A', { exact: true }).waitFor();
}));

test('slow A to B to C files keep current rows and folders, abort reads and restore history', () => run({ slow: ['/files:A', '/projects/A/files/folder-tree'] }, async ({ page, navigate, release, requests, failed }) => {
  await page.goto(base + '/files?projectId=A');
  await page.getByRole('heading', { name: '文件管理', exact: true }).waitFor();
  await navigate('/files?projectId=B');
  await page.getByText('文件B.txt', { exact: true }).waitFor();
  await navigate('/files?projectId=C');
  await page.getByText('文件C.txt', { exact: true }).waitFor();
  release('/files:A'); release('/projects/A/files/folder-tree');
  await page.locator('.folder-node').getByText('目录C', { exact: true }).waitFor();
  assert.equal(await page.getByText('文件A.txt', { exact: true }).count(), 0);
  assert.equal(await page.getByText('目录A', { exact: true }).count(), 0);
  assert.equal(await page.locator('.el-message--error').count(), 0);
  assert.ok(failed.some(p => p === '/api/files'), 'outdated file read is canceled');
  assert.ok(!requests.some(r => r.path === '/auth/refresh'));
  await page.goBack();
  await page.getByText('文件B.txt', { exact: true }).waitFor();
  await page.goForward();
  await page.getByText('文件C.txt', { exact: true }).waitFor();
}));

test('reused project detail reacts to A B C and late stats cannot change C', () => run({ slow: ['/projects/A/stats', '/files:A'] }, async ({ page, navigate, release }) => {
  await page.goto(base + '/projects/A');
  await page.getByRole('heading', { name: '项目A', exact: true }).waitFor({ timeout: 2500 });
  await navigate('/projects/B');
  await page.getByRole('heading', { name: '项目B', exact: true }).waitFor({ timeout: 2500 });
  await navigate('/projects/C');
  await page.getByRole('heading', { name: '项目C', exact: true }).waitFor({ timeout: 2500 });
  release('/projects/A/stats'); release('/files:A');
  await page.getByText('文件C.txt', { exact: true }).waitFor();
  await page.getByText('333 B', { exact: true }).waitFor();
  assert.equal(await page.getByText('111 B', { exact: true }).count(), 0);
  await page.getByRole('button', { name: '管理文件', exact: true }).click();
  await page.waitForURL('**/files?projectId=C');
}));

test('failed project stats do not hide its current title or recent files', () => run({ failure: ['/projects/B/stats'] }, async ({ page }) => {
  await page.goto(base + '/projects/B');
  await page.getByRole('heading', { name: '项目B', exact: true }).waitFor({ timeout: 2500 });
  await page.getByText('文件B.txt', { exact: true }).waitFor({ timeout: 2500 });
}));

test('replica failures are visible and sync inspect retry target the displayed project', () => run({}, async ({ page, requests }) => {
  await page.goto(base + '/projects/C');
  const section = page.locator('section').filter({ has: page.locator('.section-title').filter({ hasText: /^存储副本$/ }) });
  await section.getByText('校验失败', { exact: true }).waitFor({ timeout: 2500 });
  for (const [name, action] of [['补同步', 'sync'], ['巡检', 'inspect'], ['重试失败', 'retry']]) {
    await section.getByRole('button', { name, exact: true }).click();
    await page.waitForFunction(action => [...document.querySelectorAll('.el-message')].some(e => e.textContent.includes('任务')), action);
    assert.ok(requests.some(r => r.path === `/projects/C/storage/replicas/${action}` && r.method === 'POST'));
  }
}));

test('selection and file dialogs clear on project switch, and a late storage dialog never reopens', () => run({ slow: ['/projects/A/storage-configs'] }, async ({ page, navigate, release, requests }) => {
  await page.goto(base + '/files?projectId=A');
  await page.getByText('文件A.txt', { exact: true }).waitFor();
  await page.locator('.data-table .el-table__body tr .el-checkbox').click();
  assert.equal(await page.getByRole('button', { name: '批量下载', exact: true }).isDisabled(), false);
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByRole('dialog', { name: '文件信息', exact: true }).waitFor();
  await navigate('/files?projectId=B');
  await page.getByText('文件B.txt', { exact: true }).waitFor();
  await page.getByRole('dialog', { name: '文件信息', exact: true }).waitFor({ state: 'hidden' });
  assert.equal(await page.getByRole('dialog', { name: '文件信息', exact: true }).isVisible(), false);
  assert.equal(await page.getByRole('button', { name: '批量下载', exact: true }).isDisabled(), true);
  await navigate('/files?projectId=A');
  await page.getByText('文件A.txt', { exact: true }).waitFor();
  const requested = page.waitForRequest('**/api/projects/A/storage-configs');
  await page.getByRole('button', { name: '复制到存储', exact: true }).click();
  await requested;
  assert.ok(requests.some(r => r.path === '/projects/A/storage-configs'));
  const completed = new Promise(resolve => {
    const done = req => {
      if (!req.url().endsWith('/api/projects/A/storage-configs')) return;
      page.off('requestfinished', done); page.off('requestfailed', done); resolve();
    };
    page.on('requestfinished', done); page.on('requestfailed', done);
  });
  await navigate('/files?projectId=C');
  await page.getByText('文件C.txt', { exact: true }).waitFor();
  release('/projects/A/storage-configs');
  await completed;
  await page.evaluate(() => new Promise(requestAnimationFrame));
  assert.equal(await page.getByRole('dialog', { name: '复制文件到其他存储', exact: true }).isVisible(), false, 'late storage response must not reopen the old file dialog');
}));

test('an in-flight mixed upload keeps its starting project and folder for later chunks', () => run({ slow: ['/projects/A/files'] }, async ({ page, navigate, release, requests }) => {
  await page.goto(base + '/files?projectId=A');
  await page.locator('.folder-node').getByText('目录A', { exact: true }).click();
  await page.getByText('文件A.txt', { exact: true }).waitFor();
  await page.locator('input[type=file]').first().setInputFiles([
    { name: 'small.txt', mimeType: 'text/plain', buffer: Buffer.from('small fixture') },
    { name: 'large.txt', mimeType: 'text/plain', buffer: Buffer.alloc(10 * 1024 * 1024 + 1, 65) },
  ]);
  await page.getByRole('progressbar').waitFor();
  await navigate('/files?projectId=B');
  await page.locator('.folder-node').getByText('目录B', { exact: true }).click();
  await page.getByText('文件B.txt', { exact: true }).waitFor();
  const bReads = requests.filter(r => r.path === '/files' && r.query.includes('projectId=B')).length;
  release('/projects/A/files');
  await page.getByText('文件上传完成。', { exact: true }).waitFor();
  const init = requests.find(r => r.path === '/projects/A/uploads/init');
  assert.ok(init, 'remaining chunks belong to the starting project');
  assert.equal(init.body.folderPath, '目录A', 'remaining upload uses the captured folder');
  assert.ok(!requests.some(r => r.path.startsWith('/projects/B/uploads')));
  assert.equal(requests.filter(r => r.path === '/files' && r.query.includes('projectId=B')).length, bReads, 'old upload must not reset or refresh current filters');
  assert.match(page.url(), /projectId=B/);
}));

test('replica list and repair actions continue with their own server cursors', () => run({ paginatedReplica: true }, async ({ page, requests }) => {
  await page.goto(base + '/projects/C');
  const section = page.locator('.replica-section');
  await section.getByText('key-C', { exact: true }).waitFor();
  await section.getByRole('button', { name: '加载更多副本', exact: true }).click();
  await section.getByText('next-object', { exact: true }).waitFor();
  assert.ok(requests.some(r => r.path === '/projects/C/storage/replicas' && r.query.includes('cursor=list-next')));
  assert.equal(await section.getByText('key-C', { exact: true }).count(), 1);
  await section.getByRole('button', { name: '补同步', exact: true }).click();
  await section.getByRole('button', { name: '继续补同步', exact: true }).waitFor();
  await section.getByText('本批次扫描 20 项，加入同步队列 20 项。仍有后续批次。', { exact: true }).waitFor();
  await section.getByRole('button', { name: '继续补同步', exact: true }).click();
  await section.getByRole('button', { name: '补同步', exact: true }).waitFor();
  const syncs = requests.filter(r => r.path === '/projects/C/storage/replicas/sync');
  assert.equal(syncs[0].body.cursor, undefined);
  assert.equal(syncs[1].body.cursor, 'batch-next');
  await section.getByRole('button', { name: '巡检', exact: true }).click();
  await section.getByRole('button', { name: '继续巡检', exact: true }).waitFor();
  await section.getByText('本批次巡检 20 项，就绪 19 项，失败 1 项。仍有后续批次。', { exact: true }).waitFor();
}));

test('paused upload survives route reuse and resumes later chunks in its starting project', () => run({ slow: ['/projects/A/uploads/fixture-upload/chunks/0'] }, async ({ page, navigate, release, requests }) => {
  await page.goto(base + '/files?projectId=A');
  await page.getByText('文件A.txt', { exact: true }).waitFor();
  const chunkRequested = page.waitForRequest('**/api/projects/A/uploads/fixture-upload/chunks/0');
  await page.locator('input[type=file]').first().setInputFiles({ name: 'pause.txt', mimeType: 'text/plain', buffer: Buffer.alloc(10 * 1024 * 1024 + 1, 66) });
  await chunkRequested;
  await page.getByRole('button', { name: '暂停上传', exact: true }).click();
  await navigate('/files?projectId=B');
  await page.getByText('文件B.txt', { exact: true }).waitFor();
  release('/projects/A/uploads/fixture-upload/chunks/0');
  await page.getByText('上传已暂停', { exact: true }).waitFor();
  assert.equal(requests.filter(r => r.path.endsWith('/chunks/1')).length, 0);
  await page.getByRole('button', { name: '继续上传', exact: true }).click();
  await page.getByText('文件上传完成。', { exact: true }).waitFor();
  assert.equal(requests.filter(r => r.path.endsWith('/uploads/init')).length, 1);
  assert.equal(requests.filter(r => r.path.startsWith('/projects/A/uploads/fixture-upload/chunks/')).length, 3);
  assert.ok(!requests.some(r => r.path.startsWith('/projects/B/uploads')));
}));

test('expired login retains the upload queue through login and resumes its existing plan', () => run({ authExpiryOnce: true }, async ({ page, navigate, requests }) => {
  await page.goto(base + '/files?projectId=A');
  await page.getByText('文件A.txt', { exact: true }).waitFor();
  await page.locator('input[type=file]').first().setInputFiles({ name: 'expired-session.txt', mimeType: 'text/plain', buffer: Buffer.alloc(10 * 1024 * 1024 + 1, 67) });
  await page.waitForURL(base + '/');
  await navigate({ name: 'login', query: { redirect: '/files?projectId=B' } });
  await page.locator('.el-form-item').filter({ hasText: '用户名' }).locator('input').fill('fixture-admin');
  await page.locator('.el-form-item').filter({ hasText: '密码' }).locator('input').fill('SyntheticBrowserFixture');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.waitForURL('**/files?projectId=B');
  await page.getByText('上传已暂停', { exact: true }).waitFor();
  await page.getByRole('button', { name: '继续上传', exact: true }).click();
  await page.getByText('文件上传完成。', { exact: true }).waitFor();
  assert.equal(requests.filter(r => r.path === '/auth/refresh').length, 1);
  assert.equal(requests.filter(r => r.path.endsWith('/uploads/init')).length, 1);
  assert.equal(requests.filter(r => r.path.endsWith('/fixture-upload/chunks/0')).length, 2);
  assert.equal(requests.filter(r => r.path.endsWith('/fixture-upload/chunks/1')).length, 1);
  assert.ok(!requests.some(r => r.path.startsWith('/projects/B/uploads')));
}));

test('late share creation never repopulates a new project dialog or dereferences cleared file state', () => run({ slow: ['/files/file-A/shares:POST'] }, async ({ page, navigate, release }) => {
  await page.goto(base + '/files?projectId=A');
  await page.getByText('文件A.txt', { exact: true }).waitFor();
  await page.getByRole('button', { name: '分享', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '创建分享', exact: true });
  const requested = page.waitForRequest(req => new URL(req.url()).pathname === '/api/files/file-A/shares' && req.method() === 'POST');
  await dialog.getByRole('button', { name: '创建分享', exact: true }).click();
  await requested;
  const responded = page.waitForResponse(response => new URL(response.url()).pathname === '/api/files/file-A/shares' && response.request().method() === 'POST');
  await navigate('/files?projectId=B');
  await page.getByText('文件B.txt', { exact: true }).waitFor();
  release('/files/file-A/shares:POST');
  await (await responded).finished();
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await dialog.waitFor({ state: 'hidden' });
}));
