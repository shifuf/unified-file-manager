const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
require('ts-node').register({ project: path.resolve(__dirname, '../../apps/api/tsconfig.json'), transpileOnly: true });
const { ReplicaService } = require('../../apps/api/src/storage/replica.service.ts');
const { ReplicaController } = require('../../apps/api/src/storage/replica.controller.ts');

function fixture(total = 25) {
  const rows = Array.from({ length: total }, (_, i) => ({ id: String(i + 1).padStart(3, '0'), projectId: 'p', configId: 'cloud', storageKey: `key/${i}`, size: 3n, status: i < 2 ? 'FAILED' : 'READY', config: { name: 'Cloud', provider: 'UPYUN', config: { password: 'private' } } }));
  const reads = [];
  const table = {
    count: async ({ where }) => { assert.deepEqual(where, { projectId: 'p' }); return rows.length; },
    groupBy: async ({ where }) => { assert.deepEqual(where, { projectId: 'p' }); return [{ status: 'FAILED', _count: { _all: 2 } }, { status: 'READY', _count: { _all: Math.max(0, rows.length - 2) } }]; },
    findMany: async args => {
      reads.push(args);
      assert.equal(args.where.projectId, 'p');
      assert.deepEqual(args.orderBy, { id: 'asc' });
      assert.ok(Number.isInteger(args.take) && args.take > 0 && args.take <= 200, 'bounded integer query');
      const selected = args.where.id ? rows.filter(r => r.id > args.where.id.gt) : rows;
      return selected.slice(args.skip || 0, (args.skip || 0) + args.take);
    },
  };
  return { service: new ReplicaService({ get: () => undefined }, { storageReplica: table }, {}), reads };
}

test('page mode returns bounded last page and project-wide totals and counts', async () => {
  const { service, reads } = fixture();
  const result = await service.listProject('p', undefined, 100, { page: '999', pageSize: '10' });
  assert.equal(result.total, 25);
  assert.equal(result.page, 3);
  assert.equal(result.pageSize, 10);
  assert.deepEqual(result.items.map(r => r.id), ['021', '022', '023', '024', '025']);
  assert.deepEqual(result.counts, { FAILED: 2, READY: 23 });
  assert.equal(reads[0].skip, 20);
  assert.equal(result.nextCursor, null);
});

test('empty page mode preserves a coherent default page and size', async () => {
  const { service } = fixture(0);
  const result = await service.listProject('p', undefined, 100, {});
  assert.equal(result.total, 0);
  assert.equal(result.page, 1);
  assert.equal(result.pageSize, 20);
  assert.deepEqual(result.items, []);
});

test('page mode rejects fractional, unsafe, negative and unsupported page sizes before reading', async () => {
  const { service, reads } = fixture();
  for (const options of [{ page: '1.5' }, { page: '0' }, { page: '-1' }, { page: 'NaN' }, { page: '9007199254740992' }, { page: true }, { page: ['1'] }, { pageSize: '15' }, { pageSize: '20.5' }, { pageSize: '0' }]) {
    await assert.rejects(service.listProject('p', undefined, 100, options), e => e.getStatus?.() === 400);
  }
  assert.equal(reads.length, 0);
});

test('legacy cursor and limit retain bounded stable ordering', async () => {
  const { service } = fixture();
  const result = await service.listProject('p', '010', 3);
  assert.deepEqual(result.items.map(r => r.id), ['011', '012', '013']);
  assert.equal(result.nextCursor, '013');
});

test('a disappearing last page refreshes totals and all-project status counts before clamping', async () => {
  let purged = false;
  const table = {
    count: async ({ where }) => { assert.deepEqual(where, { projectId: 'p' }); return purged ? 10 : 25; },
    groupBy: async ({ where }) => { assert.deepEqual(where, { projectId: 'p' }); return [{ status: 'READY', _count: { _all: purged ? 10 : 25 } }]; },
    findMany: async args => {
      assert.equal(args.where.projectId, 'p'); assert.equal(args.take, 10);
      if (args.skip === 20) { purged = true; return []; }
      assert.equal(args.skip, 0);
      return Array.from({ length: 10 }, (_, i) => ({ id: String(i + 1), size: 1n, status: 'READY' }));
    },
  };
  const service = new ReplicaService({}, { storageReplica: table }, {});
  const result = await service.listProject('p', undefined, 100, { page: 3, pageSize: 10 });
  assert.equal(result.page, 1); assert.equal(result.total, 10); assert.equal(result.items.length, 10);
  assert.deepEqual(result.counts, { READY: 10 });
});

test('controller accepts explicit page inputs and keeps legacy calls compatible', async () => {
  const { service } = fixture();
  const access = { assertProjectAccess: async (_user, projectId) => assert.equal(projectId, 'p') };
  const controller = new ReplicaController(access, service);
  const user = { id: 'admin', role: 'SUPER_ADMIN' };
  const result = await controller.list('p', undefined, undefined, user, '2', '10');
  assert.equal(result.page, 2);
  assert.equal(result.items[0].id, '011');
  assert.equal((await controller.list('p', '020', '3', user)).nextCursor, '023');
});
