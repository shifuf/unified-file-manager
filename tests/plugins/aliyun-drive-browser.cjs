const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseEnv } = require('node:util');
const { chromium } = require('C:/Users/shifuf/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root = path.resolve(__dirname, '../..');
const env = parseEnv(fs.readFileSync(path.join(root, '.env'), 'utf8'));
const base = 'http://127.0.0.1:5175';
async function main() {
  const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  const errors = [], page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  try {
    const login = await context.request.post(base + '/api/auth/login', { data: { username: env.ADMIN_USERNAME, password: env.ADMIN_PASSWORD } });
    assert.equal(login.status(), 201, 'local administrator login succeeds');
    await page.goto(base + '/storage-configs');
    await page.getByRole('heading', { name: '存储配置', exact: true }).waitFor();
    await page.getByRole('button', { name: '新建全局配置' }).click();
    const dialog = page.getByRole('dialog', { name: '新建存储配置', exact: true });
    const platform = dialog.locator('.el-form-item').filter({ has: page.locator('label').filter({ hasText: /^平台$/ }) });
    await platform.locator('.el-select').click();
    await page.getByRole('option', { name: '阿里云盘', exact: true }).click();
    const start = dialog.getByRole('button', { name: '扫码连接阿里云盘', exact: true });
    await start.click();
    await dialog.getByAltText('阿里云盘登录二维码').waitFor({ timeout: 45000 });
    const src = await dialog.getByAltText('阿里云盘登录二维码').getAttribute('src');
    assert.ok(src.startsWith('data:image/png;base64,'));
    assert.equal(await dialog.getByText('等待扫码', { exact: true }).count(), 1);
    assert.equal(await dialog.locator('label').filter({ hasText: /^网盘账号$/ }).count(), 0, 'internal account fields stay hidden');
    await page.screenshot({ path: path.join(root, '.runtime/aliyun-drive-login.png'), fullPage: true });
    await dialog.getByRole('button', { name: '取消扫码', exact: true }).click();
    await dialog.getByAltText('阿里云盘登录二维码').waitFor({ state: 'hidden' });

    // Exercise the UI completion path against controlled provider results; no cloud writes.
    const fixtureAccount = { accountId: 'browser-account', userId: 'browser-user', name: '扫码测试账号', connected: true,
      drives: [{ id: 'resource-fixture', name: '资源盘' }, { id: 'backup-fixture', name: '备份盘' }] };
    await page.route('**/api/storage-plugins/ALIYUN_DRIVE/auth/**', async route => {
      const request = route.request(); let value;
      if (request.method() === 'POST') value = { sessionId: 'browser-session', qrCode: 'fixture-qr-code', expiresAt: new Date(Date.now() + 180000).toISOString() };
      else if (request.method() === 'DELETE') value = { success: true };
      else if (request.url().includes('/accounts/')) value = fixtureAccount;
      else value = { status: 'CONFIRMED', account: fixtureAccount };
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(value) });
    });
    await start.click();
    await dialog.getByText('扫码测试账号', { exact: true }).waitFor();
    const driveField = dialog.locator('.el-form-item').filter({ has: page.locator('label').filter({ hasText: /^云盘$/ }) });
    await driveField.locator('.el-select').click();
    await page.getByRole('option', { name: '备份盘', exact: true }).click();
    const nameField = dialog.locator('.el-form-item').filter({ has: page.locator('label').filter({ hasText: /^配置名称$/ }) });
    await nameField.getByRole('textbox').fill('扫码页面测试');
    let testedConfig;
    await page.route('**/api/storage-configs/test', async route => {
      testedConfig = route.request().postDataJSON();
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, checks: [], checkedAt: new Date().toISOString() }) });
    });
    await dialog.getByRole('button', { name: '测试连接', exact: true }).click();
    await dialog.getByText('连接测试通过，可以保存', { exact: true }).waitFor();
    assert.equal(await dialog.getByRole('button', { name: '保存', exact: true }).isEnabled(), true);
    assert.deepEqual(testedConfig.config, { accountId: 'browser-account', driveId: 'backup-fixture', rootFolderId: 'root' });
    assert.equal(await dialog.getByText('扫码测试账号', { exact: true }).count(), 1);
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    assert.deepEqual(errors, []);
    const health = await context.request.get(base + '/api/healthz');
    assert.equal(health.status(), 200);
    await context.request.post(base + '/api/auth/logout', { data: {} });
    console.log('PASS: local plugin installed; real QR generation/cancellation; simulated confirmation/drive selection/config submission; API health');
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
