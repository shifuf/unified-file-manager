const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
require('ts-node').register({ project: path.resolve(__dirname, '../../apps/api/tsconfig.json'), transpileOnly: true });
require('reflect-metadata');
const { Module } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const bcrypt = require('bcryptjs');
const { Readable } = require('node:stream');
const { FilesService } = require('../../apps/api/src/files/files.service.ts');
const { PublicSharesController } = require('../../apps/api/src/files/files.controller.ts');
const { FolderShareService } = require('../../apps/api/src/files/folder-share.service.ts');
const { ShareIpAbuseService } = require('../../apps/api/src/files/share-ip-abuse.service.ts');
const { PublicFolderSharesController } = require('../../apps/api/src/files/folder-share.controller.ts');
const { DownloadStatsService } = require('../../apps/api/src/files/download-stats.service.ts');
const { LocalStorageAdapter } = require('../../apps/api/src/storage/adapters/local.adapter.ts');

// Only the database boundary is substituted; HTTP, controllers, access checks,
// password hashing, range parsing and filesystem reads are production code.
async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ufm-share-test-'));
  await fs.writeFile(path.join(root, 'fixture.txt'), '0123456789');
  const project = { id: 'project', name: 'fixture', enabled: true, deletedAt: null };
  const file = { id: 'file', projectId: project.id, project, storageKey: 'fixture.txt', folderPath: 'docs', status: 'ACTIVE', category: 'DOCUMENT', originalName: 'fixture.txt', mimeType: 'text/plain', size: 10n, cdnConfig: { id: 'local', provider: 'LOCAL', config: { root } } };
  const base = { enabled: true, previewOnly: false, expiresAt: null, passwordHash: null, maxDownloads: 1, downloadCount: 0, allowedIps: [], watermarkText: null, createdAt: new Date(), updatedAt: new Date(), ...overrides };
  const share = { ...base, id: 'share', token: 'file-token', customPath: null, fileId: file.id, file };
  const folder = { ...base, id: 'folder-share', token: 'folder-token', projectId: project.id, folderPath: 'docs', project };
  const sessions = [];
  function matches(row, where) {
    return Object.entries(where || {}).every(([key, value]) => {
      if (key === 'OR') return value.some(item => matches(row, item));
      if (key === 'AND') return value.every(item => matches(row, item));
      if (value && typeof value === 'object' && !(value instanceof Date)) {
        if ('lt' in value) return row[key] < value.lt;
        if ('gt' in value) return row[key] > value.gt;
        if ('gte' in value) return row[key] >= value.gte;
        if ('equals' in value) return row[key] === value.equals;
        if ('startsWith' in value) return String(row[key] ?? '').startsWith(value.startsWith);
        if ('contains' in value) return String(row[key] ?? '').includes(value.contains);
        return true;
      }
      return row[key] === value;
    });
  }
  function table(rows) {
    return {
      fields: { maxDownloads: 'maxDownloads' },
      findUnique: async ({ where }) => rows.find(row => matches(row, where)) || null,
      findFirst: async ({ where }) => rows.find(row => matches(row, where)) || null,
      findMany: async ({ where }) => rows.filter(row => matches(row, where)),
      count: async ({ where }) => rows.filter(row => matches(row, where)).length,
      create: async ({ data }) => { const row = { id: `session-${rows.length}`, consumedAt: null, ...data }; rows.push(row); return row; },
      updateMany: async ({ where, data }) => { let count = 0; for (const row of rows.filter(row => matches(row, where))) { count++; for (const [key, value] of Object.entries(data)) row[key] = value && typeof value === 'object' && 'increment' in value ? row[key] + value.increment : value; } return { count }; },
      update: async ({ where, data }) => { await table(rows).updateMany({ where, data }); return rows.find(row => matches(row, where)); },
      upsert: async ({ where, create, update }) => {
        const existing = rows.find(row => matches(row, where));
        if (existing) return table(rows).update({ where, data: update });
        return table(rows).create({ data: { downloadCount: 0, rateLimitCount: 0, permanentBan: false, banUntil: null, banReason: null, notes: null, lastDownloadAt: null, lastRateLimitedAt: null, lastShareId: null, lastFileName: null, createdAt: new Date(), updatedAt: new Date(), ...create } });
      },
    };
  }
  const ipStats = [];
  const db = { shareLink: table([share]), folderShareLink: table([folder]), managedFile: table([file]), shareDownloadSession: table(sessions), shareIpStat: table(ipStats) };
  let lock = Promise.resolve();
  db.$transaction = async callback => {
    if (Array.isArray(callback)) return Promise.all(callback);
    const previous = lock; let release; lock = new Promise(resolve => { release = resolve; }); await previous;
    const snapshots = [share, folder, ...sessions].map(row => [row, { ...row }]);
    try { return await callback(db); } catch (error) { for (const [row, snapshot] of snapshots) Object.assign(row, snapshot); throw error; } finally { release(); }
  };
  const adapter = new LocalStorageAdapter();
  let reads = 0;
  const storage = { getDownloadTarget: async (current, _ttl, range) => { reads++; return adapter.getDownloadTarget(current.cdnConfig, current.storageKey, range); }, signShareAccess: () => 'legacy-ticket', verifyShareAccess: () => true };
  const audit = { write: async () => {} }, config = { get: key => key === 'PUBLIC_URL' ? 'https://files.example.test' : undefined };
  const settings = { getSharePageBrand: async () => ({}) }, access = { assertProjectAccess: async () => {} }, event = { emit: () => {} };
  const abuse = new ShareIpAbuseService(db, audit);
  const makeFiles = () => new FilesService(audit, config, event, null, db, access, null, settings, abuse, storage, null);
  const service = makeFiles();
  const folderService = new FolderShareService(db, access, audit, config, settings, storage, event, abuse);
  const auditRows = [];
  db.auditLog = { create: async ({ data }) => { auditRows.push(data); } };
  const downloadStats = new DownloadStatsService(db);
  downloadStats.persist = async () => {};
  class FixtureModule {}
  Module({ controllers: [PublicSharesController, PublicFolderSharesController], providers: [{ provide: FilesService, useValue: service }, { provide: FolderShareService, useValue: folderService }, { provide: DownloadStatsService, useValue: downloadStats }] })(FixtureModule);
  const app = await NestFactory.create(FixtureModule, { logger: false });
  app.setGlobalPrefix('api'); await app.listen(0, '127.0.0.1');
  const origin = await app.getUrl();
  t.after(async () => { await app.close(); await fs.rm(root, { recursive: true, force: true }); });
  const request = (route, options) => fetch(`${origin}${route}`, options);
  return { request, share, folder, file, sessions, service, folderService, makeFiles, storage, auditRows, abuse, ipStats, db, reads: () => reads };
}

for (const route of ['/api/shares/file-token/download', '/api/folder-shares/folder-token/files/file/download']) {
  test(`unban immediately restores the full download budget for ${route}`, async t => {
    const f = await fixture(t, { maxDownloads: null });
    for (let i = 0; i < 5; i++) {
      const response = await f.request(route);
      assert.equal(response.status, 200);
      await response.arrayBuffer();
    }
    assert.equal((await f.request(route)).status, 429);
    const cleared = await f.abuse.unban('::ffff:127.0.0.1');
    assert.equal(cleared.banned, false);
    for (let i = 0; i < 5; i++) {
      const response = await f.request(route);
      assert.equal(response.status, 200, `download ${i + 1} after unban must succeed`);
      await response.arrayBuffer();
    }
    assert.equal((await f.request(route)).status, 429, 'protection still applies to subsequent abuse');
    assert.equal(f.ipStats[0].downloadCount, 10, 'unban preserves historical statistics');
    assert.equal(f.ipStats[0].rateLimitCount, 2);
  });
}

test('file and directory shares use one IP budget and both recover after unban', async t => {
  const f = await fixture(t, { maxDownloads: null });
  const fileRoute = '/api/shares/file-token/download';
  const folderRoute = '/api/folder-shares/folder-token/files/file/download';
  for (const route of [fileRoute, folderRoute, fileRoute, folderRoute, fileRoute]) {
    const response = await f.request(route);
    assert.equal(response.status, 200);
    await response.arrayBuffer();
  }
  assert.equal((await f.request(fileRoute)).status, 429);
  assert.equal((await f.request(folderRoute)).status, 429);
  await f.abuse.unban('127.0.0.1');
  for (const route of [folderRoute, fileRoute]) {
    const response = await f.request(route);
    assert.equal(response.status, 200);
    await response.arrayBuffer();
  }
});

test('unban clears a partial budget even when a manual ban is shorter than the rate window', async t => {
  const f = await fixture(t, { maxDownloads: null });
  const route = '/api/shares/file-token/download';
  for (let i = 0; i < 4; i++) await (await f.request(route)).arrayBuffer();
  await f.abuse.ban('127.0.0.1', { permanent: true });
  assert.equal((await f.request(route)).status, 403);
  await f.abuse.unban('127.0.0.1');
  for (let i = 0; i < 5; i++) {
    const response = await f.request(route);
    assert.equal(response.status, 200);
    await response.arrayBuffer();
  }
});

test('a download already in progress cannot restore an automatic ban after unban completes', async t => {
  const f = await fixture(t, { maxDownloads: null });
  for (let i = 0; i < 4; i++) await f.abuse.assertDownloadAllowed('127.0.0.1');
  let release;
  const paused = new Promise(resolve => { release = resolve; });
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const upsert = f.db.shareIpStat.upsert;
  f.db.shareIpStat.upsert = async args => {
    if (args.update.downloadCount) { entered(); await paused; }
    return upsert(args);
  };
  const download = f.abuse.assertDownloadAllowed('127.0.0.1');
  await started;
  const unban = f.abuse.unban('::ffff:127.0.0.1');
  // Let the original unban finish while the old download is paused; a serialized
  // implementation instead queues it until the earlier download has finished.
  await new Promise(resolve => setImmediate(resolve));
  release();
  await download;
  assert.equal((await unban).banned, false);
  await assert.doesNotReject(() => f.abuse.assertDownloadAllowed('127.0.0.1'));
});

test('unban clears an orphaned memory lock and leaves other IPs restricted', async t => {
  const f = await fixture(t, { maxDownloads: null });
  for (const ip of ['192.0.2.1', '192.0.2.2']) {
    for (let i = 0; i < 5; i++) await f.abuse.assertDownloadAllowed(ip);
  }
  f.ipStats.splice(f.ipStats.findIndex(row => row.ip === '192.0.2.1'), 1);
  await f.abuse.unban('::ffff:192.0.2.1');
  await assert.doesNotReject(() => f.abuse.assertDownloadAllowed('192.0.2.1'));
  await assert.rejects(() => f.abuse.assertDownloadAllowed('192.0.2.2'), error => error.getStatus() === 429);
});

test('a failed unban retains the restriction and does not block a later retry', async t => {
  const f = await fixture(t, { maxDownloads: null });
  for (let i = 0; i < 5; i++) await f.abuse.assertDownloadAllowed('192.0.2.1');
  const update = f.db.shareIpStat.update;
  f.db.shareIpStat.update = async () => { throw new Error('database unavailable'); };
  await assert.rejects(() => f.abuse.unban('192.0.2.1'), /database unavailable/);
  await assert.rejects(() => f.abuse.assertDownloadAllowed('192.0.2.1'), error => error.getStatus() === 429);
  f.db.shareIpStat.update = update;
  await f.abuse.unban('192.0.2.1');
  await assert.doesNotReject(() => f.abuse.assertDownloadAllowed('192.0.2.1'));
});

test('raw JSON share is inline regardless of Accept, and preserves share authorization', async t => {
  const f = await fixture(t, { maxDownloads: null });
  f.file.originalName = 'update.json'; f.file.mimeType = 'application/octet-stream';
  const response = await f.request('/api/shares/file-token/raw', { headers: { Accept: 'application/json' } });
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^application\/json/);
  assert.match(response.headers.get('content-disposition'), /^inline/);
  assert.equal(body, '0123456789'); assert.equal(f.share.downloadCount, 0);
  f.share.passwordHash = await bcrypt.hash('secret', 4);
  assert.equal((await f.request('/api/shares/file-token/raw')).status, 400);
  f.share.enabled = false;
  assert.ok((await f.request('/api/shares/file-token/raw?password=secret')).status >= 400);
});

test('file share download audit retains the resolved share ID through service and controller', async t => {
  const f = await fixture(t);
  const response = await f.request('/api/shares/file-token/download');
  assert.equal(response.status, 200); await response.arrayBuffer();
  assert.equal(f.auditRows.length, 1);
  assert.equal(f.auditRows[0].action, 'FILE_SHARE_DOWNLOAD');
  assert.equal(f.auditRows[0].detail.shareId, 'share');
});

test('folder share download audit retains the authorizing share ID', async t => {
  const f = await fixture(t);
  const response = await f.request('/api/folder-shares/folder-token/files/file/download');
  assert.equal(response.status, 200); await response.arrayBuffer();
  assert.equal(f.auditRows.length, 1);
  assert.equal(f.auditRows[0].action, 'FOLDER_SHARE_DOWNLOAD');
  assert.equal(f.auditRows[0].detail.shareId, 'folder-share');
});

test('single-file HEAD returns metadata without opening content or spending quota', async t => {
  const f = await fixture(t);
  const r = await f.request('/api/shares/file-token/download', { method: 'HEAD' });
  assert.equal(r.status, 200); assert.equal(r.headers.get('content-length'), '10'); assert.equal(await r.text(), '');
  assert.equal(f.share.downloadCount, 0); assert.equal(f.reads(), 0);
});
test('unsatisfiable range is authorized before returning 416 and consumes no quota', async t => {
  const f = await fixture(t);
  const r = await f.request('/api/shares/file-token/download', { headers: { Range: 'bytes=100-200' } });
  assert.equal(r.status, 416); assert.equal(r.headers.get('content-range'), 'bytes */10'); assert.equal(f.share.downloadCount, 0); assert.equal(f.reads(), 0);
  f.share.passwordHash = await bcrypt.hash('fixture-password', 4);
  const denied = await f.request('/api/shares/file-token/download', { headers: { Range: 'bytes=100-200' }, redirect: 'manual' });
  assert.notEqual(denied.status, 416); assert.equal(f.share.downloadCount, 0);
});
test('single-file range returns exactly the selected bytes and consumes one download', async t => {
  const f = await fixture(t);
  const r = await f.request('/api/shares/file-token/download', { headers: { Range: 'bytes=2-5' } });
  assert.equal(r.status, 206); assert.equal(r.headers.get('content-range'), 'bytes 2-5/10'); assert.equal(r.headers.get('content-length'), '4'); assert.equal(await r.text(), '2345'); assert.equal(f.share.downloadCount, 1);
});
test('directory range opens once and works at a one-download limit', async t => {
  const f = await fixture(t);
  const r = await f.request('/api/folder-shares/folder-token/files/file/download', { method: 'POST', headers: { Range: 'bytes=-3' } });
  assert.equal(r.status, 206); assert.equal(await r.text(), '789'); assert.equal(r.headers.get('content-range'), 'bytes 7-9/10'); assert.equal(f.folder.downloadCount, 1); assert.equal(f.reads(), 1);
});
test('directory HEAD and 416 leave quota intact and authorize the file scope', async t => {
  const f = await fixture(t);
  const head = await f.request('/api/folder-shares/folder-token/files/file/download', { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), '10'); assert.equal(f.folder.downloadCount, 0); assert.equal(f.reads(), 0);
  const r = await f.request('/api/folder-shares/folder-token/files/file/download', { method: 'POST', headers: { Range: 'bytes=10-' } });
  assert.equal(r.status, 416); assert.equal(f.folder.downloadCount, 0); assert.equal(f.reads(), 0);
  f.file.folderPath = 'private';
  const denied = await f.request('/api/folder-shares/folder-token/files/file/download', { method: 'HEAD' });
  assert.equal(denied.status, 403);
});
test('missing and truncated content never consumes a successful download quota', async t => {
  const f = await fixture(t);
  f.file.storageKey = 'missing.txt';
  const missing = await f.request('/api/shares/file-token/download');
  assert.equal(missing.status, 404); assert.equal(f.share.downloadCount, 0);
  f.storage.getDownloadTarget = async () => ({ type: 'stream', stream: Readable.from(['short']) });
  const truncated = await f.request('/api/shares/file-token/download');
  assert.ok(truncated.status >= 400); assert.equal(f.share.downloadCount, 0);
});
test('opaque tickets survive service replacement and authorize resumed ranges only once', async t => {
  const f = await fixture(t, { passwordHash: await bcrypt.hash('fixture-password', 4) });
  const session = await f.service.createShareDownloadSession('file-token', 'fixture-password', { ip: '127.0.0.1' });
  assert.equal(f.share.downloadCount, 0);
  const route = new URL(session.url, 'http://fixture.test');
  assert.equal(f.sessions.length, 1);
  const head = await f.request(`${route.pathname}${route.search}`, { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(f.share.downloadCount, 0);
  const first = await f.request(`${route.pathname}${route.search}`, { headers: { Range: 'bytes=0-3' } });
  assert.equal(first.status, 206); assert.equal(await first.text(), '0123'); assert.equal(f.share.downloadCount, 1);
  const restarted = f.makeFiles();
  const result = await restarted.getShareDownloadTarget('file-token', undefined, { ip: '127.0.0.1', ticket: route.searchParams.get('ticket'), expires: Number(route.searchParams.get('expires')), range: { start: 4, end: 9 } });
  assert.ok(result.target.stream); result.target.stream.destroy(); assert.equal(f.share.downloadCount, 1);
  const resumed = await f.request(`${route.pathname}${route.search}`, { headers: { Range: 'bytes=4-' } });
  assert.equal(resumed.status, 206); assert.equal(await resumed.text(), '456789'); assert.equal(f.share.downloadCount, 1);
});
test('issued ticket cannot bypass current password, expiry, revocation, IP or quota policy', async t => {
  const f = await fixture(t);
  const session = await f.service.createShareDownloadSession('file-token', undefined, { ip: '127.0.0.1' });
  const route = new URL(session.url, 'http://fixture.test');
  const url = `${route.pathname}${route.search}`;
  const changes = [ ['passwordHash', await bcrypt.hash('new-password', 4)], ['expiresAt', new Date(0)], ['enabled', false], ['allowedIps', ['203.0.113.1']], ['maxDownloads', 0] ];
  for (const [key, value] of changes) {
    const old = f.share[key]; f.share[key] = value;
    const r = await f.request(url, { method: 'HEAD', redirect: 'manual' });
    assert.ok(r.status >= 400, key); assert.equal(f.share.downloadCount, 0); f.share[key] = old;
  }
});
test('configured public origin takes priority over incoming host for returned share links', async t => {
  const f = await fixture(t);
  const response = f.service.toShareResponse(f.share, 'http://untrusted.example.test');
  assert.equal(response.url, 'https://files.example.test/shares/file-token');
  assert.equal(response.downloadUrl, 'https://files.example.test/api/shares/file-token');
  const directory = f.folderService.toResponse(f.folder, 'http://untrusted.example.test');
  assert.equal(directory.url, 'https://files.example.test/folder-shares/folder-token');
});

test('concurrent downloads cannot exceed the current maximum', async t => {
  const f = await fixture(t);
  const responses = await Promise.all([f.request('/api/shares/file-token/download'), f.request('/api/shares/file-token/download')]);
  const statuses = responses.map(r => r.status).sort();
  assert.deepEqual(statuses, [200, 400]);
  const success = responses.find(r => r.status === 200);
  assert.equal(await success.text(), '0123456789'); assert.equal(f.share.downloadCount, 1);
});
test('directory tickets bind file and policy and keep resumed ranges in one quota', async t => {
  const f = await fixture(t, { passwordHash: await bcrypt.hash('fixture-password', 4) });
  const sessionResponse = await f.request('/api/folder-shares/folder-token/files/file/download-session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'fixture-password' }) });
  assert.equal(sessionResponse.status, 200);
  const session = await sessionResponse.json();
  const route = new URL(session.url, 'http://fixture.test'); const url = `${route.pathname}${route.search}`;
  assert.equal(f.folder.downloadCount, 0);
  const head = await f.request(url, { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(f.folder.downloadCount, 0);
  const first = await f.request(url, { headers: { Range: 'bytes=0-4' } }); assert.equal(first.status, 206); assert.equal(await first.text(), '01234');
  const second = await f.request(url, { headers: { Range: 'bytes=5-' } }); assert.equal(second.status, 206); assert.equal(await second.text(), '56789'); assert.equal(f.folder.downloadCount, 1);
  f.folder.maxDownloads = 0;
  const invalidated = await f.request(url, { method: 'HEAD' }); assert.equal(invalidated.status, 403); assert.equal(f.folder.downloadCount, 1);
});
test('expired or transferred tickets cannot authorize downloads', async t => {
  const f = await fixture(t);
  const session = await f.service.createShareDownloadSession('file-token', undefined, { ip: '127.0.0.1' });
  const route = new URL(session.url, 'http://fixture.test');
  const options = { ticket: route.searchParams.get('ticket'), expires: Number(route.searchParams.get('expires')), head: true };
  await assert.rejects(f.service.getShareDownloadTarget('file-token', undefined, { ...options, ip: '203.0.113.1' }));
  f.sessions[0].expiresAt = new Date(0);
  const expired = await f.request(`${route.pathname}${route.search}`, { method: 'HEAD' }); assert.equal(expired.status, 403); assert.equal(f.share.downloadCount, 0);
});
test('malformed byte ranges and ranges on empty files return 416 without quota', async t => {
  const f = await fixture(t);
  for (const value of ['bytes=garbage', 'bytes=-', 'bytes=0-1,4-5']) {
    const r = await f.request('/api/shares/file-token/download', { headers: { Range: value } });
    assert.equal(r.status, 416, value); assert.equal(f.share.downloadCount, 0);
  }
  f.file.size = 0n;
  const empty = await f.request('/api/shares/file-token/download', { headers: { Range: 'bytes=0-' } });
  assert.equal(empty.status, 416); assert.equal(empty.headers.get('content-range'), 'bytes */0'); assert.equal(f.share.downloadCount, 0);
});

test('directory search keeps the shared subtree scope when applying a keyword', async t => {
  const f = await fixture(t);
  f.file.folderPath = 'private';
  const response = await f.request('/api/folder-shares/folder-token/files?q=fixture');
  assert.equal(response.status, 200);
  const result = await response.json(); assert.equal(result.total, 0); assert.deepEqual(result.items, []);
});

test('image watermark policy cannot be bypassed by a ranged download', async t => {
  const f = await fixture(t);
  f.file.category = 'IMAGE'; f.file.mimeType = 'image/png'; f.share.watermarkText = 'fixture';
  const response = await f.request('/api/shares/file-token/download', { headers: { Range: 'bytes=0-3' } });
  assert.equal(response.status, 400); assert.equal(f.share.downloadCount, 0); assert.equal(f.reads(), 0);
});
