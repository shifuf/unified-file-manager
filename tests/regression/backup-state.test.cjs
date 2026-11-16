const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { gunzipSync } = require('node:zlib');
require('ts-node').register({ project: path.resolve(__dirname, '../../apps/api/tsconfig.json'), transpileOnly: true });
const { BackupService } = require('../../apps/api/src/backup/backup.service.ts');
require('@nestjs/common').Logger.overrideLogger(false);
const { BACKUP_MODELS, BACKUP_SCOPE_KEYS } = require('../../apps/api/src/backup/backup.constants.ts');
const user = { id: 'fixture-admin', role: 'SUPER_ADMIN' };

async function fixture(t, initial = []) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ufm-backup-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const rows = initial.map(row => ({ name: 'fixture', fileName: null, fileSize: 0n, checksum: null, tableCounts: null, tableRows: null, includeObjects: false, objectCount: 0, objectBytes: 0n, message: null, scopes: ['settings'], createdAt: new Date(0), updatedAt: new Date(0), startedAt: new Date(0), finishedAt: null, ...row }));
  const tables = {};
  const db = {};
  for (const model of [...BACKUP_MODELS, 'projectStorageBinding', 'storageReplica']) {
    tables[model] = [];
    db[model] = { findMany: async () => tables[model].map(row => ({ ...row })), deleteMany: async () => { const count = tables[model].length; tables[model] = []; return { count }; }, createMany: async ({ data }) => { tables[model].push(...data); return { count: data.length }; } };
  }
  db.backup = {
    findMany: async () => rows.map(row => ({ ...row })),
    findUnique: async ({ where }) => rows.find(row => row.id === where.id) || null,
    create: async ({ data }) => { const row = { id: `backup-${rows.length}`, name: 'fixture', fileName: null, fileSize: 0n, checksum: null, tableCounts: null, tableRows: null, objectCount: 0, objectBytes: 0n, message: null, createdAt: new Date(), updatedAt: new Date(), finishedAt: null, ...data }; rows.push(row); return { ...row }; },
    update: async ({ where, data }) => { if (Buffer.byteLength(data.message || '', 'utf8') > 65535) throw new Error('Data too long for column message'); const row = rows.find(row => row.id === where.id); if (!row) throw new Error('Record not found'); Object.assign(row, data); return { ...row }; },
    updateMany: async ({ where, data }) => { let count = 0; for (const row of rows) { if (where.id && row.id !== where.id) continue; if (where.status && row.status !== where.status) continue; if (where.startedAt?.lt && !(row.startedAt < where.startedAt.lt)) continue; Object.assign(row, data); count++; } return { count }; },
    delete: async ({ where }) => { const index = rows.findIndex(row => row.id === where.id); if (index < 0) throw new Error('Record not found'); return rows.splice(index, 1)[0]; },
  };
  const service = new BackupService({ write: async () => {} }, { get: key => key === 'BACKUP_ROOT' ? root : undefined }, db, null);
  return { service, db, rows, tables, root };
}

test('service startup marks interrupted backups failed while retaining completed backups', async t => {
  const f = await fixture(t, [{ id: 'interrupted', status: 'RUNNING' }, { id: 'complete', status: 'SUCCEEDED' }, { id: 'waiting', status: 'PENDING' }]);
  await f.service.onModuleInit?.();
  const result = await f.service.list(user);
  assert.equal(result.find(row => row.id === 'interrupted').status, 'FAILED');
  assert.ok(result.find(row => row.id === 'interrupted').finishedAt);
  assert.equal(result.find(row => row.id === 'complete').status, 'SUCCEEDED');
  assert.equal(result.find(row => row.id === 'waiting').status, 'PENDING');
  await f.service.remove('interrupted', user); assert.ok(!f.rows.some(row => row.id === 'interrupted'));
});
test('long backup errors persist FAILED within MySQL TEXT limits instead of leaving RUNNING', async t => {
  const f = await fixture(t);
  f.db.systemSetting.findMany = async () => { throw new Error('fixture-export-failure:' + '错误'.repeat(20000)); };
  await assert.rejects(f.service.create({ scopes: ['settings'] }, user));
  assert.equal(f.rows[0].status, 'FAILED'); assert.ok(f.rows[0].finishedAt); assert.ok(Buffer.byteLength(f.rows[0].message, 'utf8') < 65535);
});
test('failed archive generation is deletable and never exposes a downloadable file', async t => {
  const f = await fixture(t);
  f.db.systemSetting.findMany = async () => { throw new Error('fixture-export-failure'); };
  await assert.rejects(f.service.create({ scopes: ['settings'] }, user));
  const view = await f.service.get(f.rows[0].id, user); assert.equal(view.status, 'FAILED'); assert.equal(view.fileAvailable, false);
  await f.service.remove(view.id, user); assert.equal(f.rows.length, 0);
});
test('storage scope exports and restores bindings and replicas after their parent models', async t => {
  const f = await fixture(t);
  f.tables.cdnConfig.push({ id: 'cloud', name: 'fixture', provider: 'LOCAL' });
  f.tables.projectStorageBinding.push({ projectId: 'project', configId: 'cloud', createdAt: new Date(0) });
  f.tables.storageReplica.push({ id: 'replica', projectId: 'project', configId: 'cloud', storageKey: 'key', size: 10n, checksum: 'fixture-sha256', state: 'READY', attempts: 0, nextAttemptAt: new Date(0) });
  const result = await f.service.create({ scopes: ['storage'] }, user);
  const payload = JSON.parse(gunzipSync(await fs.readFile(path.join(f.root, result.fileName))));
  assert.equal(payload.tables.projectStorageBinding.length, 1); assert.equal(payload.tables.storageReplica[0].size, '10');
  const order = []; for (const name of ['cdnConfig', 'projectStorageBinding', 'storageReplica']) f.db[name].createMany = async ({ data }) => { order.push(name); if (name === 'storageReplica') assert.equal(typeof data[0].size, 'bigint'); return { count: data.length }; };
  const restored = await f.service.restore(result.id, { mode: 'merge' }, user);
  assert.deepEqual(order, ['cdnConfig', 'projectStorageBinding', 'storageReplica']); assert.equal(restored.restored.storageReplica, 1);
});
test('full archive contains no empty rows and preserves the current nonce delegate spelling', async t => {
  const f = await fixture(t);
  f.tables.openApiNonce.push({ id: 'nonce', nonce: 'fixture', projectId: 'project', expiresAt: new Date(0) });
  const result = await f.service.create({ scopes: BACKUP_SCOPE_KEYS }, user);
  const payload = JSON.parse(gunzipSync(await fs.readFile(path.join(f.root, result.fileName))));
  assert.equal(payload.tables.openApiNonce[0].nonce, 'fixture');
  assert.ok(Object.values(payload.tables).every(rows => rows.every(row => Object.keys(row).length)));
});
