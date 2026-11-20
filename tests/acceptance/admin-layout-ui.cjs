/* Isolated layout acceptance: only local API fixtures; no live database writes. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(
  process.env.PLAYWRIGHT_MODULE ||
    'C:/Users/shifuf/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright',
);
const { fixture, url } = require('./fixtures/admin-layout.cjs');
const output = process.env.ACCEPTANCE_LAYOUT_OUTPUT
  ? path.resolve(process.env.ACCEPTANCE_LAYOUT_OUTPUT)
  : path.resolve(__dirname, '../../.runtime/layout-preview');
fs.mkdirSync(output, { recursive: true });
const checks = [];

async function check(name, execute) {
  try {
    const evidence = await execute();
    checks.push({ name, passed: true, evidence });
    console.log('PASS', name);
  } catch (error) {
    checks.push({ name, passed: false, error: error.message });
    console.error('FAIL', name, error.message);
  }
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(checks, null, 2));
}

async function open(page, route) {
  await page.goto(url + route);
  await page.locator('.page-title').waitFor();
  if (route.startsWith('/dashboard'))
    await page.locator('.dashboard-metrics .metric').first().waitFor();
  else if (route.startsWith('/files'))
    await page.locator('.data-table .el-table__body tr').first().waitFor();
}

async function noOverflow(page) {
  const dimensions = await page.evaluate(() => {
    const main = document.querySelector('.admin-main');
    return {
      viewport: window.innerWidth,
      body: document.documentElement.scrollWidth,
      main: main.clientWidth,
      mainContent: main.scrollWidth,
    };
  });
  assert.ok(dimensions.body <= dimensions.viewport + 1, JSON.stringify(dimensions));
  assert.ok(dimensions.mainContent <= dimensions.main + 1, JSON.stringify(dimensions));
  return dimensions;
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  });
  try {
    const { context, page, errors } = await fixture(browser, 1440);
    for (const width of [320, 390, 768, 1024, 1440, 1920]) {
      await check(`${width}px 概览与文件页不溢出`, async () => {
        await page.setViewportSize({ width, height: width < 700 ? 844 : 1000 });
        const sizes = [];
        for (const route of ['/dashboard', '/files?projectId=p1']) {
          await open(page, route);
          sizes.push(await noOverflow(page));
          const header = await page.locator('.admin-header').boundingBox();
          assert.ok(header.height <= 66, `header is ${header.height}px`);
          if (width < 897)
            assert.ok(await page.getByRole('button', { name: '打开导航' }).isVisible());
          else assert.ok(await page.getByRole('navigation', { name: '后台导航' }).isVisible());
          if ([390, 1440].includes(width))
            await page.screenshot({
              path: path.join(
                output,
                `${route.startsWith('/dashboard') ? 'dashboard' : 'files'}-${width}.png`,
              ),
            });
        }
        return sizes;
      });
    }

    await check('导航保留全部管理入口和当前页提示', async () => {
      await page.setViewportSize({ width: 1440, height: 1000 });
      await open(page, '/dashboard');
      const navigation = page.getByRole('navigation', { name: '后台导航' });
      assert.equal(await navigation.getByRole('link').count(), 14);
      assert.equal(
        await navigation.getByRole('link', { name: '文件管理', exact: true }).getAttribute('href'),
        '/files',
      );
      await navigation.getByRole('link', { name: '文件管理', exact: true }).click();
      await page.waitForURL('**/files');
      assert.equal(
        await navigation
          .getByRole('link', { name: '文件管理', exact: true })
          .getAttribute('aria-current'),
        'location',
      );
      assert.match(await page.title(), /文件管理/);
      await page.waitForFunction(() => document.activeElement?.id === 'main-content');
    });

    await check('移动导航可用键盘打开关闭并恢复焦点', async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      const toggle = page.getByRole('button', { name: '打开导航' });
      await toggle.focus();
      await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog', { name: '后台导航' });
      await dialog.waitFor();
      await page.waitForFunction(() =>
        document.querySelector('.mobile-menu-drawer')?.contains(document.activeElement),
      );
      await page.screenshot({ path: path.join(output, 'navigation-390.png') });
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'hidden' });
      await page.waitForFunction(
        () => document.activeElement?.getAttribute('aria-label') === '打开导航',
      );
      await toggle.click();
      await dialog.getByRole('link', { name: '概览', exact: true }).click();
      await page.waitForURL('**/dashboard');
      await dialog.waitFor({ state: 'hidden' });
      await page.waitForFunction(() => document.activeElement?.id === 'main-content');
    });

    await check('账号菜单可打开窄屏安全面板', async () => {
      await page.getByRole('button', { name: /账号菜单/ }).click();
      await page.getByRole('menuitem', { name: '账号安全', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '账号安全' });
      await dialog.waitFor();
      const bounds = await dialog.boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 391);
      await page.getByRole('heading', { name: '账号安全', exact: true }).waitFor();
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'hidden' });
    });

    await check('通知可用键盘标记已读、关闭并返回按钮', async () => {
      const trigger = page.getByRole('button', { name: '通知，1 条未读' });
      await trigger.focus();
      await page.keyboard.press('Enter');
      const panel = page.getByRole('region', { name: '通知中心' });
      await panel.waitFor();
      await page.waitForFunction(
        () => document.activeElement?.getAttribute('aria-label') === '通知中心',
      );
      await panel.getByRole('button', { name: '全部已读' }).click();
      await page.getByRole('button', { name: '通知', exact: true }).waitFor();
      assert.equal(await panel.getByText('未读', { exact: false }).count(), 0);
      await page.keyboard.press('Escape');
      await panel.waitFor({ state: 'hidden' });
      await page.waitForFunction(
        () => document.activeElement?.getAttribute('aria-label') === '通知',
      );
    });

    await check('筛选、目录折叠和批量选择关联正确', async () => {
      await open(page, '/files?projectId=p1');
      await page.getByText('横向滚动可查看其他列和文件操作', { exact: true }).waitFor();
      assert.equal(await page.locator('.data-table .el-table-fixed-column--right').count(), 0);
      const folder = page.getByRole('button', { name: '项目目录' });
      assert.equal(await folder.getAttribute('aria-expanded'), 'false');
      await folder.click();
      assert.equal(await folder.getAttribute('aria-expanded'), 'true');
      await page.getByRole('treeitem').filter({ hasText: '项目文档' }).click();
      await page.waitForFunction(() =>
        document.querySelector('.file-list-heading')?.textContent.includes('共 6 个文件'),
      );
      await folder.click();
      const input = page.getByRole('textbox', { name: '搜索文件名、备注或标签' });
      await input.fill('产品预览');
      await page.getByRole('button', { name: '搜索', exact: true }).click();
      await page.waitForFunction(() =>
        document.querySelector('.file-list-heading')?.textContent.includes('共 1 个文件'),
      );
      const firstRow = page.locator('.data-table .el-table__body tr').first();
      await firstRow.locator('.el-checkbox').click();
      await page.getByRole('button', { name: '批量复制', exact: true }).waitFor();
      await page.getByRole('button', { name: '取消选择', exact: true }).click();
      await page
        .getByRole('button', { name: '批量复制', exact: true })
        .waitFor({ state: 'hidden' });
      await input.fill('不存在的文件名');
      await page.getByRole('button', { name: '搜索', exact: true }).click();
      await page.getByText('没有找到匹配的文件', { exact: true }).waitFor();
      await page.getByRole('button', { name: '高级过滤' }).click();
      await page.getByPlaceholder('标签', { exact: true }).waitFor();
      await noOverflow(page);
    });

    await check('上传区域支持键盘选择和保留上传设置', async () => {
      await open(page, '/files?projectId=p1');
      const drop = page.getByRole('button', { name: /拖拽文件到此处上传/ });
      await drop.focus();
      const chooser = page.waitForEvent('filechooser');
      await page.keyboard.press('Enter');
      assert.ok((await chooser).isMultiple());
      await page.getByRole('button', { name: '上传设置', exact: true }).click();
      await page.getByRole('combobox', { name: '重复文件处理方式' }).waitFor();
      await noOverflow(page);
    });

    await check('趋势切换和每日明细可使用', async () => {
      await open(page, '/dashboard');
      await page.getByRole('radio', { name: '最近 30 天' }).focus();
      await Promise.all([
        page.waitForResponse((r) => r.url().includes('/dashboard/trends?days=30')),
        page.keyboard.press('Space'),
      ]);
      await page.locator('.trend-details summary').click();
      await page.waitForFunction(
        () => document.querySelectorAll('.numbers-table tbody tr').length === 30,
      );
      await noOverflow(page);
    });

    await check('布局支持 200% 等效缩放和 RTL 排列', async () => {
      // 1440 physical pixels at 200% zoom presents a 720 CSS-pixel layout viewport.
      await page.setViewportSize({ width: 720, height: 500 });
      await noOverflow(page);
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.evaluate(() => {
        document.documentElement.dir = 'rtl';
      });
      await noOverflow(page);
      const sidebar = await page.locator('.admin-sidebar').boundingBox();
      assert.ok(sidebar.x > 1000);
      await page.evaluate(() => {
        document.documentElement.dir = 'ltr';
      });
    });

    await check('移动抽屉在切换到桌面尺寸后关闭', async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole('button', { name: '打开导航' }).click();
      await page.getByRole('dialog', { name: '后台导航' }).waitFor();
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.getByRole('dialog', { name: '后台导航' }).waitFor({ state: 'hidden' });
      await page.waitForFunction(() => document.activeElement?.id === 'main-content');
    });

    await check('其他管理页面在窄屏和桌面下保持内容宽度', async () => {
      for (const width of [390, 1440]) {
        await page.setViewportSize({ width, height: width < 700 ? 844 : 1000 });
        for (const route of [
          '/projects',
          '/storage-configs',
          '/shares',
          '/tasks',
          '/webhooks',
          '/audit-logs',
          '/system-health',
          '/backups',
          '/settings',
          '/share-ip-abuse',
          '/developer-integration',
          '/recycle-bin',
        ]) {
          await page.goto(url + route);
          await page.locator('.page-title').waitFor();
          await page.waitForLoadState('networkidle');
          await noOverflow(page);
        }
      }
    });

    await check('浏览器未产生脚本异常', async () => {
      assert.deepEqual(errors, []);
    });
    await context.close();

    await check('概览加载失败时保持其他面板并可重试', async () => {
      const f = await fixture(browser, 390, { fail: ['/dashboard/summary'] });
      try {
        await f.page.goto(url + '/dashboard');
        await f.page.getByRole('button', { name: '重试指标', exact: true }).waitFor();
        await f.page.locator('.storage-card').first().waitFor();
        await f.page.getByRole('button', { name: '重试指标', exact: true }).click();
        await f.page.locator('.dashboard-metrics .metric').first().waitFor();
        await f.page
          .getByRole('button', { name: '重试指标', exact: true })
          .waitFor({ state: 'hidden' });
        assert.deepEqual(f.errors, []);
      } finally {
        await f.context.close();
      }
    });

    await check('文件与目录错误均能独立显示并重试', async () => {
      const f = await fixture(browser, 1440, {
        fail: ['/files', '/projects/p1/files/folder-tree'],
      });
      try {
        await f.page.goto(url + '/files?projectId=p1');
        await f.page.getByRole('button', { name: '重新加载文件', exact: true }).waitFor();
        await f.page.getByRole('button', { name: '重新加载目录', exact: true }).waitFor();
        await f.page.getByRole('button', { name: '重新加载文件', exact: true }).click();
        await f.page.locator('.data-table .el-table__body tr').first().waitFor();
        await f.page
          .getByRole('button', { name: '重新加载目录', exact: true })
          .waitFor({ state: 'hidden' });
        assert.deepEqual(f.errors, []);
      } finally {
        await f.context.close();
      }
    });

    await check('通知请求失败后有明确错误并能重试', async () => {
      const f = await fixture(browser, 320, { fail: ['/notifications'], failCount: 2 });
      try {
        await open(f.page, '/dashboard');
        await f.page.getByRole('button', { name: '通知', exact: true }).click();
        const panel = f.page.getByRole('region', { name: '通知中心' });
        await panel.getByRole('button', { name: '重试', exact: true }).waitFor();
        await panel.getByRole('button', { name: '重试', exact: true }).click();
        await panel.getByText('备份任务已完成', { exact: true }).waitFor();
        const rect = await panel.boundingBox();
        assert.ok(rect.x >= 0 && rect.x + rect.width <= 321);
        assert.deepEqual(f.errors, []);
      } finally {
        await f.context.close();
      }
    });

    await check('首次加载与空数据有清晰状态', async () => {
      const f = await fixture(browser, 390, { empty: true, delay: 1100 });
      try {
        await f.page.goto(url + '/dashboard');
        await f.page.getByText('正在读取关键指标…', { exact: true }).waitFor();
        await f.page.getByText('还没有存储配置。', { exact: true }).waitFor();
        await f.page.getByText('还没有备份记录。', { exact: true }).waitFor();
        await f.page.getByRole('button', { name: '通知', exact: true }).click();
        await f.page
          .getByRole('region', { name: '通知中心' })
          .getByText('暂无通知', { exact: true })
          .waitFor();
        await noOverflow(f.page);
        assert.deepEqual(f.errors, []);
      } finally {
        await f.context.close();
      }
    });
  } finally {
    await browser.close();
  }
  const failed = checks.filter((c) => !c.passed);
  console.log(
    JSON.stringify({
      passed: checks.length - failed.length,
      failed: failed.length,
      report: path.join(output, 'results.json'),
    }),
  );
  if (failed.length) process.exitCode = 1;
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
