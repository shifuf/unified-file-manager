const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { createHash } = require('node:crypto');
require('ts-node').register({ project: path.resolve(__dirname, '../../apps/api/tsconfig.json'), transpileOnly: true });
const { BackupService } = require('../../apps/api/src/backup/backup.service.ts');

async function fixture(t, fail = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ufm-remote-backup-'));
  t.after(() => fs.rm(root, { force: true, recursive: true }));
  const rows = [], uploads = [];
  const target = { id: 'drive', name: '阿里云盘', provider: 'ALIYUN_DRIVE', enabled: true, projectId: null };
  const prisma = {
    cdnConfig: { findFirst: async ({ where }) => where.id === target.id ? target : null },
    backup: {
      create: async ({ data }) => { const row = { id: 'backup', createdAt: new Date(), updatedAt: new Date(), ...data }; rows.push(row); return { ...row }; },
      update: async ({ data }) => { Object.assign(rows[0], data); return { ...rows[0] }; },
      findUnique: async () => rows[0],
    },
  };
  const service = new BackupService({ write: async () => {} }, { get: key => key === 'BACKUP_ROOT' ? root : undefined }, prisma, {
    uploadFileToConfig: async (id, params) => { uploads.push({ id, params, bytes: await fs.readFile(params.path) }); if (fail) throw new Error('cloud unavailable'); return { cdnConfigId: id, storageKey: params.key }; },
  });
  service.buildArchive = async () => {
    const bytes = Buffer.from('test backup');
    await fs.writeFile(path.join(root, 'archive.gz'), bytes);
    return { fileName: 'archive.gz', fileSize: bytes.length, checksum: createHash('sha256').update(bytes).digest('hex'), tableCounts: {}, tableRows: {}, objectCount: 0, objectBytes: 0, warnings: [] };
  };
  return { service, rows, uploads, root };
}
const user = { id: 'admin', role: 'SUPER_ADMIN' };

test('remote-only backup requires an enabled remote destination before creating a record', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.create({ retainLocal: false }, user), /远端/);
  await assert.rejects(f.service.create({ retainLocal: false, storageConfigId: 'missing' }, user), /存储/);
  assert.equal(f.rows.length, 0);
});

test('remote-only backup uploads through verified storage and removes local only after success', async t => {
  const f = await fixture(t);
  const result = await f.service.create({ storageConfigId: 'drive', retainLocal: false }, user);
  assert.equal(f.uploads.length, 1);
  assert.equal(f.uploads[0].bytes.toString(), 'test backup');
  assert.equal(f.uploads[0].params.size, 11);
  assert.equal(f.uploads[0].params.checksum, createHash('sha256').update('test backup').digest('hex'));
  assert.equal(f.uploads[0].params.buffer, undefined);
  assert.equal(result.status, 'SUCCEEDED');
  assert.equal(result.destination.status, 'VERIFIED');
  assert.equal(result.destination.configId, 'drive');
  assert.equal(result.retainLocal, false);
  assert.equal(result.fileAvailable, false);
  await assert.rejects(fs.stat(path.join(f.root, 'archive.gz')));
});

test('cloud failure keeps the local archive and records failed upload for retry', async t => {
  const f = await fixture(t, true);
  await assert.rejects(f.service.create({ storageConfigId: 'drive', retainLocal: false }, user), /cloud unavailable/);
  assert.equal(f.rows[0].status, 'FAILED');
  assert.equal(f.rows[0].destination.status, 'FAILED');
  assert.equal((await fs.readFile(path.join(f.root, 'archive.gz'))).toString(), 'test backup');
});

test('legacy local backup continues retaining its file by default', async t => {
  const f = await fixture(t);
  const result = await f.service.create({}, user);
  assert.equal(result.fileAvailable, true);
  assert.equal(result.retainLocal, true);
  assert.equal(result.destination, null);
  assert.equal(f.uploads.length, 0);
});
