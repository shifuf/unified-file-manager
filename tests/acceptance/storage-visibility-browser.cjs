/* Real Chrome and application API; retains the new UI upload and all fixtures. */
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { chromium } = require('C:/Users/shifuf/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root = path.resolve(__dirname, '../..'), base = process.env.UFM_TEST_BASE || 'http://localhost:5175';
const latest = JSON.parse(fs.readFileSync(path.join(root, '.runtime/acceptance-20261114-storage-ui', base.startsWith('https:') ? 'public-latest.json' : 'local-latest.json'), 'utf8'));
const out = path.join(latest.out, 'browser'); fs.mkdirSync(out, { recursive: true });
const report = { base, actualAPI: true, retained: true, checks: [], screenshots: [] };
let browser, context;
const check = (name, evidence) => { report.checks.push({ name, pass: true, evidence }); console.log(JSON.stringify({ name, pass: true })); };
async function credentials() {
  if (process.env.UFM_TEST_AUTH_STDIN === '1') { let input = ''; for await (const chunk of process.stdin) input += chunk; return JSON.parse(input); }
  const env = Object.fromEntries(fs.readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/).filter(s => /^\w+=/.test(s)).map(s => { const i = s.indexOf('='); return [s.slice(0, i), s.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]; }));
  return { username: env.ADMIN_USERNAME, password: env.ADMIN_PASSWORD };
}
(async () => { try {
  const auth = await credentials();
  browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  context = await browser.newContext({ viewport: { width: 1560, height: 1000 }, userAgent: 'UFM-Storage-Visibility-Real-Browser' });
  const page = await context.newPage(), errors = [], failedAPI = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('response', r => { if (r.url().includes('/api/') && r.status() >= 500) failedAPI.push({ path: new URL(r.url()).pathname, status: r.status() }); });
  const navigate = target => page.evaluate(target => document.querySelector('#app').__vue_app__.config.globalProperties.$router.push(target), target);
  const screenshot = async name => { const file = path.join(out, name + '.png'); await page.screenshot({ path: file, fullPage: true }); report.screenshots.push(file); };
  await page.goto(base + '/console-login');
  await page.locator('input[autocomplete="username"]').fill(auth.username); await page.locator('input[autocomplete="current-password"]').fill(auth.password);
  await page.getByRole('button', { name: '登录', exact: true }).click(); await page.waitForURL('**/dashboard');
  await page.locator('.dashboard-metrics').waitFor(); await page.getByRole('heading', { name: '存储状态', exact: true }).waitFor();
  await page.locator('.storage-card').first().waitFor(); await screenshot('dashboard-desktop');
  check('真实概览显示核心指标、存储卡及活动区');
  await Promise.all([page.waitForResponse(r => r.url().includes('/dashboard/trends?days=30') && r.status() === 200), page.getByText('最近 30 天', { exact: true }).click()]);
  check('真实界面切换 30 天趋势');
  await page.setViewportSize({ width: 320, height: 820 });
  await page.waitForTimeout(350); await screenshot('dashboard-mobile');
  const dimensions = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
  assert.ok(dimensions.scroll <= dimensions.width + 2, 'mobile page overflow ' + JSON.stringify(dimensions));
  check('320px 概览可用且无整页横向溢出', dimensions);
  await page.setViewportSize({ width: 1560, height: 1000 }); await navigate('/projects/' + latest.project.id);
  await page.getByRole('heading', { name: latest.project.name, exact: true }).waitFor();
  for (const title of ['存储副本', '最近下载明细', '最近文件']) {
    const section = page.locator('section.surface').filter({ has: page.getByText(title, { exact: true }) });
    await section.locator('.el-pagination').waitFor();
    const routePath = title === '存储副本' ? '/api/projects/' + latest.project.id + '/storage/replicas' : title === '最近下载明细' ? '/api/projects/' + latest.project.id + '/download-stats' : '/api/files';
    const [response] = await Promise.all([page.waitForResponse(r => { const url = new URL(r.url()); return url.pathname === routePath && url.searchParams.get('page') === '2' && r.status() === 200; }), section.locator('.el-pagination li.number').filter({ hasText: /^2$/ }).click()]);
    const rows = (await response.json()).items;
    const bodyRows = section.locator('.el-table').last().locator('.el-table__body tbody tr');
    await bodyRows.nth(rows.length).waitFor({ state: 'detached' });
    await bodyRows.nth(rows.length - 1).waitFor();
    assert.equal(await section.locator('.el-pagination li.is-active').innerText(), '2');
    assert.equal(await bodyRows.count(), rows.length);
    await section.getByText(title === '存储副本' ? rows[0].storageKey : rows[0].originalName, { exact: true }).first().waitFor();
    check(title + '真实点击第二页有记录');
  }
  assert.equal(await page.getByRole('button', { name: '设为当前', exact: true }).count(), 0);
  await screenshot('project-three-pages');
  const other = (await (await context.request.get(base + '/api/projects')).json()).find(p => p.id !== latest.project.id);
  assert.ok(other);
  await navigate('/projects/' + other.id); await page.getByRole('heading', { name: other.name, exact: true }).waitFor();
  const delayed = '**/api/projects/' + latest.project.id;
  await page.route(delayed, async route => { try { const response = await route.fetch(); await new Promise(r => setTimeout(r, 1400)); await route.fulfill({ response }); } catch { /* superseded reads are expected to be aborted */ } });
  await navigate('/projects/' + latest.project.id); await page.waitForTimeout(150); await navigate('/projects/' + other.id);
  await page.getByRole('heading', { name: other.name, exact: true }).waitFor(); await page.waitForTimeout(1700);
  assert.equal(await page.getByRole('heading', { name: latest.project.name, exact: true }).count(), 0);
  await page.unroute(delayed); check('真实项目快速切换，受控迟到响应不替换当前项目');
  await navigate('/projects/' + latest.project.id); await page.getByRole('heading', { name: latest.project.name, exact: true }).waitFor();
  await page.getByRole('button', { name: '管理文件', exact: true }).click();
  await page.locator('.data-table .el-table__body tbody tr').first().waitFor();
  assert.equal(await page.getByText('复制到存储', { exact: true }).count(), 0);
  await page.locator('.data-table .el-table__body tbody tr').first().getByRole('button', { name: '详情', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '文件详情' }); await dialog.waitFor();
  await dialog.getByText('已上传', { exact: true }).nth(2).waitFor();
  assert.equal(await dialog.locator('.el-table__body tbody tr').count(), 3);
  const direct = await dialog.locator('input').first().inputValue(); assert.equal(new URL(direct).origin, base);
  check('文件详情真实显示三份已上传副本及统一入口', { direct });
  await screenshot('file-three-storage-details'); await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  const uploadName = '网页上传-多存储-' + Date.now().toString(36) + '.txt';
  const fixture = path.join(out, uploadName); fs.writeFileSync(fixture, '真实网页上传与 SPA 保留结果\n' + uploadName);
  await page.locator('input[type=file]').first().setInputFiles(fixture);
  const results = page.locator('.upload-results'); await results.getByText(uploadName, { exact: true }).waitFor({ timeout: 120000 });
  await results.getByRole('button', { name: '详情', exact: true }).click(); await dialog.waitFor();
  await dialog.getByText('已上传', { exact: true }).nth(2).waitFor({ timeout: 240000 });
  const fileResponse = await context.request.get(base + '/api/files?projectId=' + latest.project.id + '&keyword=' + encodeURIComponent(uploadName));
  const files = (await fileResponse.json()).items; assert.equal(files.length, 1);
  report.upload = { id: files[0].id, name: uploadName, fixturePath: fixture }; check('真实网页上传，详情观察三份副本完成', report.upload);
  await dialog.getByRole('button', { name: '关闭', exact: true }).click(); await navigate('/projects');
  await page.getByRole('heading', { name: '项目管理', exact: true }).waitFor(); await navigate('/files?projectId=' + latest.project.id);
  await results.getByText(uploadName, { exact: true }).waitFor(); check('页面内切换后上传结果及源项目仍保留');
  await screenshot('retained-upload-results');
  assert.deepEqual(errors, []); assert.deepEqual(failedAPI, []); check('实际页面无未处理 JS 异常和 API 500');
  report.counts = { passed: report.checks.length, failed: 0 };
} catch (e) { report.error = e.message; report.counts = { passed: report.checks.length, failed: 1 }; process.exitCode = 1; }
finally {
  report.sessionLoggedOut = !context;
  if (context) {
    try {
      const logout = await context.request.post(base + '/api/auth/logout', { data: {}, timeout: 10000 });
      assert.equal(logout.status(), 200);
      report.sessionLoggedOut = true;
    } catch { process.exitCode = 1; }
  }
  await browser?.close();
  report.counts = { passed: report.checks.length, failed: Number(Boolean(report.error)) + Number(!report.sessionLoggedOut) };
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ out, counts: report.counts, error: report.error, sessionLoggedOut: report.sessionLoggedOut }));
} })();
