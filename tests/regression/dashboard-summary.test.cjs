const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
require('ts-node').register({
  project: path.resolve(__dirname, '../../apps/api/tsconfig.json'),
  transpileOnly: true,
});
const admin = { id: 'admin', role: 'SUPER_ADMIN' };
const epoch = new Date('2026-11-13T16:00:00Z');
const cloud = (id, provider = 'S3', enabled = true, priority = 20) => ({
  id,
  name: id,
  provider,
  enabled,
  priority,
  projectId: null,
  config: { secret: 'NEVER-EXPOSE' },
});

// The doubles replace database I/O only. Filtering and arithmetic use independent fixture rows.
function fixture(empty = false) {
  const projects = empty
    ? []
    : [
        { id: 'a', name: 'A', enabled: true, deletedAt: null },
        { id: 'b', name: 'B', enabled: false, deletedAt: null },
        { id: 'deleted', name: 'Deleted', enabled: false, deletedAt: epoch },
      ];
  const files = empty
    ? []
    : [
        {
          id: 'f1',
          projectId: 'a',
          status: 'ACTIVE',
          deletedAt: null,
          size: 9007199254740993n,
          originalName: 'source',
          createdAt: epoch,
        },
        {
          id: 'f2',
          projectId: 'b',
          status: 'ACTIVE',
          deletedAt: null,
          size: 7n,
          originalName: 'disabled-project-source',
          createdAt: epoch,
        },
        {
          id: 'f3',
          projectId: 'a',
          status: 'RECYCLED',
          deletedAt: epoch,
          size: 500n,
          originalName: 'recycle',
          createdAt: epoch,
        },
        {
          id: 'f4',
          projectId: 'a',
          status: 'ACTIVE',
          deletedAt: epoch,
          size: 600n,
          originalName: 'bad-active',
          createdAt: epoch,
        },
        {
          id: 'f5',
          projectId: 'deleted',
          status: 'ACTIVE',
          deletedAt: null,
          size: 700n,
          originalName: 'deleted-project-source',
          createdAt: epoch,
        },
      ];
  const configs = empty
    ? []
    : [cloud('c1'), cloud('c2', 'QINIU', false), cloud('local', 'LOCAL', true, 1)];
  const replicas = empty
    ? []
    : [
        { projectId: 'a', configId: 'c1', status: 'READY', size: 9007199254740993n },
        { projectId: 'a', configId: 'c1', status: 'READY', size: 500n }, // indexed history/recycle remains included
        { projectId: 'b', configId: 'c2', status: 'PENDING', size: 7n },
        { projectId: 'a', configId: 'c1', status: 'SYNCING', size: 8n },
        { projectId: 'a', configId: 'c1', status: 'FAILED', size: 9n },
        { projectId: 'a', configId: 'c1', status: 'MISSING', size: 10n },
        { projectId: 'deleted', configId: 'c1', status: 'READY', size: 700n },
      ];
  const tasks = empty
    ? []
    : [
        { id: 'running', projectId: 'a', status: 'RUNNING' },
        {
          id: 'failed',
          projectId: 'b',
          status: 'FAILED',
          title: 'failed task',
          type: 'REPLICA_SYNC',
          createdAt: epoch,
        },
        { id: 'completed', projectId: 'a', status: 'COMPLETED' },
        { id: 'global', projectId: null, status: 'RUNNING' },
        { id: 'deleted-task', projectId: 'deleted', status: 'FAILED' },
      ];
  const calls = [];
  function matches(row, where = {}) {
    if (where.OR && !where.OR.some((clause) => matches(row, clause))) return false;
    if (where.project && !projects.some((p) => p.id === row.projectId && matches(p, where.project)))
      return false;
    for (const [key, value] of Object.entries(where)) {
      if (key === 'OR' || key === 'project') continue;
      if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
        if (value.in && !value.in.includes(row[key])) return false;
      } else if (row[key] !== value) return false;
    }
    return true;
  }
  function delegate(name, rows) {
    const read = (args) => {
      calls.push({ name, args });
      return rows.filter((row) => matches(row, args?.where));
    };
    return {
      count: async (args) => read(args).length,
      aggregate: async (args) => {
        const list = read(args);
        return {
          _count: { _all: list.length },
          _sum: { size: list.reduce((s, r) => s + r.size, 0n) || null },
        };
      },
      groupBy: async (args) => {
        const grouped = new Map();
        for (const row of read(args)) {
          const key = args.by.map((k) => row[k]).join('|');
          const group = grouped.get(key) || {
            ...Object.fromEntries(args.by.map((k) => [k, row[k]])),
            _count: { _all: 0 },
            _sum: { size: 0n },
          };
          group._count._all++;
          group._sum.size += row.size || 0n;
          grouped.set(key, group);
        }
        const list = [...grouped.values()];
        if (args.orderBy?._sum?.size === 'desc')
          list.sort((a, b) => (a._sum.size > b._sum.size ? -1 : a._sum.size < b._sum.size ? 1 : 0));
        return list.slice(0, args.take || list.length);
      },
      findFirst: async (args) => read(args)[0] || null,
      findMany: async (args) =>
        read(args)
          .slice(args.skip || 0, (args.skip || 0) + (args.take || rows.length))
          .map((row) => ({
            ...row,
            project: projects.find((p) => p.id === row.projectId),
            _count: {
              files: files.filter(
                (f) => f.projectId === row.id && f.status === 'ACTIVE' && f.deletedAt === null,
              ).length,
              projectBindings: 1,
            },
            storageBindings: [{ config: configs[0] }, { config: configs[1] }].filter(
              (b) => b.config,
            ),
          })),
    };
  }
  const db = {
    project: delegate('project', projects),
    managedFile: delegate('managedFile', files),
    storageReplica: delegate('storageReplica', replicas),
    cdnConfig: delegate('cdnConfig', configs),
    task: delegate('task', tasks),
    backup: delegate(
      'backup',
      empty
        ? []
        : [
            {
              id: 'backup',
              name: 'last backup',
              status: 'FAILED',
              includeObjects: true,
              createdAt: epoch,
              finishedAt: epoch,
              message: 'NEVER-EXPOSE',
            },
          ],
    ),
    $queryRaw: async (query) => {
      calls.push({ name: 'raw', query });
      return [];
    },
  };
  const { DashboardService } = require('../../apps/api/src/dashboard/dashboard.service.ts');
  return { service: new DashboardService(db), db, calls, configs };
}

test('dashboard is implemented as an authenticated management service', async () => {
  assert.ok(
    fs.existsSync(path.resolve(__dirname, '../../apps/api/src/dashboard/dashboard.service.ts')),
    'dashboard service is missing',
  );
  const { service, calls } = fixture();
  await assert.rejects(service.summary({ role: 'MEMBER' }), (error) => error.getStatus() === 403);
  assert.equal(calls.length, 0);
  const { DashboardController } = require('../../apps/api/src/dashboard/dashboard.controller.ts');
  const guards = Reflect.getMetadata('__guards__', DashboardController);
  assert.ok(guards.some((guard) => guard.name === 'JwtAuthGuard'));
});

test('summary excludes deleted projects/non-active files and safely distinguishes source and indexed replica bytes', async () => {
  const { service } = fixture();
  const result = await service.summary(admin);
  assert.equal(result.projects.total, 2);
  assert.equal(result.projects.enabled, 1);
  assert.equal(result.files.active, 2);
  assert.equal(result.files.sourceBytes, '9007199254741000');
  assert.equal(result.replicas.readyBytes, '9007199254741493');
  assert.equal(result.replicas.ready, 2);
  assert.equal(result.replicas.pending, 2);
  assert.equal(result.replicas.failedOrMissing, 2);
  assert.equal(result.storage.enabled, 2);
  assert.equal(result.tasks.running, 2);
  assert.equal(result.tasks.failed, 1);
  assert.doesNotThrow(() => JSON.stringify(result));
});

test('empty metadata produces explicit empty collections, zero summaries and no fake health', async () => {
  const { service } = fixture(true);
  const summary = await service.summary(admin);
  assert.equal(summary.files.active, 0);
  assert.equal(summary.files.sourceBytes, '0');
  const storage = await service.storage({}, admin);
  assert.deepEqual(storage.items, []);
  assert.equal(storage.total, 0);
  const activity = await service.activity({}, admin);
  assert.deepEqual(activity.recentFiles, []);
  assert.deepEqual(activity.topProjects, []);
  assert.equal(activity.backup.latest, null);
  assert.equal(activity.projects.page, 1);
});

test('trends bound Shanghai midnights and aggregate actual download detail rather than UTC daily labels', async () => {
  const { service, db } = fixture();
  db.$queryRaw = async (query) => {
    assert.match(query.sql, /DATE_FORMAT\(DATE_ADD\(d\.createdAt, INTERVAL 8 HOUR\)/);
    assert.match(query.sql, /DownloadRecord/);
    assert.match(query.sql, /p\.deletedAt IS NULL/);
    assert.ok(!query.sql.includes('DownloadDailyStat'));
    assert.ok(
      query.values.some((v) => v instanceof Date && v.toISOString() === '2026-11-07T16:00:00.000Z'),
    );
    assert.ok(
      query.values.some((v) => v instanceof Date && v.toISOString() === '2026-11-14T16:00:00.000Z'),
    );
    // 15:59Z belongs to 11/13; 16:00Z belongs to 11/14 in Shanghai.
    return [
      { day: '2026-11-13', requests: 1n, bytes: 11n },
      { day: '2026-11-14', requests: 2n, bytes: 9007199254740993n },
    ];
  };
  const result = await service.trends('7', admin, new Date('2026-11-14T01:00:00Z'));
  assert.equal(result.days, 7);
  assert.equal(result.timezone, 'Asia/Shanghai');
  assert.deepEqual(result.items[0], { day: '2026-11-08', requests: 0, bytes: '0' });
  assert.deepEqual(result.items[5], { day: '2026-11-13', requests: 1, bytes: '11' });
  assert.deepEqual(result.items[6], { day: '2026-11-14', requests: 2, bytes: '9007199254740993' });
});

test('trends reject unsupported spans before querying', async () => {
  const { service, calls } = fixture();
  for (const days of ['0', '8', '7.5', 'NaN', '7x'])
    await assert.rejects(service.trends(days, admin), (error) => error.getStatus() === 400);
  assert.equal(calls.length, 0);
});

test('storage reads only latest recorded config-specific health and keeps cloud account usage unknown', async () => {
  const { service, db } = fixture();
  db.$queryRaw = async (query) => {
    assert.match(query.sql, /CDN_HEALTH_CHECK/);
    assert.match(query.sql, /ROW_NUMBER\(\) OVER/);
    assert.match(query.sql, /configId/);
    assert.ok(query.values.includes('c1'));
    return [{ configId: 'c1', success: 'false', createdAt: epoch }];
  };
  const result = await service.storage({}, admin);
  const one = result.items.find((c) => c.id === 'c1'),
    two = result.items.find((c) => c.id === 'c2');
  assert.equal(one.health.status, 'FAILED');
  assert.equal(one.health.checkedAt, epoch.toISOString());
  assert.deepEqual(two.health, { status: 'UNKNOWN', checkedAt: null });
  assert.equal(one.accountUsedBytes, null);
  assert.equal(one.replicas.readyBytes, '9007199254741493');
  assert.equal(one.replicas.pending, 1);
  assert.equal(one.replicas.failedOrMissing, 2);
  assert.ok(!JSON.stringify(result).includes('NEVER-EXPOSE'));
  assert.ok(!JSON.stringify(result).includes('config'));
});

test('saved storage health ignores newer contradictory edit drafts before selecting the latest check', async () => {
  const savedAt = new Date('2026-11-14T01:00:00Z');
  const draftAt = new Date('2026-11-14T02:00:00Z');
  const audits = [
    ['saved-c1', { configId: 'c1', success: true }, savedAt],
    ['draft-c1', { configId: 'c1', success: false, draft: true }, draftAt],
    ['saved-c2', { configId: 'c2', success: false }, savedAt],
    ['draft-c2', { configId: 'c2', success: true, draft: true }, draftAt],
    ['draft-local', { configId: 'local', success: true, draft: true }, draftAt],
  ];
  const { service, db } = fixture();
  let candidateWhere;
  db.$queryRaw = async (query) => {
    // Only database I/O is doubled. Evaluate the candidate filter from the emitted
    // inner WHERE, then rank competing saved/draft records independently.
    candidateWhere = query.sql
      .split('FROM AuditLog WHERE')[1]
      .split(') latest')[0]
      .replace(/\s+/g, ' ');
    const filtersDraft = candidateWhere.includes(
      "COALESCE(JSON_UNQUOTE(JSON_EXTRACT(detail, '$.draft')), 'false') <> 'true'",
    );
    const selected = new Map();
    for (const [, detail, createdAt] of audits.slice().sort((a, b) => b[2] - a[2])) {
      if (
        !query.values.includes(detail.configId) ||
        (filtersDraft && detail.draft === true) ||
        selected.has(detail.configId)
      )
        continue;
      selected.set(detail.configId, {
        configId: detail.configId,
        success: String(detail.success),
        createdAt,
      });
    }
    return [...selected.values()];
  };
  const result = await service.storage({}, admin);
  assert.deepEqual(result.items.find((c) => c.id === 'c1').health, {
    status: 'HEALTHY',
    checkedAt: savedAt.toISOString(),
  });
  assert.deepEqual(result.items.find((c) => c.id === 'c2').health, {
    status: 'FAILED',
    checkedAt: savedAt.toISOString(),
  });
  assert.deepEqual(result.items.find((c) => c.id === 'local').health, {
    status: 'UNKNOWN',
    checkedAt: null,
  });
  assert.match(
    candidateWhere,
    /COALESCE\(JSON_UNQUOTE\(JSON_EXTRACT\(detail, '\$\.draft'\)\), 'false'\) <> 'true'/,
    'draft filtering must happen in the ranked candidate set',
  );
});

test('dashboard pagination rejects nonprimitive shapes before I/O while preserving primitive integers', async () => {
  const { service, calls } = fixture();
  for (const query of [
    { page: ['1'] },
    { pageSize: ['20'] },
    { page: { toString: () => '1' } },
    { pageSize: { valueOf: () => 20 } },
    { page: new String('1') },
    { pageSize: new Number(20) },
    { page: null },
    { pageSize: true },
    { page: Symbol('1') },
  ]) {
    for (const method of ['storage', 'activity']) {
      await assert.rejects(service[method](query, admin), (error) => error.getStatus() === 400);
    }
  }
  assert.equal(calls.length, 0);
  const result = await service.storage({ page: 1, pageSize: 20 }, admin);
  assert.equal(result.page, 1);
  assert.equal(result.pageSize, 20);
});

test('activity bounds recent/top queries, exposes actionable exceptions and whitelists backup/project/file fields', async () => {
  const { service, calls } = fixture();
  const result = await service.activity({}, admin);
  assert.equal(result.recentFiles.length, 2);
  assert.equal(result.topProjects[0].id, 'a');
  assert.equal(result.topProjects[0].sourceBytes, '9007199254740993');
  assert.equal(result.exceptions.recycleFiles, 1);
  assert.equal(result.exceptions.failedTasks.length, 1);
  assert.equal(result.backup.latest.status, 'FAILED');
  assert.equal(result.backup.latest.includeObjects, true);
  assert.equal(result.backup.lastFailed.id, 'backup');
  assert.ok(calls.some((c) => c.name === 'managedFile' && c.args.take === 10));
  assert.ok(
    calls.some(
      (c) => c.name === 'managedFile' && c.args.take === 5 && c.args.by?.includes('projectId'),
    ),
  );
  assert.ok(!JSON.stringify(result).includes('NEVER-EXPOSE'));
  assert.deepEqual(
    result.projects.items[0].storages.map((s) => s.id),
    ['c1', 'c2', 'local'],
  );
  assert.equal(result.projects.items[0].storages[1].enabled, false);
});

test('project pagination validates integers, clamps disappearing pages and never reads unbounded projects', async () => {
  const { service, calls } = fixture();
  for (const query of [
    { page: '0' },
    { page: '1.5' },
    { page: 'x' },
    { pageSize: '200' },
    { pageSize: '20.5' },
  ]) {
    await assert.rejects(service.activity(query, admin), (error) => error.getStatus() === 400);
  }
  const result = await service.activity({ page: '99', pageSize: '10' }, admin);
  assert.equal(result.projects.page, 1);
  assert.equal(result.projects.pageSize, 10);
  assert.equal(result.projects.total, 2);
  const projectReads = calls.filter((c) => c.name === 'project' && c.args.select);
  assert.ok(projectReads.every((c) => c.args.take || c.args.where.id?.in));
});

function viewFixture(api) {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../../apps/web/src/views/Dashboard.vue'),
    'utf8',
  );
  const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1];
  const mounted = [],
    unmounted = [];
  const module = { exports: {} };
  const output = ts.transpileModule(
    script +
      '\nexports.harness = { summaryPanel, trendPanel, storagePanel, activityPanel, loadSummary, loadTrends, loadStorage, loadActivity, days, projectPage, projectPageSize };',
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    AbortController,
    Date,
    Map,
    Number,
    BigInt,
    Intl,
    require(name) {
      if (name === 'vue')
        return {
          ...require('vue'),
          onMounted: (fn) => mounted.push(fn),
          onUnmounted: (fn) => unmounted.push(fn),
        };
      if (name === '@/api/dashboard') return { dashboardApi: api };
      throw new Error(name);
    },
  });
  return { ...module.exports.harness, mounted, unmounted };
}

test('dashboard panels preserve independent failures and resolved activity', async () => {
  const f = viewFixture({
    summary: async () => {
      throw Error('offline');
    },
    trends: async () => ({ items: [] }),
    storage: async () => ({ items: [] }),
    activity: async () => ({ projects: { page: 1, pageSize: 20, items: [], total: 0 } }),
  });
  await Promise.all(f.mounted.map((fn) => fn()));
  assert.ok(f.summaryPanel.error);
  assert.equal(f.summaryPanel.data, null);
  assert.equal(f.activityPanel.error, '');
  assert.equal(f.activityPanel.data.projects.total, 0);
  assert.equal(f.summaryPanel.loading, false);
  assert.equal(f.activityPanel.loading, false);
});

test('dashboard rejects late trend/page responses and aborts reads on unload', async () => {
  const pending = [];
  const f = viewFixture({
    trends: (days, options) => new Promise((resolve) => pending.push({ days, options, resolve })),
  });
  const first = f.loadTrends();
  f.days.value = 30;
  const second = f.loadTrends();
  pending[1].resolve({ days: 30, items: [] });
  await second;
  pending[0].resolve({ days: 7, items: [] });
  await first;
  assert.equal(f.trendPanel.data.days, 30);
  assert.equal(pending[0].options.signal.aborted, true);
  const third = f.loadTrends();
  f.unmounted.forEach((fn) => fn());
  assert.equal(pending[2].options.signal.aborted, true);
  pending[2].resolve({ days: 7 });
  await third;
  assert.equal(f.trendPanel.data.days, 30);
});

test('superseded activity refresh cannot normalize the current page from old displayed data', async () => {
  const pending = [];
  const f = viewFixture({
    activity: (page, size, options) =>
      new Promise((resolve) => pending.push({ page, size, options, resolve })),
  });
  f.activityPanel.data = { projects: { page: 1, pageSize: 20, total: 200, items: [] } };
  f.projectPage.value = 99;
  const old = f.loadActivity(),
    current = f.loadActivity();
  pending[0].resolve({ projects: { page: 2, pageSize: 20, total: 21, items: [] } });
  await old;
  assert.equal(f.projectPage.value, 99, 'an aborted refresh must not normalize from cached page 1');
  pending[1].resolve({ projects: { page: 3, pageSize: 20, total: 45, items: [] } });
  await current;
  assert.equal(f.projectPage.value, 3);
  assert.equal(f.activityPanel.data.projects.total, 45);
});

test('storage pagination validates limits and clamps pages before bounded metadata reads', async () => {
  const { service, calls } = fixture();
  await assert.rejects(
    service.storage({ pageSize: '0' }, admin),
    (error) => error.getStatus() === 400,
  );
  const result = await service.storage({ page: '900', pageSize: '10' }, admin);
  assert.equal(result.page, 1);
  assert.equal(result.pageSize, 10);
  assert.equal(result.total, 3);
  assert.ok(calls.some((c) => c.name === 'cdnConfig' && c.args.take === 10 && c.args.skip === 0));
});

test('30-day empty trend preserves every Shanghai day and independent panels retain last data on failure', async () => {
  const { service } = fixture(true);
  const result = await service.trends('30', admin, new Date('2026-11-14T01:00:00Z'));
  assert.equal(result.items.length, 30);
  assert.equal(result.items[0].day, '2026-10-16');
  assert.equal(result.items[29].day, '2026-11-14');
  assert.ok(result.items.every((row) => row.requests === 0 && row.bytes === '0'));
  const f = viewFixture({
    summary: async () => {
      throw Error('offline');
    },
  });
  f.summaryPanel.data = { updatedAt: 'known', files: { active: 9 } };
  await f.loadSummary();
  assert.equal(f.summaryPanel.data.files.active, 9);
  assert.ok(f.summaryPanel.error);
});
