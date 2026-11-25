const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { spawn } = require('node:child_process');
const { gunzipSync } = require('node:zlib');
const { createHash, randomBytes } = require('node:crypto');
require('ts-node').register({ project: path.resolve(__dirname, '../../apps/api/tsconfig.json'), transpileOnly: true });
require('@nestjs/common').Logger.overrideLogger(false);
const { BackupService } = require('../../apps/api/src/backup/backup.service.ts');
const archiveUtils = require('../../apps/api/src/backup/backup-archive.util.ts');
const { validateBackupPayload } = archiveUtils;
const { BACKUP_MODELS } = require('../../apps/api/src/backup/backup.constants.ts');
const admin = { id: 'admin', role: 'SUPER_ADMIN' };

async function fixture(t, { objects = [], limit, plugin } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ufm-stream-backup-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const tables = Object.fromEntries(BACKUP_MODELS.map(model => [model, []]));
  const rows = [], reads = [];
  const matches = (row, where = {}) => Object.entries(where).every(([key, value]) => key === 'OR' ? value.some(part => matches(row, part))
    : value && typeof value === 'object' ? !('gt' in value) || row[key] > value.gt : row[key] === value);
  const page = (items, args = {}) => items.filter(row => matches(row, args.where)).slice(args.skip ?? 0, (args.skip ?? 0) + (args.take ?? items.length));
  const db = Object.fromEntries(BACKUP_MODELS.map(model => [model, { findMany: async args => page(tables[model], args) }]));
  db.managedFile.findMany = async args => args?.include?.cdnConfig ? page(objects, args) : page(tables.managedFile, args);
  db.backup = {
    create: async ({ data }) => { const row = { id: 'backup', fileName: null, fileSize: 0n, objectCount: 0, objectBytes: 0n, createdAt: new Date(), updatedAt: new Date(), ...data }; rows.push(row); return { ...row }; },
    update: async ({ data }) => { Object.assign(rows[0], data); return { ...rows[0] }; },
  };
  const storage = { getDownloadTarget: async file => { reads.push(file.id); return { type: 'stream', stream: file.stream(), contentLength: Number(file.size) }; } };
  const service = new BackupService({ write: async () => {} }, { get: (key, fallback) => key === 'BACKUP_ROOT' ? root : key === 'BACKUP_MAX_OBJECT_BYTES' ? limit ?? fallback : fallback }, db, storage, plugin ? { store: { list: () => [plugin], package: async () => plugin.bytes } } : undefined);
  return { root, service, tables, db, rows, reads };
}

test('large logical tables and LOCAL bytes finish in a 128MiB heap without dropping records', { timeout: 180000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ufm-backup-low-heap-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const child = spawn(process.execPath, ['--max-old-space-size=128', path.join(__dirname, 'fixtures/backup-low-heap.cjs'), root], { env: { ...process.env, NODE_OPTIONS: '' }, windowsHide: true });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-12000); });
  const timeout = setTimeout(() => child.kill(), 170000); t.after(() => clearTimeout(timeout));
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  assert.equal(code, 0, `backup child failed: ${stderr}`);
  const result = JSON.parse(stdout);
  assert.equal(result.status, 'SUCCEEDED'); assert.equal(result.settings, 25000);
  assert.equal(result.objectCount, 1); assert.equal(result.objectBytes, 50331653);
  assert.ok(result.expandedBytes > 150 * 1024 * 1024); assert.equal(result.foundLastRow, true); assert.equal(result.checksumValid, true);
  assert.equal(result.files.length, 1); assert.match(result.files[0], /\.json\.gz$/);
});

test('streamed v1 archive preserves paged rows, binary chunk boundaries and plugin packages', async t => {
  const bytes = Buffer.from([0, 1, 2, 3, 254, 255, 7]);
  const packageBytes = Buffer.from('fixture-plugin');
  const f = await fixture(t, { objects: [{ id: 'object', cdnConfigId: 'local', storageKey: 'folder/object.bin', originalName: '引号".bin', mimeType: 'application/octet-stream', size: 7n, stream: () => Readable.from([bytes.subarray(0, 1), bytes.subarray(1, 3), bytes.subarray(3)]) }], plugin: { id: 'FIXTURE', available: true, version: '1.0.0', sha256: createHash('sha256').update(packageBytes).digest('hex'), bytes: packageBytes } });
  f.tables.systemSetting.push(...Array.from({ length: 507 }, (_, i) => ({ key: String(i).padStart(4, '0'), value: { n: i } })));
  f.tables.storageReplica.push({ id: 'replica', size: 9007199254740993n, verifiedAt: new Date('2026-11-01T00:00:00Z') });
  const result = await f.service.create({ scopes: ['settings', 'projects', 'storage'], includeObjects: true }, admin);
  const payload = validateBackupPayload(JSON.parse(gunzipSync(await fs.readFile(path.join(f.root, result.fileName)))));
  assert.equal(payload.tables.systemSetting.length, 507); assert.deepEqual(payload.tables.systemSetting.at(-1), { key: '0506', value: { n: 506 } });
  assert.equal(payload.tables.storageReplica[0].size, '9007199254740993'); assert.equal(payload.tables.storageReplica[0].verifiedAt, '2026-11-01T00:00:00.000Z');
  assert.deepEqual(Buffer.from(payload.objects[0].data, 'base64'), bytes); assert.equal(payload.objects[0].originalName, '引号".bin');
  assert.deepEqual(Buffer.from(payload.plugins[0].data, 'base64'), packageBytes);
  assert.equal(result.objectCount, 1); assert.equal(result.objectBytes, 7); assert.equal(result.tableCounts.systemSetting, 507);
  assert.deepEqual(await fs.readdir(f.root), [result.fileName]);
});

test('an oversized LOCAL stream is stopped at the configured limit and leaves an explicit warning', async t => {
  let consumed = 0, closed = false;
  const f = await fixture(t, { limit: 10, objects: [{ id: 'large', cdnConfigId: 'local', storageKey: 'large', originalName: 'large', mimeType: 'application/octet-stream', stream: () => Readable.from((async function* () { try { for (let i = 0; i < 1000; i++) { consumed++; yield Buffer.alloc(4); } } finally { closed = true; } })()) }] });
  const result = await f.service.create({ scopes: ['projects'], includeObjects: true }, admin);
  const payload = validateBackupPayload(JSON.parse(gunzipSync(await fs.readFile(path.join(f.root, result.fileName)))));
  assert.equal(result.status, 'SUCCEEDED'); assert.equal(payload.objects.length, 0); assert.match(result.message, /上限.*未打包/);
  assert.ok(consumed < 1000, 'must stop reading instead of buffering the whole oversized object'); assert.equal(closed, true);
  assert.deepEqual(await fs.readdir(f.root), [result.fileName]);
});

test('composite-key storage bindings remain complete across multiple pages', async t => {
  const f = await fixture(t);
  for (let project = 0; project < 3; project++) for (let config = 0; config < 179; config++) {
    f.tables.projectStorageBinding.push({ projectId: `p${project}`, configId: `c${String(config).padStart(3, '0')}` });
  }
  const result = await f.service.create({ scopes: ['storage'] }, admin);
  const payload = validateBackupPayload(JSON.parse(gunzipSync(await fs.readFile(path.join(f.root, result.fileName)))));
  assert.equal(payload.tables.projectStorageBinding.length, 537);
  assert.equal(new Set(payload.tables.projectStorageBinding.map(row => `${row.projectId}/${row.configId}`)).size, 537);
  assert.deepEqual(payload.tables.projectStorageBinding.at(-1), { projectId: 'p2', configId: 'c178' });
});

test('a failed LOCAL read leaves a warning and the next object remains valid', async t => {
  const f = await fixture(t, { objects: [
    { id: '01-broken', cdnConfigId: 'local', storageKey: 'broken', originalName: 'broken', mimeType: 'application/octet-stream', stream: () => Readable.from((async function* () { yield Buffer.from('partial'); throw new Error('fixture-read-error'); })()) },
    { id: '02-good', cdnConfigId: 'local', storageKey: 'good', originalName: 'good', mimeType: 'application/octet-stream', size: 4n, stream: () => Readable.from([Buffer.from('good')]) },
  ] });
  const result = await f.service.create({ scopes: ['projects'], includeObjects: true }, admin);
  const payload = validateBackupPayload(JSON.parse(gunzipSync(await fs.readFile(path.join(f.root, result.fileName)))));
  assert.equal(payload.objects.length, 1); assert.equal(payload.objects[0].storageKey, 'good');
  assert.equal(Buffer.from(payload.objects[0].data, 'base64').toString(), 'good'); assert.match(result.message, /broken.*fixture-read-error/);
  assert.deepEqual(await fs.readdir(f.root), [result.fileName]);
});

test('archive writer enforces both import size limits and removes rejected output', async t => {
  const f = await fixture(t);
  const original = { expanded: archiveUtils.MAX_BACKUP_EXPANDED_BYTES, compressed: archiveUtils.MAX_BACKUP_ARCHIVE_BYTES };
  try {
    archiveUtils.MAX_BACKUP_EXPANDED_BYTES = 32;
    await assert.rejects(archiveUtils.writeBackupArchive(path.join(f.root, 'expanded.gz'), (async function* () { yield 'x'.repeat(64); })()), /解压后超过 32/);
    archiveUtils.MAX_BACKUP_EXPANDED_BYTES = 4096; archiveUtils.MAX_BACKUP_ARCHIVE_BYTES = 32;
    await assert.rejects(archiveUtils.writeBackupArchive(path.join(f.root, 'compressed.gz'), (async function* () { yield randomBytes(256).toString('base64'); })()), /文件超过 32/);
  } finally { archiveUtils.MAX_BACKUP_EXPANDED_BYTES = original.expanded; archiveUtils.MAX_BACKUP_ARCHIVE_BYTES = original.compressed; }
  assert.deepEqual(await fs.readdir(f.root), []);
});

test('a later table failure removes partial archive output', async t => {
  const f = await fixture(t); f.tables.project.push({ id: 'project', name: 'retained' });
  f.db.managedFolder.findMany = async () => { throw new Error('fixture-late-export-error'); };
  await assert.rejects(f.service.create({ scopes: ['projects'] }, admin), /fixture-late-export-error/);
  assert.equal(f.rows[0].status, 'FAILED'); assert.deepEqual(await fs.readdir(f.root), []);
});

test('archive failure during an object removes both staged object and partial gzip', async t => {
  const f = await fixture(t, { objects: [{ id: 'large', cdnConfigId: 'local', storageKey: 'large', originalName: 'large', mimeType: 'application/octet-stream', size: 16384n, stream: () => Readable.from([Buffer.alloc(16384, 0xff)]) }] });
  const original = archiveUtils.MAX_BACKUP_EXPANDED_BYTES;
  try {
    archiveUtils.MAX_BACKUP_EXPANDED_BYTES = 1024;
    await assert.rejects(f.service.create({ scopes: ['projects'], includeObjects: true }, admin), /解压后超过 1024/);
  } finally { archiveUtils.MAX_BACKUP_EXPANDED_BYTES = original; }
  assert.equal(f.rows[0].status, 'FAILED'); assert.deepEqual(await fs.readdir(f.root), []);
});
