/* Session UI acceptance uses intercepted local API data; no live login or database writes. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(
  process.env.PLAYWRIGHT_MODULE ||
    'C:/Users/shifuf/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright',
);
const { fixture, url } = require('./fixtures/admin-layout.cjs');
const output = path.resolve(__dirname, '../../.runtime/session-preview');
const historicalName = 'UFM-Download-Storage-Layout-Acceptance-a-long-client-name-that-must-wrap';
const currentAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0';
const dates = { createdAt: '2026-11-14T08:00:00.000Z', expiresAt: '2026-12-14T08:00:00.000Z' };
const original = [
  { ...dates, id: 'current', ip: '127.0.0.1', userAgent: currentAgent, current: true },
  { ...dates, id: 'historical', ip: '127.0.0.1', userAgent: historicalName, current: false },
];

async function openSessions(page) {
  await page.goto(url + '/dashboard');
  await page.getByRole('button', { name: /账号菜单/ }).click();
  await page.getByRole('menuitem', { name: '账号安全', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '账号安全', exact: true });
  await dialog.waitFor();
  await dialog.getByText('登录会话', { exact: true }).scrollIntoViewIfNeeded();
  return dialog;
}

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  const results = [];
  try {
    for (const width of [320, 390, 768, 1440]) {
      const { context, page, errors } = await fixture(browser, width);
      let sessions = structuredClone(original), deleteCalls = 0;
      await page.route('**/api/auth/sessions', async (route) => {
        if (route.request().method() === 'DELETE') {
          deleteCalls++;
          sessions = sessions.filter((row) => row.current);
          return route.fulfill({ json: { success: true, revoked: 1 } });
        }
        return route.fulfill({ json: sessions });
      });
      const dialog = await openSessions(page);
      await dialog.getByRole('heading', { name: 'Microsoft Edge 156 · Windows', exact: true }).waitFor();
      const historical = dialog.locator('.session-card').filter({ hasText: historicalName });
      assert.equal(await historical.count(), 1, 'one IP must not hide the historical client');
      await historical.getByRole('heading', { name: historicalName, exact: true }).waitFor();
      assert.equal(await dialog.getByText('当前会话', { exact: true }).count(), 1);
      assert.equal(await dialog.getByText('其他会话', { exact: true }).count(), 1);
      const dimensions = await dialog.evaluate((element) => {
        const label = element.querySelector('.session-card:last-child .session-device-label');
        return {
          viewport: window.innerWidth,
          body: document.documentElement.scrollWidth,
          panel: element.clientWidth,
          content: element.scrollWidth,
          labelWidth: label.clientWidth,
          labelContentWidth: label.scrollWidth,
          labelHeight: label.clientHeight,
          lineHeight: parseFloat(getComputedStyle(label).lineHeight),
        };
      });
      assert.ok(dimensions.body <= width + 1, JSON.stringify(dimensions));
      assert.ok(dimensions.content <= dimensions.panel + 1, JSON.stringify(dimensions));
      assert.ok(dimensions.labelContentWidth <= dimensions.labelWidth + 1, JSON.stringify(dimensions));
      if (width === 320) assert.ok(dimensions.labelHeight > dimensions.lineHeight, 'long client names should wrap');
      await dialog.locator('.session-card').first().getByText('浏览器信息', { exact: true }).click();
      await dialog.getByText(currentAgent, { exact: true }).waitFor();
      if (width === 390 || width === 1440) {
        await dialog.locator('.sessions-section').screenshot({ path: path.join(output, `sessions-${width}.png`) });
      }
      await dialog.getByRole('button', { name: '退出其他会话', exact: true }).click();
      await dialog.locator('.session-card').filter({ hasText: historicalName }).waitFor({ state: 'hidden' });
      assert.equal(deleteCalls, 1);
      assert.equal(await dialog.locator('.session-card').count(), 1);
      assert.equal(await dialog.getByRole('button', { name: '退出其他会话', exact: true }).isDisabled(), true);
      assert.deepEqual(errors, []);
      results.push({ width, passed: true, dimensions, exitOtherCalls: deleteCalls });
      await context.close();
    }
    const { context, page } = await fixture(browser, 390);
    let deleteCalls = 0;
    await page.route('**/api/auth/sessions', async (route) => {
      if (route.request().method() === 'DELETE') deleteCalls++;
      return route.fulfill({ json: original.map((row) => ({ ...row, current: false })) });
    });
    const dialog = await openSessions(page);
    await dialog.getByText('暂时无法确认当前会话，请刷新后重试。', { exact: true }).waitFor();
    assert.equal(await dialog.getByRole('button', { name: '退出其他会话', exact: true }).isDisabled(), true);
    for (const button of await dialog.getByRole('button', { name: '退出此会话', exact: true }).all()) {
      assert.equal(await button.isDisabled(), true);
    }
    assert.equal(deleteCalls, 0);
    results.push({ missingCurrentCookie: true, passed: true, destructiveActionsDisabled: true });
    await context.close();
    console.log(JSON.stringify(results, null, 2));
  } finally {
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
    await browser.close();
  }
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
