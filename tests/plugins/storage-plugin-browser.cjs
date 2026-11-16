const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/shifuf/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const base = process.env.ACCEPTANCE_WEB || 'http://127.0.0.1:5175';
const output = path.resolve(__dirname, '../../.runtime/storage-plugin-ui');
fs.mkdirSync(output, { recursive: true });
let browser;
const plugin = { id: 'CLOUDFLARE_R2', name: 'Cloudflare R2', version: '1.0.0', apiVersion: 1, available: true, capabilities: { directUpload: true, usage: false }, fields: [
  { key: 'bucket', label: 'Bucket', type: 'string', required: true },
  { key: 'secret', label: 'Secret', type: 'string', required: true, secret: true },
  { key: 'retries', label: 'Retries', type: 'number', default: 0, required: true },
  { key: 'pathStyle', label: 'Path style', type: 'boolean', default: false },
  { key: 'mode', label: 'Mode', type: 'select', default: 'private', options: [{ label: 'Private', value: 'private' }] },
] };
const profile = { id: 'admin', username: 'fixture', displayName: '插件验收', role: 'SUPER_ADMIN', totpEnabled: false, mustChangePassword: false };
async function setup(initialPlugins = [], initialConfigs = []) {
  browser ||= await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  const context = await browser.newContext({ viewport: { width: 1500, height: 1100 } });
  await context.addInitScript(value => localStorage.setItem('ufm_user_profile', JSON.stringify(value)), profile);
  const page = await context.newPage(), errors = [], requests = [];
  const plugins = [...initialPlugins], configs = [...initialConfigs];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', async route => {
    if (!new URL(route.request().url()).pathname.startsWith('/api/')) return route.continue();
    const request = route.request(), endpoint = new URL(request.url()).pathname.replace(/^\/api/, ''), method = request.method();
    const body = request.headers()['content-type']?.includes('application/json') ? request.postDataJSON() : null;
    requests.push({ endpoint, method, body });
    let result = [];
    if (endpoint === '/auth/profile') result = profile;
    else if (endpoint === '/storage-plugins' && method === 'GET') result = plugins;
    else if (endpoint === '/storage-plugins' && method === 'POST') { plugins.splice(0, plugins.length, { ...plugin }); result = plugin; }
    else if (endpoint === '/storage-plugins/CLOUDFLARE_R2' && method === 'DELETE') { plugins.length = 0; result = { success: true }; }
    else if (endpoint === '/storage-configs' && method === 'GET') result = configs;
    else if (endpoint.endsWith('/test') || endpoint.endsWith('/test-draft')) result = { success: true, provider: body.provider, name: body.name, checkedAt: new Date().toISOString(), checks: [{ name: '连接', status: 'PASS', message: '协议边界测试' }] };
    else if (endpoint === '/storage-configs' && method === 'POST') { result = { ...body, id: 'new', enabled: true, projects: [] }; configs.push(result); }
    else if (endpoint.startsWith('/storage-configs/') && method === 'PUT') { result = { ...configs[0], ...body }; configs[0] = result; }
    else if (endpoint === '/notifications') result = { items: [], total: 0 };
    else if (endpoint === '/notifications/unread-count') result = { count: 0 };
    else if (endpoint === '/version') result = { currentVersion: '0.2.2', latestVersion: null, updateAvailable: null, state: 'unavailable' };
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(result) });
  });
  await page.goto(base + '/storage-configs');
  try { await page.getByRole('heading', { name: '存储配置', exact: true }).waitFor(); }
  catch (error) { console.error({ errors, requests, page: await page.locator('body').innerText() }); await context.close(); throw error; }
  return { page, context, errors, requests, configs };
}
function field(page, dialog, label) { return dialog.locator('.el-form-item').filter({ has: page.locator('label').filter({ hasText: new RegExp(`^${label}$`) }) }); }
after(async () => { await browser?.close(); });

test('fresh installation offers only local; uploading plugin enables typed configuration and creation', async () => {
  const { page, context, errors, requests } = await setup();
  try {
    await page.getByText('尚未安装远程存储插件', { exact: true }).waitFor();
    await page.getByRole('button', { name: '新建全局配置' }).click();
    let dialog = page.getByRole('dialog', { name: '新建存储配置', exact: true });
    await field(page, dialog, '平台').locator('.el-select').click();
    assert.deepEqual(await page.getByRole('option').allTextContents(), ['本地']);
    await page.keyboard.press('Escape');
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await page.locator('input[type=file]').setInputFiles({ name: 'r2.zip', mimeType: 'application/zip', buffer: Buffer.from('fixture transport boundary') });
    await page.getByText('Cloudflare R2', { exact: true }).first().waitFor();
    await page.getByRole('button', { name: '新建全局配置' }).click();
    dialog = page.getByRole('dialog', { name: '新建存储配置', exact: true });
    await field(page, dialog, '平台').locator('.el-select').click();
    await page.getByRole('option', { name: 'Cloudflare R2', exact: true }).click();
    await field(page, dialog, '配置名称').getByRole('textbox').fill('R2 docs');
    await field(page, dialog, 'Bucket').getByRole('textbox').fill('docs');
    await field(page, dialog, 'Secret').locator('input').fill('private-key');
    assert.equal(await field(page, dialog, 'Retries').getByRole('spinbutton').inputValue(), '0');
    await dialog.getByRole('button', { name: '测试连接', exact: true }).click();
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    const create = requests.find(request => request.endpoint === '/storage-configs' && request.method === 'POST');
    assert.deepEqual(create.body.config, { bucket: 'docs', secret: 'private-key', retries: 0, pathStyle: false, mode: 'private' });
    assert.equal(create.body.provider, 'CLOUDFLARE_R2');
    assert.equal(await page.locator('.plugin-panel').getByRole('button', { name: '卸载', exact: true }).isDisabled(), true);
    await page.screenshot({ path: path.join(output, 'installed-config.png'), fullPage: true });
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('masked secret remains omitted when editing a plugin config and missing plugins stay manageable', async () => {
  const config = { id: 'r2-1', provider: 'CLOUDFLARE_R2', name: 'Existing R2', config: { bucket: 'docs', secret: '******', retries: 0, pathStyle: false, mode: 'private' }, enabled: true, projects: [] };
  const { page, context, errors, requests } = await setup([plugin], [config]);
  try {
    await page.locator('.data-table').getByRole('button', { name: '编辑', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '编辑存储配置' });
    await field(page, dialog, 'Bucket').getByRole('textbox').fill('changed');
    await dialog.getByRole('button', { name: '测试连接', exact: true }).click();
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    const update = requests.find(request => request.endpoint === '/storage-configs/r2-1' && request.method === 'PUT');
    assert.equal('secret' in update.body.config, false);
    assert.equal(update.body.config.bucket, 'changed');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
  const missing = await setup([], [config]);
  try {
    await missing.page.getByText('插件未安装', { exact: true }).waitFor();
    await missing.page.locator('.data-table').getByRole('button', { name: '编辑', exact: true }).click();
    const dialog = missing.page.getByRole('dialog', { name: '编辑存储配置' });
    assert.equal(await dialog.getByRole('button', { name: '测试连接', exact: true }).isDisabled(), true);
    await field(missing.page, dialog, '配置名称').getByRole('textbox').fill('Renamed missing plugin');
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    const update = missing.requests.find(request => request.method === 'PUT');
    assert.equal('config' in update.body, false);
    assert.equal('provider' in update.body, false);
    assert.deepEqual(missing.errors, []);
  } finally { await missing.context.close(); }
});

test('an unused plugin can be uninstalled and disappears from the selector', async () => {
  const { page, context, errors, requests } = await setup([plugin]);
  try {
    await page.getByRole('button', { name: '卸载', exact: true }).click();
    await page.getByRole('dialog', { name: '卸载存储插件' }).getByRole('button', { name: '卸载', exact: true }).click();
    await page.getByText('尚未安装远程存储插件', { exact: true }).waitFor();
    assert.ok(requests.some(request => request.endpoint === '/storage-plugins/CLOUDFLARE_R2' && request.method === 'DELETE'));
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});
