const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
require('ts-node').register({ project: path.resolve(__dirname, '../../apps/api/tsconfig.json'), transpileOnly: true });
const { WebdavTreeService } = require('../../apps/api/src/webdav/webdav-tree.service.ts');
const { WebdavFileService } = require('../../apps/api/src/webdav/webdav-file.service.ts');
const { dispatchDav } = require('../../apps/api/src/webdav/webdav-verbs.ts');
const { StorageService } = require('../../apps/api/src/storage/storage.service.ts');

function fixture() {
  const account = { projectId: 'p', mountId: 'backup123', projectName: 'Backups', username: 'backup' };
  const file = { id: 'old', projectId: 'p', originalName: '2026-11-10.zip', folderPath: 'backups', status: 'ACTIVE',
    size: 42n, storageKey: 'objects/old', versions: [], derivatives: [], updatedAt: new Date('2026-11-10T03:00:00Z'), mimeType: 'application/zip', cdnConfig: { id: 'local', provider: 'LOCAL', config: {} } };
  const objects = new Set(['objects/old']);
  let deleted = false, fail = false;
  const db = {
    managedFile: {
      findFirst: async ({ where }) => !deleted && where.originalName === file.originalName && where.folderPath === 'backups' ? file : null,
      findUnique: async () => deleted ? null : file,
      findMany: async () => deleted ? [] : [file],
      count: async () => deleted ? 0 : 1,
      delete: async () => { deleted = true; return file; },
      updateMany: async ({where,data}) => { if(file.status!==where.status||file.storageKey!==where.storageKey)return {count:0};Object.assign(file,data);return {count:1}; },
      deleteMany: async ({where}) => { if(file.status!==where.status||file.storageKey!==where.storageKey)return {count:0};deleted=true;return {count:1}; },
    },
    managedFolder: { findFirst: async ({ where }) => where.path === 'backups' ? { id: 'folder' } : null, findMany: async () => [{ path: 'backups' }] },
    $queryRaw: async () => [],
    cdnConfig: { findMany: async () => [file.cdnConfig] },
    storageReplica: { findMany: async () => [], createMany: async () => ({ count: 0 }), updateMany: async () => ({ count: 0 }), deleteMany: async () => ({ count: 0 }) },
  };
  db.$transaction = async callback => callback(db);
  const tree = new WebdavTreeService(db, {});
  const storage = new StorageService({ get: () => undefined }, db, { adapter: () => ({
    remove: async (_config, key) => { if (fail) throw new Error('temporary storage failure'); objects.delete(key); },
    objectExists: async (_config, key) => objects.has(key),
  }) }, undefined, { releaseDeletedObject: async () => {} });
  const files = new WebdavFileService(db, storage, {}, {}, {});
  const response = () => ({ code: 200, headers: {}, status(code) { this.code = code; return this; }, setHeader(name, value) { this.headers[name] = value; }, end(body) { this.body = body; return this; } });
  return { account, objects, tree, files, response, deleted: () => deleted, fail: () => { fail = true; }, recover: () => { fail = false; } };
}

test('DAV Depth 1 lists backup names and modification times, then DELETE removes the old file', async () => {
  const f = fixture(), deps = { treeService: f.tree, fileService: f.files };
  const listing = f.response();
  await dispatchDav(deps, 'PROPFIND', f.account, 'backups', { headers: { depth: '1' } }, listing);
  assert.equal(listing.code, 207);
  assert.match(listing.body, /<D:href>\/api\/dav\/backup123\/backups\/2026-11-10.zip<\/D:href>/);
  assert.match(listing.body, /<D:getlastmodified>Tue, 10 Nov 2026 03:00:00 GMT<\/D:getlastmodified>/);
  assert.match(listing.body, /<D:getcontentlength>42<\/D:getcontentlength>/);
  const deletion = f.response();
  await dispatchDav(deps, 'DELETE', f.account, 'backups/2026-11-10.zip', { headers: {} }, deletion);
  assert.equal(deletion.code, 204);
  assert.equal(f.objects.size, 0);
  assert.equal(f.deleted(), true);
  const missing = f.response();
  await dispatchDav(deps, 'PROPFIND', f.account, 'backups/2026-11-10.zip', { headers: { depth: '0' } }, missing);
  assert.equal(missing.code, 404);
});

test('DAV DELETE preserves the file record and reports failure when physical storage deletion fails', async () => {
  const f = fixture(); f.fail();
  await assert.rejects(() => dispatchDav({ treeService: f.tree, fileService: f.files }, 'DELETE', f.account,
    'backups/2026-11-10.zip', { headers: {} }, f.response()));
  assert.equal(f.deleted(), false);
  assert.equal(f.objects.has('objects/old'), true);
  f.recover();
  await dispatchDav({ treeService: f.tree, fileService: f.files }, 'DELETE', f.account,
    'backups/2026-11-10.zip', { headers: {} }, f.response());
  assert.equal(f.deleted(),true);
});
