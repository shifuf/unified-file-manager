/* Read every retained fixture directly from each real provider; no object writes. */
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = process.env.UFM_COPY_ROOT || path.resolve(__dirname, '../..');
if (fs.existsSync(path.join(root, '.env'))) {
  const env = Object.fromEntries(fs.readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/).filter(s => /^\w+=/.test(s)).map(s => { const i = s.indexOf('='); return [s.slice(0, i), s.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]; }));
  Object.assign(process.env, env);
}
require(path.join(root, 'apps/api/dist/common/utils/database-url.util.js')).ensureDatabaseUrl(process.env);
const { PrismaClient } = require('@prisma/client'), { ConfigService } = require('@nestjs/config');
const { StorageAdapterRegistry } = require(path.join(root, 'apps/api/dist/storage/storage-registry.service.js'));
const { ReplicaService } = require(path.join(root, 'apps/api/dist/storage/replica.service.js'));
const classes = { local: 'LocalStorageAdapter', qiniu: 'QiniuAdapter', upyun: 'UpyunAdapter', s3: 'S3Adapter', 'aliyun-oss': 'AliyunOssAdapter' };
const make = name => new (require(path.join(root, 'apps/api/dist/storage/adapters/' + name + '.adapter.js'))[classes[name]])();
const db = new PrismaClient(), registry = new StorageAdapterRegistry(make('aliyun-oss'), make('local'), make('qiniu'), make('s3'), make('upyun'));
const replicas = new ReplicaService(new ConfigService(process.env), db, registry);
(async () => { const results = []; try {
  let input = ''; for await (const chunk of process.stdin) input += chunk;
  const fixture = JSON.parse(input); assert.ok(fixture.files.length > 0 && fixture.files.length <= 100);
  for (const f of fixture.files) {
    const file = await db.managedFile.findUnique({ where: { id: f.id } }); assert.ok(file); assert.equal(file.checksum, f.sha256);
    const rows = await db.storageReplica.findMany({ where: { projectId: file.projectId, storageKey: file.storageKey }, include: { config: true } });
    assert.equal(rows.length, 3); assert.ok(rows.every(r => r.status === 'READY' && r.verifiedAt));
    assert.equal(file.cdnConfigId, rows.find(r => r.config.provider === 'LOCAL').configId, 'new uploads retain their LOCAL primary reference');
    if (f.storageKey) assert.equal(file.storageKey, f.storageKey);
    for (const row of rows) {
      const object = await replicas.readVerified(replicas.runtime(row.config), row.storageKey, row.size, row.checksum);
      try { assert.equal(object.checksum, f.sha256); results.push({ fileId: f.id, replicaId: row.id, provider: row.config.provider, size: object.size, sha256: object.checksum }); }
      finally { await object.cleanup(); }
    }
  }
  const stats = await db.managedFile.aggregate({ where: { status: 'ACTIVE', deletedAt: null, project: { deletedAt: null } }, _count: { _all: true }, _sum: { size: true } });
  const projects = await db.project.count({ where: { deletedAt: null } });
  const base = process.env.UFM_COPY_BASE || 'http://localhost:5175';
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'UFM-Storage-Database-Acceptance' }, body: JSON.stringify({ username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD }) });
  assert.ok(login.ok, 'database consistency login');
  const cookie = login.headers.getSetCookie().map(s => s.split(';')[0]).join('; ');
  try {
    const response = await fetch(base + '/api/dashboard/summary', { headers: { cookie, 'user-agent': 'UFM-Storage-Database-Acceptance' } }); assert.ok(response.ok);
    const summary = await response.json(); assert.equal(summary.files.active, stats._count._all); assert.equal(summary.files.sourceBytes, (stats._sum.size || 0n).toString()); assert.equal(summary.projects.total, projects);
  } finally { await fetch(base + '/api/auth/logout', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' }); }
  console.log(JSON.stringify({ pass: true, checks: results.length, dashboardDatabaseMatch: true, results, database: { activeFiles: stats._count._all, sourceBytes: (stats._sum.size || 0n).toString(), projects } }));
} catch (e) { console.log(JSON.stringify({ pass: false, checks: results.length, error: e.message })); process.exitCode = 1; }
finally { await db.$disconnect(); } })();
