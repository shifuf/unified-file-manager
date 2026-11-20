const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Prisma } = require('@prisma/client');
require('ts-node').register({ project: path.resolve(__dirname, '../../apps/api/tsconfig.json'), transpileOnly: true });
const { BackupService } = require('../../apps/api/src/backup/backup.service.ts');
require('@nestjs/common').Logger.overrideLogger(false);

const user = { id: 'fixture-admin', username: 'admin', displayName: 'Admin', role: 'SUPER_ADMIN', totpEnabled: false };
const knownError = (code, meta) => new Prisma.PrismaClientKnownRequestError('fixture-private-database-details', {
  code, meta, clientVersion: '6.19.3',
});

function serviceWith(prisma) {
  return new BackupService({ write: async () => {} }, { get: () => undefined }, prisma, null, null);
}

function isSchemaUnavailable(original) {
  return error => {
    assert.equal(typeof error.getStatus, 'function', 'schema drift must produce a useful HTTP error');
    assert.equal(error.getStatus(), 503);
    const body = error.getResponse();
    assert.equal(body.code, 'BACKUP_SCHEMA_OUTDATED');
    assert.match(body.message, /数据库.*迁移/);
    assert.ok(!JSON.stringify(body).includes('fixture-private-database-details'));
    assert.equal(error.cause, original, 'retain the database cause for server diagnostics');
    return true;
  };
}

test('backup list reports a pending schema migration when generated Prisma selects a missing destination column', async () => {
  const error = knownError('P2022', { modelName: 'Backup', column: 'Backup.retainLocal' });
  const service = serviceWith({ backup: { findMany: async () => { throw error; } } });
  await assert.rejects(service.list(user), isSchemaUnavailable(error));
});

test('backup destinations reports a pending schema migration when its storage metadata table is missing', async () => {
  const error = knownError('P2021', { modelName: 'CdnConfig', table: 'CdnConfig' });
  const service = serviceWith({ cdnConfig: { findMany: async () => { throw error; } } });
  await assert.rejects(service.destinations(user), isSchemaUnavailable(error));
});

test('backup metadata reads preserve unrelated database and programming failures', async () => {
  const errors = [
    knownError('P1001'),
    knownError('P2002', { modelName: 'Backup', target: ['id'] }),
    Object.assign(new Error('fixture-programming-failure'), { code: 'P2022' }),
  ];
  for (const original of errors) {
    const fail = async () => { throw original; };
    const service = serviceWith({ backup: { findMany: fail }, cdnConfig: { findMany: fail } });
    await assert.rejects(service.list(user), error => error === original);
    await assert.rejects(service.destinations(user), error => error === original);
  }
});

test('backup metadata authorization fails before either database read', async () => {
  const fail = async () => assert.fail('unauthorized requests must never read backup metadata');
  const service = serviceWith({ backup: { findMany: fail }, cdnConfig: { findMany: fail } });
  const forbidden = { ...user, role: 'PROJECT_ADMIN' };
  await assert.rejects(service.list(forbidden), error => error.getStatus() === 403);
  await assert.rejects(service.destinations(forbidden), error => error.getStatus() === 403);
});

test('backup list keeps stored destination metadata and converts database byte counts for JSON', async () => {
  const destination = { configId: 'drive', name: '阿里云盘', provider: 'ALIYUN_DRIVE', storageKey: 'system-backups/fixture.json.gz', status: 'VERIFIED' };
  const row = {
    id: 'backup', name: 'fixture', status: 'SUCCEEDED', includeObjects: false,
    retainLocal: false, destination, fileName: null, fileSize: 1234n, checksum: null,
    tableCounts: { project: 2 }, tableRows: { project: 2 }, scopes: ['projects'],
    objectCount: 0, objectBytes: 0n, message: null, createdById: user.id,
    startedAt: new Date(0), finishedAt: new Date(0), createdAt: new Date(0), updatedAt: new Date(0),
  };
  const service = serviceWith({ backup: { findMany: async () => [row] } });
  const result = await service.list(user);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].destination, destination);
  assert.equal(result[0].retainLocal, false);
  assert.equal(result[0].fileAvailable, false);
  assert.equal(result[0].fileSize, 1234);
  assert.equal(result[0].objectBytes, 0);
  assert.deepEqual(result[0].scopes, ['projects']);
  assert.doesNotThrow(() => JSON.stringify(result));
});
