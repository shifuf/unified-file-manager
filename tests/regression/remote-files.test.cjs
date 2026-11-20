const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const { createHash } = require('node:crypto');
const { gzipSync } = require('node:zlib');
require('ts-node').register({ project: path.resolve(__dirname, '../../apps/api/tsconfig.json'), transpileOnly: true });
const { RemoteFilesService } = require('../../apps/api/src/files/remote-files.service.ts');
const { RemoteFilesController } = require('../../apps/api/src/files/remote-files.controller.ts');
const { BackupService } = require('../../apps/api/src/backup/backup.service.ts');
const { BACKUP_FORMAT_VERSION } = require('../../apps/api/src/backup/backup.constants.ts');
const { ProjectAccessService } = require('../../apps/api/src/projects/project-access.service.ts');
const { validate } = require('class-validator');
const { plainToInstance } = require('class-transformer');
const { ImportRemoteFilesDto } = require('../../apps/api/src/files/dto/remote-files.dto.ts');
require('@nestjs/common').Logger.overrideLogger(false);

const user = { id: 'admin', username: 'admin', displayName: 'Admin', role: 'SUPER_ADMIN', totpEnabled: false };
const sha1 = bytes => createHash('sha1').update(bytes).digest('hex');
const status = code => error => error.getStatus?.() === code;

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ufm-remote-files-test-'));
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const settings = { REMOTE_FILE_TEMP_ROOT: path.join(root, 'temp'), BACKUP_ROOT: path.join(root, 'backups') };
  const configService = { get: (key, fallback) => settings[key] ?? fallback };
  const config = { id: 'drive', name: 'fixture', provider: 'ALIYUN_DRIVE', config: {}, enabled: true, projectId: null };
  const project = { id: 'project', name: 'fixture project', enabled: true, deletedAt: null };
  const projects = new Map([[project.id, project]]);
  const calls = { listed: [], read: [], uploaded: [], backups: [] };
  const entries = new Map();
  const indexRows = [];
  const adapter = {
    listRemoteFiles: async (_, query) => { calls.listed.push(query); return { parentId: 'root', nextCursor: '', items: [] }; },
    readRemoteFile: async (_, id, options) => {
      calls.read.push({ id, options });
      const entry = entries.get(id);
      if (!entry) throw new Error('fixture cloud https://signed.invalid/file?token=fixture-private-token');
      const bytes = entry.bytes ?? Buffer.from('abc');
      return { name: entry.name ?? `${id}.txt`, size: entry.size ?? bytes.length, mimeType: 'text/plain', sha1: entry.sha1 ?? sha1(bytes), stream: entry.stream?.() ?? Readable.from([bytes]) };
    },
  };
  const prisma = {
    $queryRaw: async query => { calls.localQueries ??= []; calls.localQueries.push(query); return indexRows; },
    cdnConfig: { findFirst: async ({ where }) => where.id === config.id && config.enabled === true ? config : null },
    project: { findFirst: async ({ where }) => { const found = projects.get(where.id); return found && !found.deletedAt && found.enabled ? found : null; } },
    backup: { create: async ({ data }) => { const row = { id: `backup-${calls.backups.length}`, retainLocal: true, destination: null, createdAt: new Date(), updatedAt: new Date(), ...data }; calls.backups.push(row); return row; } },
  };
  const manifest = { capabilities: { remoteFiles: true } };
  const registry = { manifest: () => manifest, adapter: () => adapter };
  const uploads = { maxFileSizeBytes: 8, maxFileSizeMb: 1, maxBatchUploadCount: 20 };
  const filesService = { upload: async (projectId, files, actor, options) => {
    const file = files[0];
    calls.uploaded.push({ projectId, file, actor, options, bytes: await fs.readFile(file.path), name: Buffer.from(file.originalname, 'latin1').toString('utf8') });
    return [{ id: 'managed-file' }];
  } };
  const backups = new BackupService({ write: async () => {} }, configService, prisma, null, null);
  const service = new RemoteFilesService(prisma, registry, { runtimeConfig: row => ({ id: row.id, provider: row.provider, name: row.name, config: row.config }) }, filesService, backups, new ProjectAccessService(prisma), { getUploadLimits: async () => uploads }, configService);
  t.after(() => service.onModuleDestroy?.());
  return { service, root, settings, config, project, projects, calls, entries, indexRows, adapter, manifest, uploads, filesService };
}

async function assertTempEmpty(f) {
  const files = await fs.readdir(f.settings.REMOTE_FILE_TEMP_ROOT).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
  assert.deepEqual(files, [], 'every staged temporary file and task directory must be removed');
}

async function finishedJob(f, job) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const state = await f.service.getJob('drive', job.id, user);
    if (state.status !== 'RUNNING') return state;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('A small verified transfer did not settle');
}

test('asynchronous cloud retrieval returns before reading and keeps one user execution slot until preparation finishes', async t => {
  const f = await fixture(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  f.entries.set('file', { name: '已校验.txt', bytes: Buffer.from('abc'), stream: () => Readable.from((async function* () { await gate; yield Buffer.from('abc'); })()) });
  const job = await f.service.startDownloadJob('drive', 'file', user);
  assert.equal(job.kind, 'DOWNLOAD'); assert.equal(job.status, 'RUNNING');
  assert.equal((await f.service.getJob('drive', job.id, user)).status, 'RUNNING');
  await assert.rejects(f.service.startDownloadJob('drive', 'file', user), status(409));
  await assert.rejects(f.service.getJob('drive', job.id, { ...user, id: 'other' }), status(404));
  await assert.rejects(f.service.getJob('other-config', job.id, user), status(404));
  await assert.rejects(f.service.getJob('drive', job.id, { ...user, role: 'PROJECT_ADMIN' }), status(403));
  release();
  const ready = await finishedJob(f, job);
  assert.equal(ready.status, 'SUCCEEDED'); assert.equal(ready.name, '已校验.txt'); assert.equal(ready.size, 3);
  assert.ok(!JSON.stringify(ready).includes(f.root));
  let releaseNext;
  const nextGate = new Promise(resolve => { releaseNext = resolve; });
  t.after(() => releaseNext());
  f.entries.set('next', { bytes: Buffer.from('abc'), stream: () => Readable.from((async function* () { await nextGate; yield Buffer.from('abc'); })()) });
  const next = await f.service.startDownloadJob('drive', 'next', user);
  assert.equal(next.status, 'RUNNING', 'a prepared file does not block another execution');
  const file = await f.service.takeDownload('drive', job.id, user);
  await assert.rejects(f.service.takeDownload('drive', job.id, user), status(404));
  const parts = []; for await (const part of file.stream) parts.push(part);
  assert.equal(Buffer.concat(parts).toString(), 'abc');
  await file.cleanup();
  await assert.rejects(f.service.startDownloadJob('drive', 'file', user), status(409), 'cleaning the old file cannot unlock another active transfer');
  releaseNext();
  await finishedJob(f, next);
  await (await f.service.takeDownload('drive', next.id, user)).cleanup();
  await assertTempEmpty(f);
});

test('asynchronous multi-project import exposes its finished results without a second cloud read', async t => {
  const f = await fixture(t);
  f.projects.set('other', { ...f.project, id: 'other' });
  f.entries.set('file', { bytes: Buffer.from('abc') });
  const job = await f.service.startImportJob('drive', { projectIds: ['project', 'other'], fileIds: ['file'] }, user);
  const done = await finishedJob(f, job);
  assert.equal(done.status, 'SUCCEEDED');
  assert.equal(done.result.imported, 2);
  assert.equal(f.calls.read.length, 1);
  assert.deepEqual((await f.service.getJob('drive', job.id, user)).result, done.result);
  await assertTempEmpty(f);
});

test('asynchronous failed downloads redact errors and expired ready downloads clean up without being consumed', async t => {
  const f = await fixture(t);
  f.entries.set('bad', { bytes: Buffer.from('abc'), sha1: '0'.repeat(40) });
  const bad = await f.service.startDownloadJob('drive', 'bad', user);
  const failed = await finishedJob(f, bad);
  assert.equal(failed.status, 'FAILED'); assert.equal(typeof failed.error, 'string');
  assert.ok(!JSON.stringify(failed).includes(f.root));
  f.entries.set('good', { bytes: Buffer.from('abc') });
  const ready = await f.service.startDownloadJob('drive', 'good', user);
  await finishedJob(f, ready);
  const now = Date.now; t.after(() => { Date.now = now; });
  Date.now = () => now() + 11 * 60 * 1000;
  await assert.rejects(f.service.getJob('drive', ready.id, user), status(404));
  await assertTempEmpty(f);
  Date.now = now;
  const next = await f.service.startDownloadJob('drive', 'good', user);
  await finishedJob(f, next);
});

test('shutdown aborts a running cloud job and cleans up late work instead of exposing a stale download', async t => {
  const f = await fixture(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  f.adapter.readRemoteFile = async () => { await gate; return { name: 'late.txt', size: 3, sha1: sha1(Buffer.from('abc')), stream: Readable.from([Buffer.from('abc')]) }; };
  const job = await f.service.startDownloadJob('drive', 'file', user);
  await f.service.onModuleDestroy();
  release();
  for (let i = 0; i < 10; i++) await new Promise(resolve => setTimeout(resolve, 5));
  await assert.rejects(f.service.getJob('drive', job.id, user), status(404));
  await assertTempEmpty(f);
});

test('a prepared download automatically expires and releases its user slot even without status polling', async t => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  f.entries.set('file', { bytes: Buffer.from('abc') });
  const job = await f.service.startDownloadJob('drive', 'file', user);
  let ready;
  for (let i = 0; i < 5000; i++) {
    ready = await f.service.getJob('drive', job.id, user);
    if (ready.status === 'SUCCEEDED') break;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(ready.status, 'SUCCEEDED');
  t.mock.timers.tick(10 * 60 * 1000);
  // No status request drives expiry: only its completion timer may remove data.
  let cleared = false;
  for (let i = 0; i < 5000; i++) {
    const names = await fs.readdir(f.settings.REMOTE_FILE_TEMP_ROOT);
    if (!names.length) { cleared = true; break; }
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(cleared, true);
  await assert.rejects(f.service.getJob('drive', job.id, user), status(404));
  const again = await f.service.startDownloadJob('drive', 'file', user);
  assert.equal(again.status, 'RUNNING');
});

test('graceful shutdown waits for an active staged pipeline to remove its owned directory', async t => {
  const f = await fixture(t);
  f.adapter.readRemoteFile = async () => ({ name: 'partial.txt', size: 6, sha1: sha1(Buffer.from('abcdef')), stream: new Readable({ read() { this.push(Buffer.from('abc')); this._read = () => {}; } }) });
  await f.service.startDownloadJob('drive', 'file', user);
  let writing = false;
  for (let attempt = 0; attempt < 1000; attempt++) {
    const names = await fs.readdir(f.settings.REMOTE_FILE_TEMP_ROOT).catch(() => []);
    if (names.length) { writing = true; break; }
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(writing, true);
  await f.service.onModuleDestroy();
  await assertTempEmpty(f);
});

test('a long sequential import evicts completed results instead of exhausting the running job capacity', async t => {
  const f = await fixture(t);
  f.entries.set('file', { bytes: Buffer.from('abc') });
  let first;
  for (let index = 0; index < 130; index++) {
    const job = await f.service.startImportJob('drive', { projectId: 'project', fileIds: ['file'] }, user);
    first ||= job;
    assert.equal((await finishedJob(f, job)).result.imported, 1);
  }
  assert.equal(f.calls.uploaded.length, 130);
  await assert.rejects(f.service.getJob('drive', first.id, user), status(404));
  await assertTempEmpty(f);
});

test('remote file management denies non-admins before any configuration or network access', async t => {
  const f = await fixture(t);
  const guest = { ...user, role: 'PROJECT_ADMIN' };
  await assert.rejects(f.service.list('drive', {}, guest), status(403));
  await assert.rejects(f.service.download('drive', 'file', guest), status(403));
  await assert.rejects(f.service.import('drive', { projectId: 'project', fileIds: ['file'] }, guest), status(403));
  assert.equal(f.calls.listed.length + f.calls.read.length, 0);
});

test('remote files require an enabled storage configuration and declared plugin capability', async t => {
  const f = await fixture(t);
  f.config.enabled = false;
  await assert.rejects(f.service.list('drive', {}, user), status(404));
  f.config.enabled = true;
  f.manifest.capabilities.remoteFiles = false;
  await assert.rejects(f.service.list('drive', {}, user), status(400));
  await assert.rejects(f.service.download('drive', 'file', user), status(400));
  assert.equal(f.calls.listed.length + f.calls.read.length, 0);
});

test('remote file parameters reject URL-shaped IDs, control characters, traversal and more than 20 files', async t => {
  const f = await fixture(t);
  for (const query of [{ parentId: '../outside' }, { cursor: 'bad\nmarker' }, { cursor: 'x'.repeat(2049) }]) {
    await assert.rejects(f.service.list('drive', query, user), status(400));
  }
  await assert.rejects(f.service.download('drive', 'https://outside.invalid/file', user), status(400));
  for (const dto of [
    { projectId: 'project', fileIds: [] },
    { projectId: 'project', fileIds: Array.from({ length: 21 }, (_, i) => `file-${i}`) },
    { projectId: 'project', fileIds: ['file', 'file'] },
    { projectId: 'project', fileIds: ['file'], folderPath: '../outside' },
  ]) await assert.rejects(f.service.import('drive', dto, user), status(400));
  assert.equal(f.calls.listed.length + f.calls.read.length, 0);
});

test('remote listing preserves pagination and verified names while excluding arbitrary provider fields', async t => {
  const f = await fixture(t);
  f.adapter.listRemoteFiles = async (_, query) => {
    assert.deepEqual(query, { parentId: 'folder', cursor: 'page-two' });
    return { parentId: 'folder', nextCursor: 'page-three', items: [{ id: 'file', parentId: 'folder', type: 'file', name: 'hash-object', originalName: '原始文件.txt', size: 3, sha1: sha1(Buffer.from('abc')), downloadUrl: 'https://signed.invalid/private', accessToken: 'fixture-private-token' }] };
  };
  const page = await f.service.list('drive', { parentId: 'folder', cursor: 'page-two' }, user);
  assert.equal(page.nextCursor, 'page-three');
  assert.equal(page.items[0].originalName, '原始文件.txt');
  assert.equal(page.items[0].name, 'hash-object');
  assert.ok(!JSON.stringify(page).includes('signed.invalid'));
  assert.ok(!JSON.stringify(page).includes('fixture-private-token'));
});

test('remote provider failures remain failures and never disclose signed URLs', async t => {
  const f = await fixture(t);
  f.adapter.listRemoteFiles = async () => { throw new Error('https://signed.invalid/file?token=fixture-private-token'); };
  await assert.rejects(f.service.list('drive', {}, user), error => error.getStatus() === 502 && !JSON.stringify(error.getResponse()).includes('signed.invalid'));
  const result = await f.service.import('drive', { projectId: 'project', fileIds: ['missing'] }, user);
  assert.equal(result.failed, 1);
  assert.ok(!JSON.stringify(result).includes('signed.invalid'));
  assert.ok(!JSON.stringify(result).includes('fixture-private-token'));
});

test('remote listing exposes bounded portable project identity and relative directory without extra provider data', async t => {
  const f = await fixture(t);
  let metadata = { project: { id: 'source-project', name: '产品/设计资料', accessToken: 'private-field' }, folderPath: '素材/2026' };
  f.adapter.listRemoteFiles = async () => ({ parentId: 'root', nextCursor: '', items: [{ id: 'file', parentId: 'root', name: '说明.txt', type: 'file', size: 3, ...metadata }] });
  const page = await f.service.list('drive', {}, user);
  assert.deepEqual(page.items[0].project, { id: 'source-project', name: '产品/设计资料' });
  assert.equal(page.items[0].folderPath, '素材/2026');
  assert.ok(!JSON.stringify(page).includes('private-field'));
  for (const invalid of [
    { project: { id: '../outside', name: '资料' } },
    { project: { id: 'project', name: 'bad\nname' } },
    { project: { id: 'project', name: 'x'.repeat(256) } },
    { folderPath: '/absolute' }, { folderPath: 'a/../b' }, { folderPath: 'a\\b' },
    { folderPath: 'a\nb' }, { folderPath: 'x'.repeat(1025) },
  ]) {
    metadata = invalid;
    await assert.rejects(f.service.list('drive', {}, user), status(502));
  }
});

test('remote imports verify project access before requesting any cloud file', async t => {
  const f = await fixture(t);
  f.project.deletedAt = new Date();
  await assert.rejects(f.service.import('drive', { projectId: 'project', fileIds: ['file'] }, user), status(404));
  assert.equal(f.calls.read.length, 0);
});

test('multi-project sync downloads each cloud file once and survives each upload consuming its temporary path', async t => {
  const f = await fixture(t);
  f.projects.set('other', { ...f.project, id: 'other', name: '另一个项目' });
  f.entries.set('file', { name: '同步.txt', bytes: Buffer.from('abc') });
  const uploads = [];
  f.filesService.upload = async (projectId, files, actor, options) => {
    const content = await fs.readFile(files[0].path);
    uploads.push({ projectId, content: content.toString(), options, actor: actor.id });
    await fs.unlink(files[0].path);
    return [{ id: `managed-${projectId}` }];
  };
  const result = await f.service.import('drive', { projectIds: ['project', 'other'], fileIds: ['file'], folderPath: '资料/说明' }, user);
  assert.equal(result.imported, 2);
  assert.equal(result.failed, 0);
  assert.equal(f.calls.read.length, 1);
  assert.deepEqual(uploads.map(item => [item.projectId, item.content]), [['project', 'abc'], ['other', 'abc']]);
  assert.ok(uploads.every(item => item.options.duplicateStrategy === 'reuse' && item.options.folderPath === '资料/说明'));
  assert.deepEqual(result.items.map(item => [item.projectId, item.fileId]), [['project', 'managed-project'], ['other', 'managed-other']]);
  await assertTempEmpty(f);
});

test('multi-project sync rejects an inaccessible target before listing or downloading cloud content', async t => {
  const f = await fixture(t);
  f.entries.set('file', { bytes: Buffer.from('abc') });
  await assert.rejects(f.service.import('drive', { projectIds: ['project', 'missing'], fileIds: ['file'] }, user), status(404));
  assert.equal(f.calls.read.length + f.calls.listed.length + f.calls.uploaded.length, 0);
  await assertTempEmpty(f);
});

test('remote import pins every fresh proof before a slow first file crosses the snapshot lifetime', async t => {
  const f = await fixture(t);
  const bytes = Buffer.from('abc');
  f.adapter.listRemoteFiles = async () => ({ parentId: 'root', nextCursor: '', items: ['first', 'second'].map(id => ({ id, parentId: 'root', type: 'file', name: `${id}.txt`, originalName: `${id}-原名.txt`, size: bytes.length, sha1: sha1(bytes) })) });
  f.entries.set('first', { bytes });
  f.entries.set('second', { bytes });
  await f.service.list('drive', {}, user);
  const now = Date.now;
  t.after(() => { Date.now = now; });
  const upload = f.filesService.upload;
  f.filesService.upload = async (...args) => {
    const result = await upload(...args);
    Date.now = () => now() + 6 * 60 * 1000;
    return result;
  };
  const result = await f.service.import('drive', { projectId: 'project', fileIds: ['first', 'second'] }, user);
  assert.equal(result.imported, 2);
  assert.equal(result.failed, 0);
  assert.deepEqual(f.calls.uploaded.map(item => item.name), ['first-原名.txt', 'second-原名.txt']);
  assert.equal(f.calls.read.length, 2);
  await assertTempEmpty(f);
});

test('multi-project sync retains successful targets when another project upload fails', async t => {
  const f = await fixture(t);
  f.projects.set('other', { ...f.project, id: 'other' });
  f.entries.set('file', { bytes: Buffer.from('abc') });
  f.filesService.upload = async (projectId, files) => {
    await fs.readFile(files[0].path);
    await fs.unlink(files[0].path);
    if (projectId === 'project') throw new Error('https://signed.invalid/failure?token=hidden');
    return [{ id: 'other-file' }];
  };
  const result = await f.service.import('drive', { projectIds: ['project', 'other'], fileIds: ['file'] }, user);
  assert.equal(result.imported, 1);
  assert.equal(result.failed, 1);
  assert.deepEqual(result.items.map(item => [item.projectId, item.status]), [['project', 'FAILED'], ['other', 'IMPORTED']]);
  assert.ok(!JSON.stringify(result).includes('signed.invalid'));
  assert.equal(f.calls.read.length, 1);
  await assertTempEmpty(f);
});

test('multi-project sync validates target combinations and bounded unique project selections', async t => {
  const f = await fixture(t);
  for (const extra of [
    { projectIds: [] }, { projectIds: ['project', 'project'] }, { projectIds: Array.from({ length: 21 }, (_, i) => `p-${i}`) },
    { projectIds: ['../project'] }, { projectIds: ['project'], projectId: 'project' }, { projectIds: ['project'], asBackup: true },
  ]) await assert.rejects(f.service.import('drive', { fileIds: ['file'], ...extra }, user), status(400));
  const valid = plainToInstance(ImportRemoteFilesDto, { projectIds: ['project', 'other'], fileIds: ['file'] });
  assert.deepEqual(await validate(valid), []);
  assert.equal(f.calls.read.length, 0);
});

test('remote imports pass the upload ceiling to the plugin and refuse oversized streams before consuming bytes', async t => {
  const f = await fixture(t);
  let consumed = false;
  f.entries.set('large', { size: 9, stream: () => Readable.from((async function* () { consumed = true; yield Buffer.from('oversized'); })()) });
  const result = await f.service.import('drive', { projectId: 'project', fileIds: ['large'] }, user);
  assert.equal(result.failed, 1);
  assert.equal(f.calls.read[0].options.maxBytes, 8);
  assert.equal(consumed, false);
  assert.equal(f.calls.uploaded.length, 0);
  await assertTempEmpty(f);
});

test('remote transfer timeout propagates to the plugin together with the upload ceiling', async t => {
  const f = await fixture(t);
  f.settings.REMOTE_FILE_TIMEOUT_MS = '7500';
  f.entries.set('file', { bytes: Buffer.from('abc') });
  const result = await f.service.import('drive', { projectId: 'project', fileIds: ['file'] }, user);
  assert.equal(result.imported, 1);
  assert.deepEqual(f.calls.read[0].options, { maxBytes: 8, timeoutMs: 7500 });
  await assertTempEmpty(f);
});

test('remote transfer timeout clamps positive settings and falls back for invalid values', async t => {
  const f = await fixture(t);
  f.entries.set('file', { bytes: Buffer.from('abc') });
  for (const [label, value, expected] of [
    ['default', undefined, 30 * 60 * 1000],
    ['minimum', 1, 1000],
    ['maximum', 60 * 60 * 1000, 30 * 60 * 1000],
    ['non-numeric string', 'invalid', 30 * 60 * 1000],
    ['empty string', '', 30 * 60 * 1000],
    ['zero', 0, 30 * 60 * 1000],
    ['negative', -1, 30 * 60 * 1000],
    ['fractional', 1500.5, 30 * 60 * 1000],
    ['infinite', Infinity, 30 * 60 * 1000],
    ['not a number', NaN, 30 * 60 * 1000],
    ['boolean', true, 30 * 60 * 1000],
  ]) {
    await t.test(label, async () => {
      f.settings.REMOTE_FILE_TIMEOUT_MS = value;
      const download = await f.service.download('drive', 'file', user);
      await download.cleanup();
      assert.equal(f.calls.read.at(-1).options.timeoutMs, expected);
      await assertTempEmpty(f);
    });
  }
});

test('remote transfer timeout also cancels the local pipeline and releases staged files and the user slot', async t => {
  const f = await fixture(t);
  f.settings.REMOTE_FILE_TIMEOUT_MS = 1000;
  const source = new Readable({ read() {} });
  f.entries.set('slow', { bytes: Buffer.from('abc'), stream: () => source });
  const watchdog = setTimeout(() => source.destroy(new Error('fixture watchdog exceeded')), 3000);
  try {
    await assert.rejects(f.service.download('drive', 'slow', user), error => error.getStatus?.() === 502 && error.cause?.name === 'AbortError');
  } finally {
    clearTimeout(watchdog);
    source.destroy();
  }
  assert.equal(source.destroyed, true);
  await assertTempEmpty(f);
  f.entries.set('valid', { bytes: Buffer.from('abc') });
  const retry = await f.service.download('drive', 'valid', user);
  await retry.cleanup();
  await assertTempEmpty(f);
});

test('verified remote imports reuse the existing upload path with Unicode names and remove temporary files', async t => {
  const f = await fixture(t);
  f.entries.set('file', { name: '云端文档.txt', bytes: Buffer.from('abc') });
  const result = await f.service.import('drive', { projectId: 'project', folderPath: '导入目录', fileIds: ['file'] }, user);
  assert.equal(result.imported, 1);
  assert.equal(result.items[0].fileId, 'managed-file');
  assert.equal(f.calls.uploaded[0].name, '云端文档.txt');
  assert.equal(f.calls.uploaded[0].bytes.toString(), 'abc');
  assert.deepEqual(f.calls.uploaded[0].options, { duplicateStrategy: 'reuse', folderPath: '导入目录' });
  await assert.rejects(fs.stat(f.calls.uploaded[0].file.path), { code: 'ENOENT' });
  await assertTempEmpty(f);
});

test('remote imports reject changed lengths and hashes before writing a managed file', async t => {
  const f = await fixture(t);
  for (const [id, entry] of [
    ['short', { bytes: Buffer.from('ab'), size: 3 }],
    ['long', { bytes: Buffer.from('abcd'), size: 3 }],
    ['hash', { bytes: Buffer.from('abc'), sha1: '0'.repeat(40) }],
  ]) f.entries.set(id, entry);
  const result = await f.service.import('drive', { projectId: 'project', fileIds: ['short', 'long', 'hash'] }, user);
  assert.equal(result.failed, 3);
  assert.equal(result.imported, 0);
  assert.equal(f.calls.uploaded.length, 0);
  await assertTempEmpty(f);
});

test('a listed file changing before import is rejected until the listing is refreshed', async t => {
  const f = await fixture(t);
  f.adapter.listRemoteFiles = async () => ({ parentId: 'root', nextCursor: '', items: [{ id: 'file', parentId: 'root', type: 'file', name: 'file.txt', size: 3, sha1: sha1(Buffer.from('old')) }] });
  await f.service.list('drive', {}, user);
  f.entries.set('file', { bytes: Buffer.from('new') });
  const result = await f.service.import('drive', { projectId: 'project', fileIds: ['file'] }, user);
  assert.equal(result.failed, 1);
  assert.match(result.items[0].error, /变化|刷新/);
  assert.equal(f.calls.uploaded.length, 0);
  await assertTempEmpty(f);
});

test('one failed remote file does not discard successful imports from the same batch', async t => {
  const f = await fixture(t);
  f.entries.set('valid', { bytes: Buffer.from('abc') });
  const result = await f.service.import('drive', { projectId: 'project', fileIds: ['missing', 'valid'] }, user);
  assert.equal(result.imported, 1);
  assert.equal(result.failed, 1);
  assert.deepEqual(result.items.map(item => item.status), ['FAILED', 'IMPORTED']);
  await assertTempEmpty(f);
});

test('cloud backups run the real archive validator and register without restoring business data', async t => {
  const f = await fixture(t);
  const bytes = gzipSync(Buffer.from(JSON.stringify({ formatVersion: BACKUP_FORMAT_VERSION, createdAt: '2026-11-20T00:00:00.000Z', scopes: ['settings'], tables: { systemSetting: [] }, objects: [], warnings: [] })));
  f.entries.set('archive', { name: 'ufm-backup.json.gz', bytes });
  f.entries.set('invalid', { name: 'broken.gz', bytes: Buffer.from('invalid') });
  const result = await f.service.import('drive', { fileIds: ['archive', 'invalid'], asBackup: true }, user);
  assert.equal(result.imported, 1);
  assert.equal(result.failed, 1);
  assert.equal(f.calls.backups.length, 1);
  assert.equal(f.calls.backups[0].status, 'SUCCEEDED');
  assert.equal(f.calls.uploaded.length, 0);
  assert.equal(f.calls.read[0].options.maxBytes, 256 * 1024 * 1024);
  const archived = await fs.readFile(path.join(f.settings.BACKUP_ROOT, f.calls.backups[0].fileName));
  assert.deepEqual(archived, bytes);
  await assertTempEmpty(f);
});

test('remote downloads finish integrity checks before exposing a local stream and release their task on cleanup', async t => {
  const f = await fixture(t);
  f.settings.REMOTE_FILE_MAX_BYTES = 32;
  f.entries.set('file', { name: '下载.txt', bytes: Buffer.from('abc') });
  const download = await f.service.download('drive', 'file', user);
  assert.equal(download.name, '下载.txt');
  assert.equal(download.size, 3);
  assert.equal(f.calls.read[0].options.maxBytes, 32);
  await assert.rejects(f.service.download('drive', 'file', user), status(409));
  const chunks = [];
  for await (const chunk of download.stream) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), 'abc');
  await download.cleanup();
  await assertTempEmpty(f);
  const again = await f.service.download('drive', 'file', user);
  await again.cleanup();
});

test('remote controller streams verified content with encoded download headers and always cleans up', async () => {
  const headers = {};
  const bytes = [];
  let cleaned = 0;
  const response = new Writable({ write(chunk, _encoding, done) { bytes.push(Buffer.from(chunk)); done(); } });
  response.setHeader = (name, value) => { headers[name] = value; };
  const controller = new RemoteFilesController({ download: async () => ({ name: '下载.txt', size: 3, mimeType: 'text/plain', stream: Readable.from([Buffer.from('abc')]), cleanup: async () => { cleaned++; } }) });
  await controller.download('drive', 'file', user, response);
  assert.equal(Buffer.concat(bytes).toString(), 'abc');
  assert.match(headers['Content-Disposition'], /attachment; filename\*=UTF-8''%/);
  assert.equal(headers['Content-Length'], '3');
  assert.equal(headers['Cache-Control'], 'no-store');
  assert.equal(cleaned, 1);
});

test('remote import DTO requires a project for file imports and allows project-free backup registration', async () => {
  const missing = plainToInstance(ImportRemoteFilesDto, { fileIds: ['file'] });
  assert.ok((await validate(missing)).some(error => error.property === 'projectId'));
  const backup = plainToInstance(ImportRemoteFilesDto, { fileIds: ['archive'], asBackup: true });
  assert.deepEqual(await validate(backup), []);
});

test('remote listing rejects malformed IDs and entries belonging to a different parent', async t => {
  const f = await fixture(t);
  const file = { id: 'file', parentId: 'root', name: 'file.txt', type: 'file', size: 3 };
  for (const page of [
    { parentId: undefined, nextCursor: '', items: [] },
    { parentId: 'root', nextCursor: '', items: [{ ...file, id: 123 }] },
    { parentId: 'root', nextCursor: '', items: [{ ...file, parentId: 'outside' }] },
  ]) {
    f.adapter.listRemoteFiles = async () => page;
    await assert.rejects(f.service.list('drive', {}, user), status(502));
  }
});

test('a cached oversized file is rejected before requesting a cloud content stream', async t => {
  const f = await fixture(t);
  f.adapter.listRemoteFiles = async () => ({ parentId: 'root', nextCursor: '', items: [{ id: 'large', parentId: 'root', name: 'large.txt', type: 'file', size: 9 }] });
  await f.service.list('drive', {}, user);
  const result = await f.service.import('drive', { projectId: 'project', fileIds: ['large'] }, user);
  assert.equal(result.failed, 1);
  assert.equal(f.calls.read.length, 0);
});

test('one administrator cannot start a second import or download while a batch is reading', async t => {
  const f = await fixture(t);
  let begin;
  let unblock;
  const started = new Promise(done => { begin = done; });
  const blocked = new Promise(done => { unblock = done; });
  f.entries.set('file', { bytes: Buffer.from('abc'), stream: () => Readable.from((async function* () { begin(); await blocked; yield Buffer.from('abc'); })()) });
  const first = f.service.import('drive', { projectId: 'project', fileIds: ['file'] }, user);
  try {
    await started;
    await assert.rejects(f.service.import('drive', { projectId: 'project', fileIds: ['file'] }, user), status(409));
    await assert.rejects(f.service.download('drive', 'file', user), status(409));
  } finally { unblock(); }
  assert.equal((await first).imported, 1);
  assert.equal((await f.service.import('drive', { projectId: 'project', fileIds: ['file'] }, user)).imported, 1);
  await assertTempEmpty(f);
});

test('an upload failure removes its staged content and still permits the next batch item', async t => {
  const f = await fixture(t);
  f.entries.set('first', { bytes: Buffer.from('abc') });
  f.entries.set('second', { bytes: Buffer.from('def') });
  let attempts = 0;
  f.filesService.upload = async (_, files) => {
    await fs.stat(files[0].path);
    if (attempts++ === 0) throw new Error('fixture https://signed.invalid/private');
    return [{ id: 'surviving-file' }];
  };
  const result = await f.service.import('drive', { projectId: 'project', fileIds: ['first', 'second'] }, user);
  assert.equal(result.failed, 1);
  assert.equal(result.imported, 1);
  assert.equal(result.items[1].fileId, 'surviving-file');
  assert.ok(!JSON.stringify(result).includes('signed.invalid'));
  await assertTempEmpty(f);
});

test('a corrupt download releases its concurrency slot and never exposes an unverified stream', async t => {
  const f = await fixture(t);
  f.entries.set('bad', { bytes: Buffer.from('abc'), sha1: '0'.repeat(40) });
  await assert.rejects(f.service.download('drive', 'bad', user), status(409));
  await assertTempEmpty(f);
  f.entries.set('valid', { bytes: Buffer.from('abc') });
  const file = await f.service.download('drive', 'valid', user);
  await file.cleanup();
  await assertTempEmpty(f);
});

test('the remote download controller cleans up verified files after a client disconnect', async () => {
  let cleaned = false;
  const response = new Writable({ write(_chunk, _encoding, done) { done(new Error('client disconnected')); } });
  response.setHeader = () => {};
  const controller = new RemoteFilesController({ download: async () => ({ name: 'file.txt', size: 3, mimeType: 'text/plain', stream: Readable.from([Buffer.from('abc')]), cleanup: async () => { cleaned = true; } }) });
  await assert.rejects(controller.download('drive', 'file', user, response), /client disconnected/);
  assert.equal(cleaned, true);
});

test('a remote file without a valid source SHA1 is rejected before consuming content', async t => {
  const f = await fixture(t);
  let consumed = false;
  f.adapter.readRemoteFile = async () => ({ name: 'unverified.txt', size: 3, mimeType: 'text/plain', stream: Readable.from((async function* () { consumed = true; yield Buffer.from('abc'); })()) });
  await assert.rejects(f.service.download('drive', 'file', user), status(502));
  assert.equal(consumed, false);
  await assertTempEmpty(f);
});

test('temporary cleanup refuses the shared root and any path outside its owned transfer directory', async t => {
  const f = await fixture(t);
  const outside = path.join(f.root, 'outside-keep');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'keep.txt'), 'preserve');
  await assert.rejects(f.service.safeCleanup(outside), status(500));
  await assert.rejects(f.service.safeCleanup(f.settings.REMOTE_FILE_TEMP_ROOT), status(500));
  assert.equal(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8'), 'preserve');
  const owned = path.join(f.settings.REMOTE_FILE_TEMP_ROOT, 'transfer-owned');
  await fs.mkdir(owned, { recursive: true });
  await fs.writeFile(path.join(owned, 'content'), 'temporary');
  await f.service.safeCleanup(owned);
  await assertTempEmpty(f);
});

test('a matching local object key restores its known original name after checksum verification', async t => {
  const f = await fixture(t);
  const key = ['project', 'original.txt'].join('/');
  const hashed = createHash('sha256').update(key).digest('hex');
  const checksum = createHash('sha256').update('abc').digest('hex');
  f.indexRows.push({ storageKey: key, originalName: '本地索引文档.txt', size: 3n, checksum });
  f.adapter.listRemoteFiles = async () => ({ parentId: 'root', nextCursor: '', items: [{ id: 'file', parentId: 'root', type: 'file', name: hashed, size: 3, sha1: sha1(Buffer.from('abc')) }] });
  f.entries.set('file', { name: hashed, bytes: Buffer.from('abc') });
  const page = await f.service.list('drive', {}, user);
  assert.equal(page.items[0].name, hashed);
  assert.equal(page.items[0].originalName, '本地索引文档.txt');
  assert.equal(page.items[0].storageKey, key);
  assert.equal(page.items[0].checksum, checksum);
  const result = await f.service.import('drive', { projectId: 'project', fileIds: ['file'] }, user);
  assert.equal(result.imported, 1);
  assert.equal(f.calls.uploaded[0].name, '本地索引文档.txt');
  await assertTempEmpty(f);
});

test('local index conflicts, wrong sizes and unrelated keys never create guessed filenames', async t => {
  const f = await fixture(t);
  const key = ['project', 'original.txt'].join('/');
  const hashed = createHash('sha256').update(key).digest('hex');
  const checksum = createHash('sha256').update('abc').digest('hex');
  f.adapter.listRemoteFiles = async () => ({ parentId: 'root', nextCursor: '', items: [{ id: 'file', parentId: 'root', type: 'file', name: hashed, size: 3, sha1: sha1(Buffer.from('abc')) }] });
  for (const rows of [
    [{ storageKey: 'unrelated/key', originalName: '错误名称.txt', size: 3n, checksum }],
    [{ storageKey: key, originalName: '错误大小.txt', size: 4n, checksum }],
    [{ storageKey: key, originalName: '候选一.txt', size: 3n, checksum }, { storageKey: key, originalName: '候选二.txt', size: 3n, checksum }],
  ]) {
    f.indexRows.splice(0, f.indexRows.length, ...rows);
    const page = await f.service.list('drive', {}, user);
    assert.equal(page.items[0].originalName, undefined);
    assert.equal(page.items[0].name, hashed);
  }
});

test('a local filename mapping never imports cloud content that differs from the indexed SHA256', async t => {
  const f = await fixture(t);
  const key = ['project', 'original.txt'].join('/');
  const hashed = createHash('sha256').update(key).digest('hex');
  f.indexRows.push({ storageKey: key, originalName: '原始文档.txt', size: 3n, checksum: createHash('sha256').update('old').digest('hex') });
  f.adapter.listRemoteFiles = async () => ({ parentId: 'root', nextCursor: '', items: [{ id: 'file', parentId: 'root', type: 'file', name: hashed, size: 3, sha1: sha1(Buffer.from('new')) }] });
  f.entries.set('file', { name: hashed, bytes: Buffer.from('new') });
  await f.service.list('drive', {}, user);
  const result = await f.service.import('drive', { projectId: 'project', fileIds: ['file'] }, user);
  assert.equal(result.failed, 1);
  assert.equal(f.calls.uploaded.length, 0);
  await assertTempEmpty(f);
});

test('an expired listed file fails individually until refresh while a previously unseen ID can still import', async t => {
  const f = await fixture(t);
  f.adapter.listRemoteFiles = async () => ({ parentId: 'root', nextCursor: '', items: [{ id: 'listed', parentId: 'root', name: 'listed.txt', type: 'file', size: 3, sha1: sha1(Buffer.from('old')) }] });
  f.entries.set('listed', { bytes: Buffer.from('new') });
  f.entries.set('unseen', { bytes: Buffer.from('abc') });
  await f.service.list('drive', {}, user);
  const originalNow = Date.now;
  Date.now = () => originalNow() + 6 * 60 * 1000;
  t.after(() => { Date.now = originalNow; });
  f.adapter.listRemoteFiles = async () => ({ parentId: 'other', nextCursor: '', items: [] });
  await f.service.list('drive', { parentId: 'other' }, user);
  const result = await f.service.import('drive', { projectId: 'project', fileIds: ['listed', 'unseen'] }, user);
  assert.equal(result.failed, 1);
  assert.equal(result.imported, 1);
  assert.match(result.items[0].error, /过期.*刷新/);
  assert.deepEqual(f.calls.read.map(call => call.id), ['unseen']);
  await assert.rejects(f.service.download('drive', 'listed', user), status(409));
  f.adapter.listRemoteFiles = async () => ({ parentId: 'root', nextCursor: '', items: [{ id: 'listed', parentId: 'root', name: 'listed.txt', type: 'file', size: 3, sha1: sha1(Buffer.from('new')) }] });
  await f.service.list('drive', {}, user);
  assert.equal((await f.service.import('drive', { projectId: 'project', fileIds: ['listed'] }, user)).imported, 1);
  await assertTempEmpty(f);
});
