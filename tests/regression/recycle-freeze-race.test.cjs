const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
require('ts-node').register({ project: path.resolve(__dirname, '../../apps/api/tsconfig.json'), transpileOnly: true });
const { FilesService } = require('../../apps/api/src/files/files.service.ts');
const { AuditService } = require('../../apps/api/src/audit/audit.service.ts');
const { StorageService } = require('../../apps/api/src/storage/storage.service.ts');
const { WebdavFileService } = require('../../apps/api/src/webdav/webdav-file.service.ts');
const { LifecycleService } = require('../../apps/api/src/lifecycle/lifecycle.service.ts');

function gate() {
  let release, enter;
  const waiting = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { enter = resolve; });
  return { entered, release, pause: async () => { enter(); await waiting; } };
}

function matches(row, where = {}) {
  return !!row && Object.entries(where).every(([key, value]) => {
    if (value instanceof Date) return row[key]?.getTime() === value.getTime();
    if (value && typeof value === 'object') {
      if ('in' in value) return value.in.includes(row[key]);
      if ('not' in value) return row[key] !== value.not;
      if ('lt' in value) return row[key] < value.lt;
    }
    return row[key] === value;
  });
}

// Substitute persistence and provider I/O only: file lookup, recycling, lifecycle
// selection, DAV deletion, freeze and final deletion all execute production code.
function fixture({ lifecycle = false } = {}) {
  const config = { id: 'local', provider: 'LOCAL', config: {} };
  let head = { id: 'f', projectId: 'p', originalName: 'notes.txt', folderPath: null,
    status: 'ACTIVE', storageKey: 'old', currentVersion: 1, size: 3n,
    cdnConfigId: 'local', cdnConfig: config, versions: [], derivatives: [],
    deletedAt: null, purgeAt: null, createdAt: new Date('2020-01-01T00:00:00Z') };
  let failProvider = false, transactionOpen = false, pauseSelection = lifecycle;
  const stale = gate(), provider = gate(), objects = new Set(['old']), audits = [], events = [];
  const db = {
    $queryRaw: async () => [],
    managedFile: {
      findUnique: async () => head ? { ...head } : null,
      findFirst: async ({ where }) => matches(head, where) ? { ...head } : null,
      findMany: async ({ where }) => {
        const rows = matches(head, where) ? [{ ...head }] : [];
        if (pauseSelection) { pauseSelection = false; await stale.pause(); }
        return rows;
      },
      update: async ({ where, data }) => { assert.ok(matches(head, where)); head = { ...head, ...data }; return { ...head }; },
      updateMany: async ({ where, data }) => { if (!matches(head, where)) return { count: 0 }; head = { ...head, ...data }; return { count: 1 }; },
      deleteMany: async ({ where }) => { if (!matches(head, where)) return { count: 0 }; head = null; return { count: 1 }; },
    },
    storageReplica: { findFirst: async () => null, findMany: async () => [], createMany: async () => ({ count: 0 }), updateMany: async () => ({ count: 0 }), deleteMany: async () => ({ count: 0 }) },
    cdnConfig: { findMany: async () => [config] },
    auditLog: { create: async ({ data }) => { audits.push(data); } },
    shareLink: { updateMany: async () => ({ count: 0 }) },
    lifecyclePolicy: { update: async () => ({}) },
  };
  db.$transaction = async callback => {
    const saved = head && { ...head };
    transactionOpen = true;
    try { return await callback(db); }
    catch (error) { head = saved; throw error; }
    finally { transactionOpen = false; }
  };
  const storage = new StorageService({ get: () => undefined }, db, { adapter: () => ({
    remove: async (_config, key) => {
      assert.equal(transactionOpen, false, 'provider I/O must run after freeze transaction commits');
      await provider.pause();
      if (failProvider) throw new Error('storage offline');
      objects.delete(key);
    },
    objectExists: async (_config, key) => objects.has(key),
  }) }, undefined, { releaseDeletedObject: async () => {} });
  const access = { assertProjectAccess: async () => {} }, audit = new AuditService(db), eventBus = { emit: (...args) => events.push(args) };
  const files = Object.assign(Object.create(FilesService.prototype), {
    prisma: db, auditService: audit, projectAccessService: access, eventBus,
    settingsService: { getRecycleRetentionDays: async () => { await stale.pause(); return 7; } },
    tasksService: { create: async () => ({ id: 'task' }) },
  });
  return { files, stale, provider, objects, audits, events,
    dav: new WebdavFileService(db, storage, {}, files, eventBus),
    lifecycle: new LifecycleService(db, access, audit, eventBus, { getRecycleRetentionDays: async () => 30 }),
    head: () => head, change: data => { head = { ...head, ...data }; },
    fail: () => { failProvider = true; }, recover: () => { failProvider = false; } };
}

const account = { projectId: 'p' }, user = { id: 'u' };
const recycle = (f, mode) => ({
  user: () => f.files.recycle('f', user),
  project: () => f.files.recycleForProject('f', 'p'),
  'user batch': () => f.files.batchRecycle({ fileIds: ['f'] }, user),
  'project batch': () => f.files.batchRecycleForProject(['f'], 'p'),
}[mode]());

for (const mode of ['user', 'project', 'user batch', 'project batch']) {
  test(`${mode} stale recycle cannot replace DAV's whole-file deletion intent`, async () => {
    const f = fixture();
    const recycling = recycle(f, mode).then(value => ({ value }), error => ({ error }));
    await f.stale.entered;
    const deleting = f.dav.deleteFile(account, 'notes.txt').then(value => ({ value }), error => ({ error }));
    await f.provider.entered;
    assert.equal(f.head().purgeAt.getTime(), 0);
    f.stale.release();
    const recycled = await recycling, frozenDeadline = f.head()?.purgeAt?.getTime();
    f.provider.release();
    const deleted = await deleting;
    assert.equal(recycled.error?.getStatus?.(), 409, 'the stale operation must reject rather than report successful recycling');
    assert.equal(frozenDeadline, 0, 'recycling must preserve the durable whole-file deletion sentinel');
    assert.equal(deleted.error, undefined, 'the original DAV DELETE must complete without a finish conflict');
    assert.equal(f.head(), null);
    assert.equal(f.objects.size, 0);
    assert.deepEqual(f.audits, [], 'a rejected recycle must not publish a success audit');
    assert.deepEqual(f.events, [], 'a rejected recycle must not emit a deletion event');
  });

  test(`${mode} recycle rejects an ACTIVE head replaced during retention lookup`, async () => {
    const f = fixture();
    const recycling = recycle(f, mode).then(value => ({ value }), error => ({ error }));
    await f.stale.entered;
    f.change({ storageKey: 'new', currentVersion: 2 });
    f.stale.release();
    const result = await recycling;
    assert.equal(result.error?.getStatus?.(), 409);
    assert.equal(f.head().status, 'ACTIVE');
    assert.deepEqual(f.audits, []);
    assert.deepEqual(f.events, []);
  });
}

for (const action of ['RECYCLE', 'PURGE']) {
  test(`lifecycle ${action} skips a selected file frozen by DAV before the state write`, async () => {
    const f = fixture({ lifecycle: true });
    const recycling = f.lifecycle.executePolicy({ id: 'policy', projectId: 'p', folderPath: null, category: null, ttlDays: 1, action });
    await f.stale.entered;
    const deleting = f.dav.deleteFile(account, 'notes.txt').then(value => ({ value }), error => ({ error }));
    await f.provider.entered;
    f.stale.release();
    const result = await recycling, frozenDeadline = f.head()?.purgeAt?.getTime();
    f.provider.release();
    const deleted = await deleting;
    assert.equal(result.affected, 0, 'skipped frozen rows must not be counted as recycled');
    assert.equal(frozenDeadline, 0);
    assert.equal(deleted.error, undefined);
    assert.equal(f.head(), null);
    assert.equal(f.objects.size, 0);
    assert.deepEqual(f.events, []);
  });
}

test('failed DAV physical deletion stays frozen and retryable after a stale recycle rejects', async () => {
  const f = fixture(); f.fail();
  const recycling = f.files.recycleForProject('f', 'p').then(value => ({ value }), error => ({ error }));
  await f.stale.entered;
  const deleting = f.dav.deleteFile(account, 'notes.txt').then(value => ({ value }), error => ({ error }));
  await f.provider.entered;
  f.stale.release(); const recycled = await recycling;
  f.provider.release(); const deleted = await deleting;
  assert.equal(recycled.error?.getStatus?.(), 409);
  assert.equal(deleted.error?.getStatus?.(), 503);
  assert.equal(f.head().purgeAt.getTime(), 0);
  assert.equal(f.objects.has('old'), true);
  f.recover();
  await f.dav.deleteFile(account, 'notes.txt');
  assert.equal(f.head(), null);
  assert.equal(f.objects.size, 0);
});
