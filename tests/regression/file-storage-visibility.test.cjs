const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Readable } = require('node:stream');
const { createHash } = require('node:crypto');
require('ts-node').register({ project: path.resolve(__dirname, '../../apps/api/tsconfig.json'), transpileOnly: true });
const { ReplicaService } = require('../../apps/api/src/storage/replica.service.ts');
const { FileReplicaService } = require('../../apps/api/src/storage/file-replica.service.ts');
const user = { id: 'admin', role: 'SUPER_ADMIN' };
const epoch = new Date('2026-11-14T00:00:00Z');
const config = (id, provider = 'UPYUN', enabled = true, priority = 10) => ({ id, name: id, provider, enabled, priority, projectId: null, createdAt: epoch, updatedAt: epoch, config: { password: 'private-credential' }, projectBindings: [] });
const file = (id, projectId, storageKey = `${id}/current`) => ({ id, projectId, storageKey, currentVersion: 3, updatedAt: epoch, cdnConfigId: 'old-source', size: 4n, checksum: null, status: 'ACTIVE', deletedAt: null, mimeType: 'text/plain', originalName: `${id}.txt` });
const row = (id, configId, status, extra = {}) => ({ id, projectId: 'p1', storageKey: 'f1/current', configId, size: 4n, checksum: null, status, attempts: 2, lastError: null, verifiedAt: status === 'READY' ? epoch : null, leaseOwner: null, leaseUntil: null, nextAttemptAt: epoch, createdAt: epoch, updatedAt: epoch, ...extra });

// Database-only fixture: it evaluates the Prisma predicates and preserves real
// service/worker logic. A missing project/key predicate is an immediate failure.
function matches(value, where = {}) {
  return Object.entries(where).every(([key, wanted]) => {
    if (key === 'OR') return wanted.some(part => matches(value, part));
    if (key === 'AND') return wanted.every(part => matches(value, part));
    if (key === 'config') return matches(value.config, wanted);
    if (key === 'projectBindings') return value.projectBindings.some(binding => matches(binding, wanted.some));
    if (key === 'project') return wanted.deletedAt === null;
    if (wanted && typeof wanted === 'object' && !(wanted instanceof Date)) {
      if ('in' in wanted) return wanted.in.includes(value[key]);
      if ('not' in wanted) return value[key] !== wanted.not;
      if ('lte' in wanted) return value[key] != null && value[key] <= wanted.lte;
      if ('gt' in wanted) return value[key] != null && value[key] > wanted.gt;
    }
    return value[key] === wanted;
  });
}

function fixture({ files = [file('f1', 'p1')], rows = [], denied = [] } = {}) {
  const configs = [config('local', 'LOCAL', true, 20), config('other-local', 'LOCAL', true, 30), config('cloud'), config('disabled', 'QINIU', false), config('unbound'), config('old-source', 'QINIU')];
  configs.find(c => c.id === 'local').projectBindings = [{ projectId: 'p1' }, { projectId: 'p2' }];
  configs.find(c => c.id === 'other-local').projectBindings = [{ projectId: 'p1' }];
  configs.find(c => c.id === 'cloud').projectBindings = [{ projectId: 'p1' }, { projectId: 'p2' }];
  configs.find(c => c.id === 'disabled').projectBindings = [{ projectId: 'p1' }];
  const accessCalls = [], queries = [], writes = [];
  const checked = new Set();
  const access = { assertProjectAccess: async (_user, id, admin = false) => { accessCalls.push([id, admin]); if (denied.includes(id)) throw new Error('access denied'); checked.add(id); } };
  const withConfig = r => ({ ...r, config: configs.find(c => c.id === r.configId) });
  const db = {
    managedFile: {
      findMany: async args => {
        queries.push(['files', args]);
        assert.ok(args.where.id.in.length <= 100);
        assert.deepEqual(args.where.status, { not: 'DELETED' });
        assert.equal(args.where.deletedAt, undefined);
        assert.equal(args.where.project.deletedAt, null);
        return files.filter(f => matches(f, args.where));
      },
      findFirst: async args => {
        queries.push(['file', args]);
        if (args.where.status === 'ACTIVE') assert.equal(args.where.deletedAt, null);
        else { assert.deepEqual(args.where.status, { not: 'DELETED' }); assert.equal(args.where.deletedAt, undefined); }
        return files.find(f => matches(f, args.where)) || null;
      },
      update: async () => assert.fail('replica operations must not alter a managed file'),
      updateMany: async () => assert.fail('replica operations must not alter current head'),
    },
    cdnConfig: {
      findMany: async args => {
        queries.push(['configs', args]);
        assert.ok(args.select && !args.select.config, 'configuration read uses safe fields only');
        return configs.filter(c => {
          if (args.where?.id?.in) return args.where.id.in.includes(c.id);
          return matches(c, args.where);
        });
      },
      findFirst: async args => {
        queries.push(['local', args]);
        assert.equal(args.where.provider, 'LOCAL'); assert.equal(args.where.enabled, true); assert.equal(args.where.projectId, null);
        return configs.filter(c => matches(c, args.where) && (!args.where.projectBindings || c.projectBindings.some(b => matches(b, args.where.projectBindings.some))))[0] || null;
      },
    },
    projectStorageBinding: {
      findMany: async args => {
        queries.push(['bindings', args]);
        const ids = args.where.projectId.in || [args.where.projectId];
        assert.ok(ids.every(id => checked.has(id)), 'all project gates precede metadata reads');
        return configs.flatMap(c => c.projectBindings.filter(b => ids.includes(b.projectId)).map(b => ({ ...b, configId: c.id, config: c })));
      },
      upsert: async () => assert.fail('metadata must not create a binding'),
    },
    storageReplica: {
      findMany: async args => {
        queries.push(['replicas', args]);
        if (args.where.AND || args.where.OR?.some(part => part.storageKey)) {
          const scopes = args.where.OR || args.where.AND.flatMap(part => part.OR || []);
          assert.ok(scopes.length <= 100 && scopes.every(s => s.projectId && s.storageKey), 'batch rows bounded by project and current object pairs');
          assert.ok(scopes.every(s => checked.has(s.projectId)));
        } else if (!args.where.nextAttemptAt) {
          assert.ok(args.where.projectId && args.where.storageKey, 'single read requires both project and current object scope');
        }
        return rows.map(withConfig).filter(r => matches(r, args.where)).slice(0, args.take || rows.length);
      },
      createMany: async args => {
        let count = 0;
        for (const data of args.data) {
          assert.equal(data.storageKey, 'f1/current', 'do not enqueue history, derivative, or other file');
          assert.equal(data.projectId, 'p1');
          if (rows.some(r => r.projectId === data.projectId && r.storageKey === data.storageKey && r.configId === data.configId)) continue;
          rows.push(row(`created-${data.configId}`, data.configId, data.status, data)); writes.push(data); count++;
        }
        return { count };
      },
      updateMany: async args => {
        assert.equal(args.where.projectId, 'p1'); assert.equal(args.where.storageKey, 'f1/current');
        let count = 0;
        for (const r of rows.filter(r => matches(r, args.where))) { Object.assign(r, args.data); writes.push(args.data); count++; }
        return { count };
      },
    },
    $queryRaw: async () => [],
    $transaction: async fn => fn(db),
  };
  const replicas = new ReplicaService({ get: () => undefined }, db, { adapter: () => assert.fail('metadata must not contact cloud storage') });
  function service() {
    return new FileReplicaService(db, access, replicas);
  }
  return { service, db, configs, rows, files, accessCalls, queries, writes, replicas };
}

test('file metadata exposes missing desired targets, unverified source, disabled and detached copies using an exact whitelist', async () => {
  const f = fixture({ rows: [row('detached', 'unbound', 'READY'), row('disabled-row', 'disabled', 'FAILED'), row('wrong-project', 'cloud', 'READY', { projectId: 'p2' }), row('old-version', 'cloud', 'READY', { storageKey: 'f1/old' })] });
  const result = await f.service().get('f1', user);
  assert.deepEqual(Object.keys(result).sort(), ['fileId', 'projectId', 'storageKey', 'currentVersion', 'canManage', 'updatedAt', 'items'].sort());
  const byId = Object.fromEntries(result.items.map(item => [item.configId, item]));
  assert.equal(byId.local.status, 'NOT_SYNCED'); assert.equal(byId.local.desired, true);
  assert.equal(byId.cloud.status, 'NOT_SYNCED'); assert.equal(byId.cloud.desired, true);
  assert.equal(byId['other-local'].desired, false);
  assert.equal(byId['old-source'].status, 'UNVERIFIED'); assert.equal(byId['old-source'].desired, false);
  assert.equal(byId.disabled.enabled, false); assert.equal(byId.disabled.assigned, true); assert.equal(byId.disabled.desired, false);
  assert.equal(byId.unbound.status, 'READY'); assert.equal(byId.unbound.assigned, false); assert.equal(byId.unbound.desired, false);
  assert.deepEqual(Object.keys(byId.unbound).sort(), ['configId', 'configName', 'provider', 'enabled', 'assigned', 'desired', 'priority', 'status', 'attempts', 'lastError', 'verifiedAt', 'replicaId'].sort());
  assert.equal(result.currentVersion, 3); assert.equal(result.canManage, true);
  assert.ok(!JSON.stringify(result).includes('private-credential')); assert.equal(f.writes.length, 0);
});

test('batch checks every project before bounded current-object metadata queries and preserves input order', async () => {
  const f = fixture({ files: [file('f1', 'p1'), file('f2', 'p2')], rows: [row('same-key-other-project', 'cloud', 'READY', { projectId: 'p2' })] });
  const result = await f.service().list('f2,f1,f2', user);
  assert.deepEqual(result.items.map(item => item.fileId), ['f2', 'f1']);
  assert.deepEqual(f.accessCalls, [['p2', false], ['p1', false]]);
  assert.equal(result.items.find(item => item.fileId === 'f1').items.find(item => item.configId === 'cloud').status, 'NOT_SYNCED');
  assert.equal(f.queries.filter(([kind]) => kind === 'replicas').length, 1, 'one batch replica query');
});

test('denied projects and unknown files reject the whole batch without replica reads', async () => {
  const f = fixture({ files: [file('f1', 'p1'), file('f2', 'p2')], denied: ['p2'] });
  await assert.rejects(f.service().list('f1,f2', user), /access denied/);
  assert.equal(f.queries.filter(([kind]) => kind === 'replicas').length, 0);
  await assert.rejects(f.service().get('missing', user), e => e.getStatus?.() === 404);
});

test('batch rejects empty, malformed and over-100 identifiers before database reads', async () => {
  const f = fixture();
  for (const ids of ['', 'f1,', 'f1,,f2', Array.from({ length: 101 }, (_, i) => `file-${i}`).join(',')]) {
    await assert.rejects(f.service().list(ids, user), e => e.getStatus?.() === 400);
  }
  assert.equal(f.queries.length, 0);
});

test('readable recycled and quarantined files expose metadata but cannot enqueue sync', async () => {
  const recycled = { ...file('recycled', 'p1'), status: 'RECYCLED', deletedAt: epoch };
  const quarantined = { ...file('quarantined', 'p1'), status: 'QUARANTINED' };
  const deleted = { ...file('deleted', 'p1'), status: 'DELETED', deletedAt: epoch };
  const f = fixture({ files: [file('f1', 'p1'), recycled, quarantined, deleted] });
  const service = f.service();
  const result = await service.list('f1,recycled,quarantined', user);
  assert.deepEqual(result.items.map(detail => detail.fileId), ['f1', 'recycled', 'quarantined']);
  assert.equal((await service.get('recycled', user)).storageKey, 'recycled/current');
  for (const id of ['recycled', 'quarantined']) await assert.rejects(service.sync(id, ['cloud'], user), e => e.getStatus?.() === 404);
  await assert.rejects(service.get('deleted', user), e => e.getStatus?.() === 404);
  assert.equal(f.writes.length, 0);
});

test('sync rejects disabled, detached and nonselected local targets before creating any row', async () => {
  const f = fixture();
  for (const ids of [['cloud', 'disabled'], ['unbound'], ['other-local'], ['unknown'], [], ['cloud', 7]]) {
    await assert.rejects(f.service().sync('f1', ids, user), e => e.getStatus?.() === 400);
  }
  assert.equal(f.writes.length, 0);
  assert.ok(f.accessCalls.some(([, admin]) => admin));
});

test('sync queues only selected current objects, keeps READY/live leases, and repeated requests are idempotent', async () => {
  const ready = row('ready', 'local', 'READY');
  const active = row('active', 'cloud', 'PENDING', { leaseOwner: 'worker', leaseUntil: new Date(Date.now() + 60_000) });
  const f = fixture({ rows: [ready, active, row('history', 'cloud', 'FAILED', { storageKey: 'f1/old' })] });
  const before = structuredClone(f.files);
  const oldReady = structuredClone(ready), oldActive = structuredClone(active);
  const result = await f.service().sync('f1', ['local', 'cloud', 'cloud'], user);
  assert.equal(result.queued, 0); assert.equal(result.currentVersion, 3); assert.equal(result.fileId, 'f1');
  assert.deepEqual(ready, oldReady); assert.deepEqual(active, oldActive); assert.deepEqual(f.files, before);
  assert.equal((await f.service().sync('f1', ['cloud'], user)).queued, 0);
  assert.equal(f.rows.find(r => r.id === 'history').status, 'FAILED');
});

test('missing rows and expired failed leases queue once while pending work is reused', async () => {
  const failed = row('failed', 'cloud', 'FAILED', { lastError: 'temporary', leaseOwner: 'expired', leaseUntil: new Date(0) });
  const f = fixture({ rows: [failed] });
  const service = f.service();
  const first = await service.sync('f1', ['local', 'cloud'], user);
  assert.equal(first.queued, 2); assert.equal(failed.status, 'PENDING'); assert.equal(failed.leaseOwner, null); assert.equal(failed.attempts, 2);
  assert.deepEqual(first.items.filter(i => ['local', 'cloud'].includes(i.configId)).map(i => i.status), ['PENDING', 'PENDING']);
  assert.equal((await service.sync('f1', ['local', 'cloud'], user)).queued, 0);
  assert.equal(f.rows.length, 2);
});

test('unverified READY targets really requeue once, while verified READY and live owned leases stay intact', async () => {
  const future = new Date(Date.now() + 60_000);
  for (const extra of [
    { verifiedAt: null },
    { verifiedAt: null, leaseOwner: null, leaseUntil: future },
    { verifiedAt: null, leaseOwner: 'expired', leaseUntil: new Date(0) },
  ]) {
    const unverified = row('unverified', 'cloud', 'READY', extra);
    const verified = row('verified', 'local', 'READY', { leaseOwner: 'expired', leaseUntil: new Date(0) });
    const f = fixture({ rows: [unverified, verified] });
    const beforeFile = structuredClone(f.files), beforeVerified = structuredClone(verified);
    const service = f.service();
    assert.equal((await service.get('f1', user)).items.find(i => i.configId === 'cloud').status, 'UNVERIFIED');
    const result = await service.sync('f1', ['cloud', 'local'], user);
    assert.equal(result.queued, 1, 'advertised unverified repair must create claimable PENDING work');
    assert.equal(unverified.status, 'PENDING');
    assert.equal(unverified.leaseOwner, null); assert.equal(unverified.leaseUntil, null);
    assert.equal(unverified.attempts, 2); assert.equal(unverified.verifiedAt, null);
    assert.equal(result.items.find(i => i.configId === 'cloud').status, 'PENDING');
    assert.equal((await service.sync('f1', ['cloud', 'local'], user)).queued, 0);
    assert.deepEqual(verified, beforeVerified); assert.deepEqual(f.files, beforeFile);
  }
  for (const extra of [
    { verifiedAt: null, leaseOwner: 'worker', leaseUntil: future },
    { verifiedAt: null, leaseOwner: 'worker', leaseUntil: null },
  ]) {
    const leased = row('leased', 'cloud', 'READY', extra);
    const f = fixture({ rows: [leased] }), before = structuredClone(leased);
    assert.equal((await f.service().sync('f1', ['cloud'], user)).queued, 0);
    assert.deepEqual(leased, before, 'a missing expiry does not authorize taking another worker\'s lease');
  }
});

test('metadata uses observation start time, so a slow old read is older than a newer READY snapshot', async t => {
  const firstTime = Date.parse('2030-01-01T00:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now: firstTime });
  const cloud = row('cloud', 'cloud', 'PENDING');
  const f = fixture({ rows: [cloud] }), service = f.service();
  let release, started;
  const waiting = new Promise(resolve => { release = resolve; });
  const reached = new Promise(resolve => { started = resolve; });
  const readRows = f.db.storageReplica.findMany;
  let reads = 0;
  f.db.storageReplica.findMany = async args => {
    const snapshot = await readRows(args);
    if (++reads === 1) { started(); await waiting; }
    return snapshot;
  };
  const oldRead = service.get('f1', user);
  await reached;
  t.mock.timers.setTime(firstTime + 1000);
  cloud.status = 'READY'; cloud.verifiedAt = new Date();
  const recent = await service.get('f1', user);
  t.mock.timers.setTime(firstTime + 2000);
  release();
  const old = await oldRead;
  assert.equal(old.items.find(i => i.configId === 'cloud').status, 'PENDING');
  assert.equal(recent.items.find(i => i.configId === 'cloud').status, 'READY');
  assert.equal(old.updatedAt.getTime(), firstTime, 'capture freshness before reading, not when a slow read completes');
  assert.equal(recent.updatedAt.getTime(), firstTime + 1000);
  assert.equal(f.files[0].updatedAt.getTime(), epoch.getTime(), 'observation never modifies the file');
  t.mock.timers.setTime(firstTime + 3000);
  const batch = await service.list('f1', user);
  assert.equal(batch.items[0].updatedAt.getTime(), firstTime + 3000);
  assert.equal(f.writes.length, 0);
});

test('verified state needs verifiedAt and managed-file head is reread under the transaction lock', async () => {
  const f = fixture({ rows: [row('unverified-ready', 'cloud', 'READY', { verifiedAt: null })] });
  assert.equal((await f.service().get('f1', user)).items.find(i => i.configId === 'cloud').status, 'UNVERIFIED');
  f.db.$queryRaw = async () => { f.files[0].storageKey = 'f1/current-after-lock'; f.files[0].currentVersion = 4; return []; };
  f.db.storageReplica.createMany = async ({ data }) => { assert.ok(data.every(d => d.storageKey === 'f1/current-after-lock')); return { count: data.length }; };
  f.db.storageReplica.updateMany = async ({ where }) => { assert.equal(where.storageKey, 'f1/current-after-lock'); return { count: 0 }; };
  const result = await f.service().sync('f1', ['local'], user);
  assert.equal(result.currentVersion, 4);
});

test('failed rows with a live lease remain untouched and parallel requests create each selected target once', async () => {
  const active = row('active-failed', 'cloud', 'FAILED', { leaseOwner: 'worker', leaseUntil: new Date(Date.now() + 60_000) });
  const f = fixture({ rows: [active] });
  const saved = structuredClone(active);
  const service = f.service();
  const results = await Promise.all([service.sync('f1', ['local', 'cloud'], user), service.sync('f1', ['local', 'cloud'], user)]);
  assert.equal(results.reduce((sum, result) => sum + result.queued, 0), 1);
  assert.deepEqual(active, saved);
  assert.equal(f.rows.filter(r => r.configId === 'local').length, 1);
});

test('unbound enabled local fallback is visible and selected without assigning it during GET', async () => {
  const f = fixture();
  f.configs.find(c => c.id === 'local').projectBindings = [];
  f.configs.find(c => c.id === 'other-local').projectBindings = [];
  const detail = await f.service().get('f1', user);
  const local = detail.items.find(item => item.configId === 'local');
  assert.equal(local.desired, true); assert.equal(local.assigned, false); assert.equal(local.status, 'NOT_SYNCED');
  assert.equal(f.writes.length, 0);
});

test('worker can verify an old current source without indexing or queueing the unassigned source', async () => {
  const bytes = Buffer.from('data');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const target = row('target', 'cloud', 'READY', { checksum: digest, verifiedAt: null });
  const source = config('old-source', 'QINIU');
  const destination = config('cloud');
  let uploaded = false;
  const db = {
    cdnConfig: { findMany: async ({ where }) => { assert.equal(where.projectBindings.some.projectId, 'p1'); return [destination]; } },
    managedFile: { findFirst: async ({ where }) => { assert.equal(where.projectId, 'p1'); assert.equal(where.storageKey, 'f1/current'); assert.equal(where.status, 'ACTIVE'); assert.equal(where.deletedAt, null); return { ...file('f1', 'p1'), cdnConfig: source }; } },
    projectStorageBinding: { findMany: async () => [{ configId: 'cloud', config: destination }] },
    storageReplica: {
      findMany: async ({ where }) => [{ ...target, config: destination }].filter(value => matches(value, where)),
      createMany: async ({ data, skipDuplicates }) => {
        assert.equal(skipDuplicates, true);
        assert.ok(data.every(value => value.projectId === 'p1' && value.storageKey === 'f1/current' && value.configId === 'cloud'));
        return { count: 0 };
      },
      updateMany: async ({ where, data }) => {
        if (!matches(target, where)) return { count: 0 };
        for (const [key, value] of Object.entries(data)) target[key] = value?.increment ? target[key] + value.increment : value;
        return { count: 1 };
      },
    },
  };
  const registry = { adapter: provider => ({ getUsage: async () => ({}), getDownloadTarget: async () => { if (provider === 'UPYUN' && !uploaded) throw new Error('missing'); return { type: 'stream', stream: Readable.from([bytes]) }; }, uploadFile: async (_config, params) => { uploaded = true; assert.equal(params.checksum, digest); return { storageKey: params.key }; } }) };
  const service = new ReplicaService({ get: () => 'test-key' }, db, registry);
  assert.deepEqual(await service.enqueueFileTargets(file('f1', 'p1'), ['cloud'], db), { queued: 1 });
  assert.equal(target.status, 'PENDING');
  assert.deepEqual(await service.runBatch('worker'), { scanned: 1, ready: 1, failed: 0 });
  assert.equal(target.status, 'READY'); assert.ok(target.verifiedAt);
});
