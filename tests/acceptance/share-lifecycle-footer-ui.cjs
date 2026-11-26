/* Local UI fixtures only: no account credentials or live database writes. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/shifuf/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const { fixture, url } = require('./fixtures/admin-layout.cjs');

const output = path.resolve(process.env.ACCEPTANCE_SHARE_LIFECYCLE_OUTPUT || '.runtime/share-lifecycle-footer-ui');
fs.mkdirSync(output, { recursive: true });
const checks = [];
const baseShare = {
  id: 'share-lifecycle', fileId: 'f0', projectId: 'p1', projectName: '设计资源库',
  fileName: '品牌手册-2026.pdf', fileSize: 1234, fileCategory: 'DOCUMENT',
  token: 'lifecycle-token', customPath: null, url: `${url}/shares/lifecycle-token`,
  downloadUrl: `${url}/api/shares/lifecycle-token/download`, hasPassword: false,
  expiresAt: null, maxDownloads: null, downloadCount: 0, enabled: true,
  previewOnly: false, allowedIps: [], watermarkText: null, status: 'ACTIVE',
  createdAt: '2026-11-20T08:32:00Z', updatedAt: '2026-11-20T08:32:00Z',
};
async function check(name, run) {
  if (process.env.ACCEPTANCE_SHARE_CHECK && !name.includes(process.env.ACCEPTANCE_SHARE_CHECK)) return;
  try { const evidence = await run(); checks.push({ name, passed: true, evidence }); console.log('PASS', name); }
  catch (error) { checks.push({ name, passed: false, error: error.message }); console.error('FAIL', name, error.message); }
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(checks, null, 2));
}

async function installShares(page) {
  const state = { share: { ...baseShare }, reads: 0, mutations: [], failNext: false };
  await page.route(location => location.pathname.startsWith('/api/'), async route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname.replace(/^\/api/, '');
    if (pathname === '/version') return route.fulfill({ json: { currentVersion: 'v0.3.0', latestVersion: 'v0.3.0', state: 'available', updateAvailable: false } });
    if (pathname === '/file-shares' || /^\/files\/[^/]+\/shares$/.test(pathname)) {
      state.reads++;
      const items = state.share ? [{ ...state.share }] : [];
      return route.fulfill({ json: pathname === '/file-shares' ? { items, total: items.length, page: 1, pageSize: 20 } : items });
    }
    if (/^\/file-shares\//.test(pathname)) {
      const body = request.postDataJSON();
      state.mutations.push({ method: request.method(), path: pathname, body });
      await new Promise(resolve => setTimeout(resolve, 180));
      if (state.failNext) { state.failNext = false; return route.fulfill({ status: 503, json: { message: '分享操作暂时不可用' } }); }
      if (request.method() === 'PUT') {
        state.share = { ...state.share, ...body, status: body.enabled ? 'ACTIVE' : 'DISABLED' };
        return route.fulfill({ json: state.share });
      }
      if (request.method() === 'DELETE' && pathname.endsWith('/permanent')) {
        state.share = null;
        return route.fulfill({ json: { success: true } });
      }
      return route.fulfill({ status: 400, json: { message: '错误的分享生命周期请求' } });
    }
    return route.fallback();
  });
  return state;
}

async function exerciseLifecycle(page, state, container) {
  const row = () => container.locator('.el-table__body tr').filter({ hasText: 'lifecycle-token' }).first();
  const pause = row().getByRole('button', { name: '停用', exact: true });
  await pause.waitFor();
  assert.equal(await row().getByRole('button', { name: '删除', exact: true }).count(), 1, 'share row offers permanent deletion');
  await pause.click();
  const confirm = page.getByRole('dialog', { name: '停用分享', exact: true });
  await confirm.getByRole('button', { name: '取消', exact: true }).click();
  await confirm.waitFor({ state: 'hidden' });
  assert.equal(state.mutations.length, 0, 'cancelling pause sends no mutation');
  await pause.click();
  await confirm.getByRole('button', { name: '停用', exact: true }).click();
  await row().getByRole('button', { name: '启用', exact: true }).waitFor();
  assert.deepEqual(state.mutations[0], { method: 'PUT', path: '/file-shares/share-lifecycle', body: { enabled: false } });
  const resume = row().getByRole('button', { name: '启用', exact: true });
  await resume.evaluate(button => { button.click(); button.click(); });
  await row().getByRole('button', { name: '停用', exact: true }).waitFor();
  assert.equal(state.mutations.length, 2, 'a rapid second click cannot submit the same action twice');
  assert.deepEqual(state.mutations[1].body, { enabled: true });
  const beforeFailure = state.reads;
  state.failNext = true;
  await row().getByRole('button', { name: '停用', exact: true }).click();
  await confirm.getByRole('button', { name: '停用', exact: true }).click();
  await page.getByText('分享操作暂时不可用', { exact: true }).waitFor();
  await confirm.waitFor({ state: 'hidden' });
  await page.waitForFunction(() => !document.querySelector('.el-message-box__wrapper:not([style*="display: none"])'));
  await row().getByRole('button', { name: '停用', exact: true }).waitFor();
  assert.equal(state.reads, beforeFailure, 'a failed request preserves the visible share');
  await row().getByRole('button', { name: '删除', exact: true }).click();
  const removal = page.getByRole('dialog', { name: '删除分享', exact: true });
  await removal.getByText(/不会删除源文件/).waitFor();
  await removal.getByRole('button', { name: '取消', exact: true }).click();
  await removal.waitFor({ state: 'hidden' });
  assert.equal(state.mutations.length, 3, 'cancelling deletion sends no mutation');
  await row().getByRole('button', { name: '删除', exact: true }).click();
  const deletion = removal.getByRole('button', { name: '删除分享', exact: true });
  await deletion.evaluate(button => { button.click(); button.click(); });
  await row().waitFor({ state: 'hidden' });
  assert.equal(state.mutations.length, 4);
  assert.equal(state.mutations[3].method, 'DELETE');
  assert.equal(state.mutations[3].path, '/file-shares/share-lifecycle/permanent');
  assert.ok(state.reads >= 4, 'successful lifecycle operations reload the server list');
  return { requests: state.mutations, listReads: state.reads };
}

async function footerGeometry(page, { admin = false, productVisible = true } = {}) {
  const footer = page.locator('.site-footer');
  await footer.waitFor();
  assert.equal(await page.locator('footer').count(), 1, 'exactly one public footer landmark');
  assert.match(await footer.innerText(), /v0\.3\.0/);
  assert.match(await footer.innerText(), new RegExp(String(new Date().getFullYear())));
  assert.equal((await footer.innerText()).includes('统一文件管理系统'), productVisible);
  if (admin) await page.locator('.admin-main').evaluate(main => { main.scrollTop = main.scrollHeight; });
  const geometry = await footer.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    const previous = element.previousElementSibling?.getBoundingClientRect();
    const scroll = document.querySelector('.admin-main');
    return { position: getComputedStyle(element).position, width: bounds.width, left: bounds.left, right: bounds.right, top: bounds.top, previousBottom: previous?.bottom, viewport: innerWidth, body: document.documentElement.scrollWidth, adminContains: scroll?.contains(element) || false };
  });
  assert.ok(!['fixed', 'absolute'].includes(geometry.position));
  assert.ok(geometry.left >= -1 && geometry.right <= geometry.viewport + 1, JSON.stringify(geometry));
  assert.ok(geometry.body <= geometry.viewport + 1, JSON.stringify(geometry));
  if (geometry.previousBottom !== undefined) assert.ok(geometry.top >= geometry.previousBottom - 1, JSON.stringify(geometry));
  if (admin) assert.equal(geometry.adminContains, true);
  return geometry;
}

async function main() {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    for (const fileDialog of [false, true]) await check(fileDialog ? '文件弹窗支持停用、启用、删除并防止重复请求' : '分享管理支持停用、启用、删除并处理取消及失败', async () => {
      const { context, page, errors } = await fixture(browser, 1440);
      page.setDefaultTimeout(15000);
      try {
        const state = await installShares(page);
        await page.goto(url + (fileDialog ? '/files?projectId=p1' : '/shares'));
        let container = page.getByRole('region', { name: '分享列表', exact: true });
        if (fileDialog) {
          const fileRow = page.locator('.data-table .el-table__body tr').filter({ hasText: baseShare.fileName }).first();
          await fileRow.getByRole('button', { name: '分享', exact: true }).click();
          container = page.getByRole('region', { name: '文件分享列表', exact: true });
        }
        await container.locator('.el-table__body tr').filter({ hasText: 'lifecycle-token' }).first().waitFor();
        await container.scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(output, fileDialog ? 'file-share-actions.png' : 'share-manager-actions.png'), fullPage: true });
        const evidence = await exerciseLifecycle(page, state, container);
        assert.deepEqual(errors, [], 'no uncaught confirmation or request errors');
        await page.screenshot({ path: path.join(output, fileDialog ? 'file-share-deleted.png' : 'share-manager-deleted.png'), fullPage: true });
        return evidence;
      } finally { await context.close(); }
    });
    await check('后台页脚在内容自然流中，桌面和手机均不溢出', async () => {
      const { context, page, errors } = await fixture(browser, 1440);
      page.setDefaultTimeout(15000);
      try {
        await page.goto(url + '/dashboard');
        await page.locator('.dashboard-metrics .metric').first().waitFor();
        const sizes = [];
        for (const width of [1440, 390, 320]) { await page.setViewportSize({ width, height: 900 }); sizes.push(await footerGeometry(page, { admin: true })); }
        assert.deepEqual(errors, []);
        await page.screenshot({ path: path.join(output, 'footer-admin-mobile.png') });
        return sizes;
      } finally { await context.close(); }
    });
    await check('公开首页、登录、分享、目录分享、资源库均显示单一页脚', async () => {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const page = await context.newPage(); page.setDefaultTimeout(15000);
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      try {
        await page.route(location => location.pathname.startsWith('/api/'), async route => {
          const pathname = new URL(route.request().url()).pathname.replace(/^\/api/, '');
          let json = {};
          if (pathname.startsWith('/shares/')) json = { ...baseShare, size: 1234, category: 'ARCHIVE', previewable: false, brand: { footerText: '团队资料，请妥善保管', showPoweredBy: !pathname.includes('private-brand') } };
          if (pathname.startsWith('/folder-shares/')) json = pathname.endsWith('/files') ? { items: [] } : { projectName: '目录分享验收', hasPassword: false, previewOnly: false, brand: { footerText: '目录说明', showPoweredBy: true } };
          if (pathname.startsWith('/library/')) json = pathname.endsWith('/files') ? { items: [], total: 0 } : { name: '公开资料' };
          await route.fulfill({ json });
        });
        const dimensions = [];
        const paths = ['/', '/console-login', '/shares/lifecycle-token', '/shares/private-brand', '/folder-shares/lifecycle-folder', '/library/docs'];
        for (const route of paths) {
          await page.goto(url + route);
          if (route.startsWith('/shares/')) await page.getByRole('heading', { name: baseShare.fileName, exact: true }).waitFor();
          if (route.startsWith('/folder-shares/')) await page.getByRole('heading', { name: '目录分享验收', exact: true }).waitFor();
          try { dimensions.push({ route, ...await footerGeometry(page, { productVisible: route !== '/shares/private-brand' }) }); }
          catch (error) { throw new Error(`${route}: ${error.message}`); }
          if (route === '/shares/lifecycle-token') {
            await page.locator('.site-footer').getByText('团队资料，请妥善保管', { exact: true }).waitFor();
            await page.screenshot({ path: path.join(output, 'footer-public-share-mobile.png'), fullPage: true });
          }
        }
        assert.deepEqual(errors, []);
        return dimensions;
      } finally { await context.close(); }
    });
    await check('回收站保留天数允许修改保存且说明到期清理和失败重试', async () => {
      const { context, page, errors } = await fixture(browser, 1440);
      try {
        let retention = 30; const writes = [];
        await page.route('**/api/settings', async route => {
          if (route.request().method() === 'POST') {
            const body = route.request().postDataJSON(); writes.push(body); retention = body.value;
            return route.fulfill({ json: body });
          }
          return route.fulfill({ json: { recycleRetentionDays: retention } });
        });
        await page.goto(url + '/settings');
        const days = page.getByRole('spinbutton', { name: '回收站保留天数', exact: true });
        await days.waitFor();
        assert.equal(await days.isEnabled(), true);
        assert.equal(await days.inputValue(), '30');
        await page.getByText(/按设置天数定期彻底清理/).waitFor();
        await page.getByText(/删除失败.*保留.*重试/).waitFor();
        await days.fill('45'); await days.blur();
        await page.getByRole('button', { name: '保存设置', exact: true }).click();
        await page.getByText('系统设置已保存。', { exact: true }).waitFor();
        assert.deepEqual(writes, [{ key: 'recycleRetentionDays', value: 45 }]);
        assert.equal(await days.inputValue(), '45');
        assert.deepEqual(errors, []);
        return { defaultDays: 30, savedDays: retention, writes };
      } finally { await context.close(); }
    });
    await check('新 SVG 与 PWA 图标在指定尺寸可加载且具有可见内容', async () => {
      const context = await browser.newContext(); const page = await context.newPage();
      try {
        await page.goto(url + '/');
        const evidence = await page.evaluate(async () => {
          const icon = document.querySelector('link[rel="icon"]');
          const response = await fetch(icon.href); const source = await response.text();
          const image = new Image(); image.src = URL.createObjectURL(new Blob([source], { type: 'image/svg+xml' })); await image.decode();
          const pixels = [];
          for (const size of [16, 64]) { const canvas = document.createElement('canvas'); canvas.width = canvas.height = size; const context = canvas.getContext('2d'); context.drawImage(image, 0, 0, size, size); const bytes = context.getImageData(0, 0, size, size).data; pixels.push({ size, visible: Array.from(bytes).filter((_, index) => index % 4 === 3 && bytes[index] > 0).length }); }
          URL.revokeObjectURL(image.src);
          const manifest = await (await fetch(document.querySelector('link[rel="manifest"]').href)).json();
          const pwa = [];
          for (const entry of manifest.icons.filter(icon => icon.type === 'image/png')) {
            const asset = await fetch(entry.src); const installed = new Image(); installed.src = URL.createObjectURL(await asset.blob()); await installed.decode();
            const canvas = document.createElement('canvas'); canvas.width = installed.naturalWidth; canvas.height = installed.naturalHeight;
            const context = canvas.getContext('2d'); context.drawImage(installed, 0, 0);
            pwa.push({ src: entry.src, declared: entry.sizes, width: installed.naturalWidth, height: installed.naturalHeight, center: Array.from(context.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data) });
            URL.revokeObjectURL(installed.src);
          }
          return { source, pixels, pwa, type: response.headers.get('content-type') };
        });
        assert.match(evidence.source, /aria-label="统一文件管理/);
        assert.match(evidence.type, /svg/);
        assert.ok(evidence.pixels.every(sample => sample.visible >= sample.size * sample.size * .25));
        assert.deepEqual(evidence.pwa.map(icon => [icon.width, icon.height]), [[192, 192], [512, 512]]);
        assert.ok(evidence.pwa.every(icon => icon.declared === `${icon.width}x${icon.height}` && icon.center.slice(0, 3).every(channel => channel >= 240)), 'PWA assets render the white folder artwork rather than the old solid blue icon');
        await page.setViewportSize({ width: 200, height: 120 });
        await page.setContent(`<div style="display:flex;gap:24px;padding:24px;background:#f8fafc"><img src="${url}/favicon.svg" width="16" height="16"><img src="${url}/favicon.svg" width="64" height="64"></div>`);
        await page.locator('img').last().evaluate(image => image.decode());
        await page.screenshot({ path: path.join(output, 'favicon-16-64.png') });
        return { pixels: evidence.pixels, pwa: evidence.pwa, type: evidence.type };
      } finally { await context.close(); }
    });
  } finally { await browser.close(); }
  assert.ok(checks.every(item => item.passed), `${checks.filter(item => !item.passed).length}/${checks.length} UI checks failed`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
