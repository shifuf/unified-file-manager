const assert = require('node:assert/strict');
const url = process.env.ACCEPTANCE_WEB_URL || 'http://127.0.0.1:5188';
const target = new URL(url);
assert.ok(
  ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname),
  'Layout fixtures may only intercept requests on a local preview.',
);
const user = {
  id: 'demo-user',
  username: 'layout-demo',
  displayName: '布局验收管理员',
  role: 'SUPER_ADMIN',
  totpEnabled: true,
  mustChangePassword: false,
};
const date = '2026-11-20T08:32:00.000Z';
const pageResult = { items: [], page: 1, pageSize: 20, total: 0 };
const replicas = { ready: 4310, pending: 8, failedOrMissing: 2, readyBytes: '187223586880' };
const storages = [
  {
    id: 'local',
    name: '本地归档',
    provider: 'LOCAL',
    enabled: true,
    priority: 99,
    boundProjects: 12,
    health: { status: 'HEALTHY', checkedAt: date },
    accountUsedBytes: null,
    replicas,
  },
  {
    id: 'cdn',
    name: '华东对象存储',
    provider: 'ALIYUN_OSS',
    enabled: true,
    priority: 10,
    boundProjects: 8,
    health: { status: 'HEALTHY', checkedAt: date },
    accountUsedBytes: '83722358688',
    replicas: { ...replicas, ready: 3281 },
  },
  {
    id: 'backup',
    name: '异地备份存储',
    provider: 'S3',
    enabled: true,
    priority: 20,
    boundProjects: 3,
    health: { status: 'UNKNOWN', checkedAt: null },
    accountUsedBytes: null,
    replicas: { ...replicas, ready: 188 },
  },
];
const projects = ['设计资源库', '品牌素材', '产品文档', '交付归档'].map((name, i) => ({
  id: `p${i + 1}`,
  code: `demo-${i + 1}`,
  name,
  enabled: true,
  description: '团队协作项目',
  canManage: true,
  createdAt: date,
  updatedAt: date,
  storages,
  fileCount: 521 + i * 71,
}));
const files = [
  '品牌手册-2026.pdf',
  '产品预览-最终版.png',
  '交付清单.xlsx',
  '网站资源包.zip',
  '产品更新记录.md',
  '媒体套件视图.png',
  '网站发布计划.docx',
].map((originalName, i) => ({
  id: `f${i}`,
  originalName,
  projectId: 'p1',
  projectName: projects[0].name,
  name: originalName,
  folderPath: i ? '项目文档' : '设计资源/指南',
  tags: i < 3 ? ['团队资料'] : [],
  size: String((i + 3) * 1074432),
  category: ['DOCUMENT', 'IMAGE', 'DOCUMENT', 'ARCHIVE', 'DOCUMENT', 'IMAGE', 'DOCUMENT'][i],
  isPublic: false,
  status: 'ACTIVE',
  previewable: i < 2,
  canManage: true,
  printable: false,
  textEditable: i === 4,
  currentVersion: 1,
  createdAt: date,
  updatedAt: date,
}));
const notification = {
  id: 'one',
  title: '备份任务已完成',
  body: '工作空间的每日数据库和对象备份已完成。',
  level: 'INFO',
  href: '/backups',
  createdAt: date,
  readAt: null,
};
const trend = [
  32, 51, 38, 92, 61, 106, 83, 65, 81, 54, 90, 120, 110, 158, 110, 143, 201, 186, 155, 216, 295,
  245, 192, 212, 286, 219, 201, 243, 301, 285,
];
const dashboard = {
  summary: {
    updatedAt: date,
    projects: { total: 14, enabled: 12 },
    files: { active: 2846, sourceBytes: '89223586880' },
    storage: { enabled: 3 },
    replicas,
    tasks: { running: 4, failed: 2 },
  },
  storage: { ...pageResult, updatedAt: date, items: storages, total: storages.length },
  activity: {
    updatedAt: date,
    recentFiles: files,
    topProjects: projects.map((x, i) => ({
      ...x,
      sourceBytes: String(68644765831n / BigInt(i + 1)),
    })),
    exceptions: {
      recycleFiles: 12,
      failedTasks: [
        { id: 't1', title: '异地存储健康检查', projectId: 'p1', type: 'STORAGE', createdAt: date },
      ],
      replicaProjects: [{ projectId: 'p1', projectName: projects[0].name, failedOrMissing: 2 }],
    },
    backup: {
      latest: {
        id: 'b1',
        name: '工作区每日备份',
        status: 'SUCCEEDED',
        includeObjects: true,
        createdAt: date,
        finishedAt: date,
      },
      lastFailed: null,
    },
    projects: { ...pageResult, items: projects, total: projects.length },
  },
};
const folderTree = [
  {
    name: '设计资源',
    path: '设计资源',
    fileCount: 1,
    children: [{ name: '指南', path: '设计资源/指南', fileCount: 1, children: [] }],
  },
  { name: '项目文档', path: '项目文档', fileCount: 6, children: [] },
];
const copy = (value) => JSON.parse(JSON.stringify(value));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function fixture(browser, width, flags = {}) {
  const context = await browser.newContext({
    viewport: { width, height: width < 700 ? 844 : 1000 },
    deviceScaleFactor: 1,
    locale: 'zh-CN',
    reducedMotion: 'reduce',
  });
  await context.addInitScript(
    (p) => localStorage.setItem('ufm_user_profile', JSON.stringify(p)),
    flags.user || user,
  );
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const hit = new Map();
  let marked = false;
  await page.route(
    (location) => location.pathname.startsWith('/api/'),
    async (route) => {
      const location = new URL(route.request().url());
      const path = location.pathname.replace(/^\/api/, '');
      hit.set(path, (hit.get(path) || 0) + 1);
      let data = {};
      let status = 200;
      if (flags.delay && (path.startsWith('/dashboard/') || path === '/notifications'))
        await sleep(flags.delay);
      if (path === '/auth/profile') data = flags.user || user;
      else if (path === '/auth/sessions')
        data = [
          {
            id: 'here',
            ip: '127.0.0.1',
            userAgent: 'Chrome · 当前浏览器',
            createdAt: date,
            expiresAt: date,
            current: true,
          },
        ];
      else if (path === '/version')
        data = {
          currentVersion: 'v0.2.2',
          latestVersion: 'v0.2.3',
          state: 'available',
          updateAvailable: true,
        };
      else if (path === '/notifications')
        data = {
          ...pageResult,
          items: flags.empty ? [] : [{ ...notification, readAt: marked ? date : null }],
          total: flags.empty ? 0 : 1,
        };
      else if (path === '/notifications/unread-count')
        data = { count: flags.empty || marked ? 0 : 1 };
      else if (path === '/notifications/read') {
        marked = true;
        data = { success: true };
      } else if (path === '/dashboard/trends') {
        const days = Number(location.searchParams.get('days'));
        data = {
          days,
          timezone: 'Asia/Shanghai',
          updatedAt: date,
          items: trend
            .slice(-days)
            .map((value, i) => ({
              day: new Date(Date.UTC(2026, 10, 21 - days + i)).toISOString().slice(0, 10),
              requests: flags.empty ? 0 : value,
              bytes: flags.empty
                ? '0'
                : String(Math.round(value * 17800812 * (0.4 + (i % 4) * 0.2))),
            })),
        };
      } else if (path.startsWith('/dashboard/')) {
        const key = path.split('/').at(-1);
        data = copy(dashboard[key]);
        if (flags.empty && key === 'storage') data = { ...data, items: [], total: 0 };
        if (flags.empty && key === 'activity')
          data = {
            ...data,
            recentFiles: [],
            topProjects: [],
            backup: { latest: null, lastFailed: null },
            exceptions: { recycleFiles: 0, failedTasks: [], replicaProjects: [] },
            projects: pageResult,
          };
      } else if (path === '/projects') data = projects;
      else if (path === '/projects/p1') data = projects[0];
      else if (path.endsWith('/folder-tree') || path.endsWith('/folders/tree'))
        data = flags.empty ? [] : folderTree;
      else if (path.endsWith('/folders')) data = flags.empty ? [] : folderTree.map((f) => f.path);
      else if (path.endsWith('/folder-public')) data = [];
      else if (path === '/files') {
        const folder = location.searchParams.get('folderPath');
        const keyword = location.searchParams.get('keyword');
        const items =
          flags.empty || location.searchParams.get('status') === 'RECYCLED'
            ? []
            : files.filter(
                (f) =>
                  (!folder || f.folderPath === folder) &&
                  (!keyword || f.originalName.includes(keyword)),
              );
        data = { ...pageResult, items, total: items.length };
      } else if (path === '/files/storage-replicas')
        data = {
          items: files.map((file) => ({
            fileId: file.id,
            currentVersion: file.currentVersion,
            locations: [],
            sourceBytes: String(file.size),
          })),
        };
      else if (path.includes('replicas/summary') || path.includes('storage-summary'))
        data = { items: [] };
      else if (path === '/system/health')
        data = {
          status: 'OK',
          checkedAt: date,
          database: { status: 'OK' },
          counts: { projects: 4, activeFiles: 7, recycledFiles: 0, tasks: 0, failedTasks: 0 },
          runtime: { nodeVersion: 'v24.15.0', environment: 'test' },
          settings: {},
        };
      else if (
        [
          '/storage-configs',
          '/storage-plugins',
          '/webhooks',
          '/backups',
          '/backups/scopes',
          '/backups/destinations',
        ].includes(path)
      )
        data = [];
      else if (path.startsWith('/settings')) data = {};
      else if (path === '/auth/logout') data = { success: true };
      else data = pageResult;
      if (flags.fail?.includes(path) && hit.get(path) <= (flags.failCount || 1)) {
        status = 503;
        data = { message: '暂时不可用' };
      }
      await route.fulfill({ status, json: data });
    },
  );
  return { context, page, errors, hit };
}
module.exports = { fixture, url };
