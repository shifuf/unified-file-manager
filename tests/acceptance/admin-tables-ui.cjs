/* Populated management-table regressions. Requests stay on the local fixture. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(
  process.env.PLAYWRIGHT_MODULE ||
    'C:/Users/shifuf/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright',
);
const { fixture, url } = require('./fixtures/admin-layout.cjs');
const output = path.resolve(__dirname, '../../.runtime/layout-tables');
const date = '2026-11-20T08:32:00.000Z';
const checks = [];
const projectName = '设计资源库与跨部门归档完整项目名称ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const configName = '华东区域对象存储及长期归档ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const bindings = Array.from({ length: 30 }, (_, i) => ({
  id: `p${i + 1}`,
  name: `${i + 1}号项目完整名称ABCDEFGHIJKLMNOPQRSTUVWXYZ`,
  current: i < 2,
}));
const project = {
  id: 'p1', name: projectName, enabled: true, description: '团队协作项目', appId: 'layout-app',
  createdAt: date, canManage: true, storages: [], fileCount: 1,
};
const storage = {
  id: 'cloud', name: configName, provider: 'S3', config: { bucket: 'archive' }, enabled: true,
  projects: bindings, active: false, storageLimitEnabled: false, trafficLimitEnabled: false,
  priority: 100, failoverThresholdPercent: 90, trafficQuotaMode: 'FIXED', createdAt: date,
};
const share = {
  id: 'share1', fileName: '团队文档完整名称.pdf', fileSize: 1234, projectName,
  projectId: 'p1', url: `${url}/s/layout-check`, downloadUrl: `${url}/d/layout-check`,
  enabled: true, status: 'ACTIVE', hasPassword: false, downloadCount: 0,
};
const paged = (items) => ({ items, page: 1, pageSize: 20, total: items.length });
const routes = [
  ['/projects', projectName, '编辑'],
  ['/storage-configs', configName, '编辑'],
  ['/shares', share.fileName, '复制分享页'],
  ['/tasks', '批量迁移任务完整名称', '详情'],
  ['/webhooks', '项目通知回调完整名称', '投递'],
  ['/backups', '工作空间每日归档完整名称', '恢复'],
  ['/audit-logs', '127.0.0.8', '详情'],
  ['/share-ip-abuse', '127.0.0.9', '拉黑'],
];

async function populated(browser, width, flags = {}) {
  const result = await fixture(browser, width, flags);
  const data = {
    '/projects': [project],
    '/storage-configs': [{ ...storage, enabled: flags.storageEnabled ?? true }],
    '/storage-plugins': [{
      id: 'S3', name: 'S3 对象存储', version: '1.0.0', apiVersion: 1,
      available: flags.pluginAvailable ?? true,
      capabilities: flags.remote ? { remoteFiles: true, backupOnly: true } : {},
      fields: [{ key: 'bucket', label: '存储桶', type: 'string', required: true }],
    }],
    '/storage-configs/cloud/remote-files': { parentId: 'root', items: [], nextCursor: '' },
    '/file-shares': paged([share, { ...share, id: 'share2', url: 'javascript:alert(1)' }]),
    '/files/f0/shares': [share],
    '/files/f0/versions': [{
      id: 'version1', version: 1, originalName: '品牌手册的历史完整名称.pdf', size: 1234, createdAt: date,
    }],
    '/tasks': paged([{
      id: 'task1', title: '批量迁移任务完整名称', project, type: 'STORAGE_MIGRATION',
      status: 'SUCCEEDED', progress: 100, createdAt: date,
    }]),
    '/webhooks': [{
      id: 'hook1', name: '项目通知回调完整名称', url: 'https://example.com/hook',
      events: ['file.created'], enabled: true,
    }],
    '/backups': [{
      id: 'backup1', name: '工作空间每日归档完整名称', status: 'SUCCEEDED',
      fileAvailable: true, createdAt: date, includeObjects: true, fileSize: 12345,
      scopes: [], tableCounts: {},
    }],
    '/audit-logs': paged([{
      id: 'audit1', action: 'PROJECT_CREATE', ip: '127.0.0.8', createdAt: date, detail: {},
    }]),
    '/admin/share-ip-stats': paged([{
      id: 'ip1', ip: '127.0.0.9', downloadCount: 2, rateLimitCount: 0, banned: false,
    }]),
  };
  await result.page.route(
    (location) => location.pathname.startsWith('/api/') &&
      Object.hasOwn(data, location.pathname.slice(4)),
    (route) => route.fulfill({ json: data[new URL(route.request().url()).pathname.slice(4)] }),
  );
  return result;
}

async function check(name, fn) {
  try {
    const evidence = await fn();
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
  const table = page.locator('.surface .el-table').last();
  await table.locator('.el-table__body tr').first().waitFor();
  await page.waitForLoadState('networkidle');
  return table;
}

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  });
  try {
    const f = await populated(browser, 320);
    for (const width of [320, 390, 768, 1440]) {
      for (const [route, identity, action] of routes) {
        await check(`${width}px ${route} 名称可见且操作可滚动到达`, async () => {
          await f.page.setViewportSize({ width, height: width < 700 ? 844 : 1000 });
          const table = await open(f.page, route);
          if (width <= 768) {
            assert.equal(await table.locator('.el-table-fixed-column--right').count(), 0,
              '窄表格仍有固定操作列覆盖内容');
            await f.page.getByText('左右滚动查看完整表格和操作', { exact: true }).last().waitFor();
          }
          const text = table.getByText(identity, { exact: true }).first();
          if (route !== '/audit-logs') {
            const firstCell = table.locator('.el-table__body tr').first().locator('td').nth(route === '/tasks' ? 1 : 0);
            const visible = await firstCell.evaluate((cell) => {
              const bounds = cell.getBoundingClientRect();
              const tableBounds = cell.closest('.el-table').getBoundingClientRect();
              const x = Math.min(bounds.right - 8, tableBounds.right - 8);
              const y = bounds.top + Math.min(bounds.height / 2, 20);
              return cell.contains(document.elementFromPoint(x, y));
            });
            assert.ok(visible, '名称单元格被操作列覆盖');
            assert.equal(await text.isVisible(), true);
          }
          const dimensions = await f.page.evaluate(() => ({ viewport: innerWidth, content: document.documentElement.scrollWidth }));
          assert.ok(dimensions.content <= dimensions.viewport + 1, JSON.stringify(dimensions));
          if (width === 390 && ['/projects', '/storage-configs'].includes(route))
            await f.page.screenshot({ path: path.join(output, `${route.slice(1)}-${width}.png`) });
          await table.locator('.el-scrollbar__wrap').first().evaluate((element) => {
            element.scrollLeft = element.scrollWidth;
          });
          const button = table.getByRole('button', { name: action, exact: true }).first();
          await button.waitFor();
          const target = await button.boundingBox();
          const bounds = await table.boundingBox();
          assert.ok(target.x >= bounds.x - 1 && target.x + target.width <= bounds.x + bounds.width + 1,
            `${action} 操作不可见`);
          return dimensions;
        });
      }
    }

    await check('30个分配项目只显示3项摘要且完整名称可查看', async () => {
      await f.page.setViewportSize({ width: 1440, height: 1000 });
      const table = await open(f.page, '/storage-configs');
      const row = table.locator('.el-table__body tr').first();
      assert.equal(await row.locator('.assigned-project-tags .el-tag').count(), 3);
      assert.ok((await row.boundingBox()).height < 300, '项目标签把单行撑得过高');
      await row.getByRole('button', { name: /查看全部.*30/ }).click();
      const dialog = f.page.getByRole('dialog', { name: '可使用项目' });
      await dialog.waitFor();
      assert.equal(await dialog.locator('.assigned-project-list-item').count(), 30);
      await dialog.getByText(bindings[29].name, { exact: true }).waitFor();
      await dialog.getByText(bindings[29].name, { exact: true }).scrollIntoViewIfNeeded();
      await f.page.screenshot({ path: path.join(output, 'all-assigned-projects.png') });
      await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    });

    await check('表格容器缩窄后解除固定列并支持键盘横向滚动', async () => {
      await f.page.setViewportSize({ width: 1440, height: 1000 });
      const table = await open(f.page, '/projects');
      assert.ok(await table.locator('.el-table-fixed-column--right').count());
      await f.page.setViewportSize({ width: 320, height: 844 });
      await f.page.waitForFunction(() => !document.querySelector('.el-table-fixed-column--right'));
      const region = f.page.getByRole('region', { name: '项目列表', exact: true });
      await region.focus();
      await region.press('ArrowRight');
      await f.page.waitForFunction(() => document.querySelector('.table-viewport .el-scrollbar__wrap').scrollLeft > 0);
      await region.press('ArrowLeft');
      await f.page.waitForFunction(() => document.querySelector('.table-viewport .el-scrollbar__wrap').scrollLeft === 0);
      const name = table.getByRole('button', { name: projectName, exact: true });
      const dimensions = await name.evaluate((element) => ({ visible: element.clientWidth, content: element.scrollWidth }));
      assert.ok(dimensions.content <= dimensions.visible + 1, '长项目名称被截断');
    });

    for (const width of [320, 390]) {
      await check(`${width}px 文件分享和版本弹窗的名称不被固定列遮挡`, async () => {
        await f.page.setViewportSize({ width, height: 844 });
        await f.page.goto(url + '/files?projectId=p1');
        const table = f.page.locator('.data-table');
        await table.locator('.el-table__body tr').first().waitFor();
        await table.locator('.el-scrollbar__wrap').first().evaluate((element) => { element.scrollLeft = element.scrollWidth; });
        await table.getByRole('button', { name: '分享', exact: true }).first().click();
        const shares = f.page.getByRole('dialog', { name: '创建分享', exact: true });
        await shares.locator('.el-table__body tr').first().waitFor();
        assert.equal(await shares.locator('.el-table-fixed-column--right').count(), 0);
        await shares.getByRole('region', { name: '文件分享列表' }).waitFor();
        await shares.getByRole('button', { name: '关闭此对话框', exact: true }).click();
        await table.getByRole('button', { name: '更多', exact: true }).first().click();
        await f.page.getByRole('menuitem', { name: '版本历史', exact: true }).click();
        const versions = f.page.getByRole('dialog', { name: /版本历史/ });
        await versions.locator('.el-table__body tr').first().waitFor();
        assert.equal(await versions.locator('.el-table-fixed-column--right').count(), 0);
        await versions.getByRole('button', { name: '关闭', exact: true }).click();
      });
    }

    for (const width of [320, 390, 1440]) {
      await check(`${width}px 存储编辑优先展示基础配置且按钮始终可见`, async () => {
        await f.page.setViewportSize({ width, height: width < 700 ? 844 : 1000 });
        const table = await open(f.page, '/storage-configs');
        await table.locator('.el-scrollbar__wrap').first().evaluate((element) => { element.scrollLeft = element.scrollWidth; });
        await table.getByRole('button', { name: '编辑', exact: true }).click();
        const dialog = f.page.getByRole('dialog', { name: '编辑存储配置' });
        await dialog.getByText('平台配置', { exact: true }).waitFor();
        await f.page.screenshot({ path: path.join(output, `storage-editor-initial-${width}.png`) });
        assert.equal(await dialog.getByText('暂停上传阈值 (%)', { exact: true }).isVisible(), false);
        assert.equal(await dialog.getByText('流量额度模式', { exact: true }).isVisible(), false);
        await dialog.getByRole('button', { name: /空间限制/ }).click();
        await dialog.getByRole('switch', { name: '启用空间限制' }).locator('..').click();
        await dialog.getByText('暂停上传阈值 (%)', { exact: true }).waitFor();
        await dialog.getByRole('button', { name: /流量限制/ }).click();
        assert.equal(await dialog.getByText('流量额度模式', { exact: true }).isVisible(), false);
        await dialog.getByRole('switch', { name: '启用流量限制' }).locator('..').click();
        await dialog.getByText('流量额度模式', { exact: true }).waitFor();
        const save = await dialog.getByRole('button', { name: '保存', exact: true }).boundingBox();
        const viewport = f.page.viewportSize();
        assert.ok(save.y >= 0 && save.y + save.height <= viewport.height, '保存按钮超出屏幕');
        const body = await dialog.locator('.el-dialog__body').evaluate((element) => ({
          scrollable: ['auto', 'scroll'].includes(getComputedStyle(element).overflowY),
          width: element.clientWidth, content: element.scrollWidth,
        }));
        assert.equal(body.scrollable, true);
        assert.ok(body.content <= body.width + 1, JSON.stringify(body));
        await f.page.screenshot({ path: path.join(output, `storage-editor-${width}.png`) });
        await dialog.getByRole('button', { name: '取消', exact: true }).click();
      });
    }

    await check('分享地址可安全打开新页面且原复制按钮保留', async () => {
      await f.page.setViewportSize({ width: 1440, height: 1000 });
      const table = await open(f.page, '/shares');
      const link = table.getByRole('link', { name: share.url, exact: true });
      await link.waitFor();
      assert.equal(await link.getAttribute('href'), share.url);
      assert.equal(await link.getAttribute('target'), '_blank');
      assert.match(await link.getAttribute('rel'), /noopener/);
      assert.match(await link.getAttribute('rel'), /noreferrer/);
      assert.equal(await table.locator('a[href^="javascript:"]').count(), 0);
      assert.equal(await table.getByRole('button', { name: '复制分享页', exact: true }).count(), 2);
      await f.page.route('**/s/layout-check', (route) => route.fulfill({ contentType: 'text/html', body: '<p>分享页面</p>' }));
      const popupPromise = f.page.waitForEvent('popup');
      await link.click();
      const popup = await popupPromise;
      await popup.waitForLoadState();
      assert.equal(popup.url(), share.url);
      assert.equal(await popup.evaluate(() => window.opener), null);
      await popup.close();
    });

    await check('云端文件入口遵守管理员、插件能力与启停状态并打开云端弹窗', async () => {
      for (const [flags, expected] of [
        [{ remote: true }, 'enabled'],
        [{ remote: true, storageEnabled: false }, 'disabled'],
        [{ remote: true, pluginAvailable: false }, 'disabled'],
        [{ remote: false }, 'hidden'],
      ]) {
        const isolated = await populated(browser, 390, flags);
        try {
          const table = await open(isolated.page, '/storage-configs');
          await table.locator('.el-scrollbar__wrap').first().evaluate((element) => { element.scrollLeft = element.scrollWidth; });
          const entry = table.getByRole('button', { name: '云端文件', exact: true });
          if (expected === 'hidden') assert.equal(await entry.count(), 0);
          else if (expected === 'disabled') assert.equal(await entry.isDisabled(), true);
          else {
            assert.equal(await entry.isEnabled(), true);
            await entry.click();
            const remote = isolated.page.getByRole('dialog', { name: `云盘文件 · ${configName}`, exact: true });
            await remote.getByText('此目录暂无文件。', { exact: true }).waitFor();
            await isolated.page.screenshot({ path: path.join(output, 'remote-entry-390.png') });
          }
          assert.deepEqual(isolated.errors, []);
        } finally {
          await isolated.context.close();
        }
      }
      const anonymous = await populated(browser, 390, { remote: true });
      try {
        await anonymous.context.addInitScript(() => localStorage.removeItem('ufm_user_profile'));
        await anonymous.page.route(
          (location) => ['/api/auth/profile', '/api/auth/refresh'].includes(location.pathname),
          (route) => route.fulfill({ status: 401, json: { message: '未登录' } }),
        );
        await anonymous.page.goto(url + '/storage-configs');
        await anonymous.page.waitForURL(url + '/');
        assert.equal(await anonymous.page.getByRole('button', { name: '云端文件', exact: true }).count(), 0);
        assert.deepEqual(anonymous.errors, []);
      } finally {
        await anonymous.context.close();
      }
    });
    await check('页面没有脚本异常', async () => assert.deepEqual(f.errors, []));
    await f.context.close();
  } finally {
    await browser.close();
  }
  const failed = checks.filter((item) => !item.passed);
  console.log(JSON.stringify({ passed: checks.length - failed.length, failed: failed.length, output }));
  if (failed.length) process.exitCode = 1;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
