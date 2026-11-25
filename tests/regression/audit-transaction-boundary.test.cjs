const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Readable } = require('node:stream');
require('ts-node').register({ project: path.resolve(__dirname, '../../apps/api/tsconfig.json'), transpileOnly: true });
const { FilesService } = require('../../apps/api/src/files/files.service.ts');
const { AuditService } = require('../../apps/api/src/audit/audit.service.ts');
const { WebdavFileService } = require('../../apps/api/src/webdav/webdav-file.service.ts');

// Model MySQL's project FK lock boundary: a root-client audit insert cannot
// acquire its shared Project lock while the interactive transaction owns it.
// Keep the actual AuditService and all version publishing methods in use.
function fixture() {
  let head = { id: 'f', projectId: 'p', storageKey: 'old', currentVersion: 1,
    status: 'ACTIVE', size: 3n, checksum: null, cdnConfigId: 'local',
    originalName: 'notes.txt', mimeType: 'text/plain', folderPath: null };
  let projectLocked = false, rootWhileLocked = 0, failClaim = false;
  const versions = [], audits = [];
  const tx = {
    $queryRaw: async strings => { if (strings[0].includes('FROM Project')) projectLocked = true; return []; },
    managedFile: {
      findUnique: async () => ({ ...head }),
      findFirst: async () => ({ ...head }),
      updateMany: async ({ where, data }) => {
        if (failClaim || where.storageKey !== head.storageKey || where.currentVersion !== head.currentVersion) return { count: 0 };
        head = { ...head, ...data }; return { count: 1 };
      },
    },
    storageReplica: { findFirst: async () => null },
    fileDerivative: { updateMany: async () => ({ count: 0 }) },
    fileVersion: {
      upsert: async ({ create }) => { if (!versions.some(row => row.version === create.version)) versions.push({ ...create }); },
      findFirst: async () => [...versions].sort((a, b) => b.version - a.version)[0] ?? null,
      findUnique: async ({ where }) => versions.find(row => row.version === where.fileId_version.version) ?? null,
    },
    auditLog: { create: async ({ data }) => { audits.push({ ...data, connection: 'transaction' }); } },
    project: { findUniqueOrThrow: async () => ({ name: 'project' }) },
    cdnConfig: { findUnique: async () => ({ id: 'local', provider: 'LOCAL' }) },
  };
  const prisma = { ...tx,
    auditLog: { create: async ({ data }) => {
      if (projectLocked) { rootWhileLocked++; throw new Error('MySQL FK shared Project lock waits on outer transaction'); }
      audits.push({ ...data, connection: 'root' });
    } },
    $transaction: async callback => {
      const savedHead = { ...head }, savedVersions = versions.slice(), savedAudits = audits.slice();
      try { return await callback(tx); }
      catch (error) { head = savedHead; versions.splice(0, versions.length, ...savedVersions); audits.splice(0, audits.length, ...savedAudits); throw error; }
      finally { projectLocked = false; }
    },
  };
  const service = Object.assign(Object.create(FilesService.prototype), {
    prisma, auditService: new AuditService(prisma),
    projectAccessService: { assertProjectAccess: async () => {} },
    storageService: {
      getDownloadTarget: async file => ({ type: 'stream', stream: Readable.from(['old']), verified: true, contentLength: Number(file.size), checksum: file.checksum }),
      upload: async () => ({ storageKey: 'new', cdnConfigId: 'local', publicUrl: null }),
      pruneFileVersions: async () => {},
    },
    eventBus: { emit() {} },
  });
  service.assertProjectQuota = async () => {};
  service.toResponse = file => file;
  return { service, prisma, tx, versions, audits, head: () => head,
    rootWhileLocked: () => rootWhileLocked, failClaim: () => { failClaim = true; } };
}

const overwrite = service => service.replaceExistingFile({ projectId: 'p', projectName: 'project', targetFileId: 'f',
  buffer: Buffer.from('new'), originalName: 'notes.txt', mimeType: 'text/plain', size: 3,
  folderPath: null, extension: 'txt', category: 'DOCUMENT', checksum: 'new' });

for (const mode of ['text save', 'overwrite', 'DAV overwrite', 'version restore']) {
  test(`${mode} publishes history and audit using the connection owning the Project lock`, async () => {
    const f = fixture();
    if (mode === 'text save') await f.service.updateTextContent('f', { content: 'new', expectedVersion: 1 }, { id: 'u' });
    else if (mode === 'overwrite') await overwrite(f.service);
    else if (mode === 'DAV overwrite') {
      const dav = new WebdavFileService(f.prisma, f.service.storageService, { ensure: async () => {} }, f.service, { emit() {} });
      await dav.writeFile({ projectId: 'p', projectName: 'project', username: 'backup' }, 'notes.txt', Buffer.from('new'), 'text/plain', 'webdav:backup');
    } else {
      f.versions.push({ fileId: 'f', version: 2, storageKey: 'historic', size: 3n, checksum: null, cdnConfigId: 'local', mimeType: 'text/plain', originalName: 'notes.txt' });
      await f.service.restoreVersionForProject('f', 2, 'p');
    }
    assert.equal(f.rootWhileLocked(), 0);
    assert.equal(f.head().currentVersion, mode === 'version restore' ? 3 : 2);
    assert.equal(f.versions.find(row => row.version === 1).storageKey, 'old');
    assert.deepEqual(f.audits.filter(row => row.action === 'FILE_VERSION_CREATE').map(row => row.connection), ['transaction']);
  });
}

test('standalone snapshot commits its history and real audit in the same transaction', async () => {
  const f = fixture();
  await f.service.snapshotCurrentVersion(f.head());
  assert.equal(f.versions.length, 1);
  assert.deepEqual(f.audits.map(row => row.connection), ['transaction']);
});

test('a failed revision claim rolls back its snapshot and real audit together', async () => {
  const f = fixture(); f.failClaim();
  await assert.rejects(overwrite(f.service), error => error.getStatus?.() === 409);
  assert.equal(f.head().currentVersion, 1);
  assert.deepEqual(f.versions, []);
  assert.deepEqual(f.audits, []);
  assert.equal(f.rootWhileLocked(), 0);
});

test('ordinary AuditService writes still use the root client outside a transaction', async () => {
  const f = fixture();
  await new AuditService(f.prisma).write({ action: 'FILE_DELETE', projectId: 'p' });
  assert.deepEqual(f.audits.map(row => row.connection), ['root']);
});
