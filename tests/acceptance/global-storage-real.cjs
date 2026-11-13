/* Real browser + local API + saved fixture project; saves existing assignments unchanged. */
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { chromium } = require('C:/Users/shifuf/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root = path.resolve(__dirname, '../..');
const env = Object.fromEntries(fs.readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/).filter(s => /^\w+=/.test(s)).map(s => { const i = s.indexOf('='); return [s.slice(0, i), s.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]; }));
const fixture = JSON.parse(fs.readFileSync(path.join(root, '.runtime/acceptance-20261113/cloud-mwezzz7u/results.json'), 'utf8'));
const api = 'http://localhost:3000/api', web = 'http://localhost:5175';
const out = path.join(root, '.runtime/acceptance-20261113/global-storage-real'); fs.mkdirSync(out, { recursive: true });
const report = { checkedAt: new Date().toISOString(), checks: [], screenshots: [], actualAPI: true, retained: true };
let browser, context;
(async () => { try {
  browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  context = await browser.newContext({ viewport: { width: 1560, height: 1000 }, userAgent: 'UFM-Storage-Browser-Acceptance' });
  const page = await context.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(web + '/console-login');
  await page.locator('input[autocomplete="username"]').fill(env.ADMIN_USERNAME);
  await page.locator('input[autocomplete="current-password"]').fill(env.ADMIN_PASSWORD);
  await page.getByRole('button', { name: '登录', exact: true }).click(); await page.waitForURL('**/dashboard');
  await page.goto(web + '/storage-configs?projectId=' + fixture.projects[0].id);
  const row = page.locator('.el-table__body tr').filter({ hasText: '验收-全局绑定并发-' + fixture.run }); await row.waitFor();
  assert.equal(await page.locator('.admin-header .el-select').count(), 0);
  report.checks.push({ name: '真实全局页面不受旧项目query限制且无顶部项目选择器', passed: true });
  await page.screenshot({ path: path.join(out, 'global-storage.png'), fullPage: true }); report.screenshots.push(path.join(out, 'global-storage.png'));
  const before = await (await context.request.get(api + '/storage-configs/' + fixture.assignmentConcurrency.configId + '/projects')).json();
  for (const p of before) await row.getByText(p.name, { exact: true }).waitFor();
  await page.screenshot({ path: path.join(out, 'global-storage.png'), fullPage: true });
  await row.getByRole('button', { name: '分配项目', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '分配项目', exact: true });
  for (const p of before) { const checkbox = dialog.getByRole('checkbox', { name: p.name, exact: false }); await checkbox.waitFor({ state: 'attached' }); assert.equal(await checkbox.isChecked(), true); }
  await dialog.screenshot({ path: path.join(out, 'project-assignment.png') }); report.screenshots.push(path.join(out, 'project-assignment.png'));
  await dialog.getByRole('button', { name: '保存', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
  const after = await (await context.request.get(api + '/storage-configs/' + fixture.assignmentConcurrency.configId + '/projects')).json();
  assert.deepEqual(after.map(p => p.id).sort(), before.map(p => p.id).sort());
  report.checks.push({ name: '真实多项目绑定加载与保存', passed: true, count: after.length });
  const project = fixture.projects.find(p => p.purpose); await page.goto(web + '/projects/' + project.id);
  const section = page.locator('section.surface').filter({ has: page.locator('.section-title').filter({ hasText: /^存储配置$/ }) });
  await section.locator('.el-table__body tr').filter({ hasText: '全局-又拍云-shifuf-真实验收' }).waitFor();
  for (const name of ['全局-七牛云-shifuf-真实验收', '全局-又拍云-shifuf-真实验收']) {
    const target = section.locator('.el-table__body tr').filter({ hasText: name });
    const button = target.getByRole('button', { name: '设为当前', exact: true });
    if (!await button.isDisabled()) { await button.click(); await target.getByText('当前', { exact: true }).waitFor(); }
  }
  report.checks.push({ name: '真实项目绑定双云并能分别设为当前', passed: true });
  await section.screenshot({ path: path.join(out, 'project-target.png') }); report.screenshots.push(path.join(out, 'project-target.png'));
  assert.deepEqual(errors, []); report.checks.push({ name: '无浏览器运行异常', passed: true });
} catch (e) { report.error = e.message.replaceAll(env.ADMIN_PASSWORD, '[redacted]'); process.exitCode = 1; }
finally {
  if (context) { await context.request.post(web + '/api/auth/logout', { data: {} }).catch(() => {}); await context.close(); }
  await browser?.close(); fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} })();
