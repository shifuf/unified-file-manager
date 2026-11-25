const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Readable } = require('node:stream');
require('ts-node').register({ project: path.resolve(__dirname, '../../apps/api/tsconfig.json'), transpileOnly: true });
const { FilesService } = require('../../apps/api/src/files/files.service.ts');
const { StorageService } = require('../../apps/api/src/storage/storage.service.ts');

// Only persistence and object transport are substituted; saves, optimistic
// revision claims, snapshot creation and the version API are production code.
function fixture() {
  let head = { id: 'f', projectId: 'p', originalName: 'notes.txt', mimeType: 'text/plain', status: 'ACTIVE',
    size: 3n, storageKey: 'object-1', checksum: null, currentVersion: 1, cdnConfigId: 'local', folderPath: null };
  const versions = [];
  const objects = new Map([['object-1', Buffer.from('one')]]);
  const local = { id: 'local', name: 'Local', provider: 'LOCAL', config: {} };
  const replicas = [];
  let sequence = 1;
  function matches(row, where = {}) {
    return Object.entries(where).every(([key, value]) => {
      if (value && typeof value === 'object') {
        if ('in' in value) return value.in.includes(row[key]);
        if ('not' in value) return row[key] !== value.not;
        if ('lt' in value) return row[key] < value.lt;
        if ('lte' in value) return row[key] <= value.lte;
      }
      return row[key] === value;
    });
  }
  const db = {
    managedFile: {
      findUnique: async () => ({ ...head, versions, derivatives: [], cdnConfig: local }),
      findFirst: async ({ where }) => matches(head, where) ? { ...head } : null,
      updateMany: async ({ where, data }) => { if (!matches(head, where)) return { count: 0 }; head = { ...head, ...data }; return { count: 1 }; },
    },
    project: { findUniqueOrThrow: async () => ({ name: 'project' }) },
    fileDerivative: { updateMany: async () => ({ count: 0 }), findFirst: async () => null },
    cdnConfig: { findMany: async () => [local] },
    $queryRaw: async () => [],
    storageReplica: {
      findFirst: async ({ where }) => replicas.find(row => matches(row, where)) ?? null,
      findMany: async ({ where }) => replicas.filter(row => matches(row, where)),
      createMany: async ({ data }) => { for (const row of data) replicas.push(row); return { count: data.length }; },
      updateMany: async ({ where, data }) => { const rows = replicas.filter(row => matches(row, where)); rows.forEach(row => Object.assign(row, data)); return { count: rows.length }; },
      deleteMany: async ({ where }) => { for (let index = replicas.length - 1; index >= 0; index--) if (matches(replicas[index], where)) replicas.splice(index, 1); return { count: 0 }; },
    },
    fileVersion: {
      findFirst: async () => [...versions].sort((a, b) => b.version - a.version)[0] ?? null,
      findMany: async ({ where, skip = 0, take }) => {
        const rows = versions.filter(row => matches(row, where)).sort((a, b) => b.version - a.version);
        return rows.slice(skip, take === undefined ? undefined : skip + take);
      },
      upsert: async ({ create }) => { if (!versions.some(row => row.version === create.version)) versions.push({ id: `v${create.version}`, createdAt: new Date(), ...create }); },
      deleteMany: async ({ where }) => { let count = 0; for (let index = versions.length - 1; index >= 0; index--) if (matches(versions[index], where)) { versions.splice(index, 1); count++; } return { count }; },
    },
  };
  db.$transaction = async callback => callback(db);
  const storage = new StorageService({ get: () => undefined }, db, { adapter: () => ({
    remove: async (_config, key) => { objects.delete(key); }, objectExists: async (_config, key) => objects.has(key),
  }) }, undefined, { releaseDeletedObject: async () => {} });
  const service = Object.assign(Object.create(FilesService.prototype), {
    prisma: db, projectAccessService: { assertProjectAccess: async () => {} },
    storageService: {
      pruneFileVersions: id => storage.pruneFileVersions(id),
      getDownloadTarget: async file => ({ type: 'stream', stream: Readable.from([objects.get(file.storageKey)]) }),
      upload: async (_project, input) => { const storageKey = `object-${++sequence}`; objects.set(storageKey, input.buffer); return { storageKey, cdnConfigId: 'local', publicUrl: null }; },
      remove: async (_config, key) => { objects.delete(key); },
    },
    auditService: { write: async () => {} }, eventBus: { emit: () => {} },
  });
  service.assertProjectQuota = async () => {};
  service.toResponse = file => file;
  return { service, storage, versions, objects, replicas, head: () => head };
}

test('six successful saves retain the newest three historical revisions while the current file remains readable', async () => {
  const f = fixture();
  for (let expectedVersion = 1; expectedVersion <= 6; expectedVersion++) {
    await f.service.updateTextContent('f', { content: `content-${expectedVersion + 1}`, expectedVersion }, { id: 'u' });
  }
  const history = await f.service.listVersions('f', { id: 'u' });
  assert.deepEqual(history.map(row => row.version), [6, 5, 4]);
  assert.equal(f.head().currentVersion, 7);
  assert.equal(f.objects.get(f.head().storageKey).toString(), 'content-7');
  assert.deepEqual(f.versions.map(row => row.version).sort((a, b) => b - a), [6, 5, 4], 'older metadata must be removed, not only hidden in the API');
  assert.equal(f.objects.has('object-1'), false, 'unreferenced old bytes must be removed too');
});

test('an existing file with excess history can be pruned directly without saving or starting the application', async () => {
  const f = fixture();
  for (let version = 1; version <= 6; version++) {
    const storageKey = `legacy-${version}`;
    f.versions.push({ id: `legacy-version-${version}`, fileId: 'f', version, storageKey, size: 3n, cdnConfigId: 'local' });
    f.objects.set(storageKey, Buffer.from('old'));
    f.replicas.push({ projectId: 'p', configId: 'local', config: { id: 'local', provider: 'LOCAL', name: 'Local', config: {} }, storageKey, status: 'READY' });
  }
  await f.storage.pruneFileVersions('f');
  assert.deepEqual(f.versions.map(row => row.version), [4, 5, 6]);
  assert.deepEqual([...f.objects.keys()].sort(), ['legacy-4', 'legacy-5', 'legacy-6', 'object-1']);
  assert.deepEqual(f.replicas.map(row => row.storageKey).sort(), ['legacy-4', 'legacy-5', 'legacy-6']);
  assert.equal(f.head().currentVersion, 1);
});

test('pruning old metadata keeps bytes still referenced by the readable current file', async () => {
  const f = fixture();
  for (let version = 1; version <= 4; version++) {
    const storageKey = version === 1 ? 'object-1' : `legacy-${version}`;
    f.versions.push({ id: `legacy-version-${version}`, fileId: 'f', version, storageKey, size: 3n, cdnConfigId: 'local' });
    f.objects.set(storageKey, Buffer.from('one'));
  }
  await f.storage.pruneFileVersions('f');
  assert.deepEqual(f.versions.map(row => row.version), [2, 3, 4]);
  assert.equal(f.objects.get('object-1').toString(), 'one');
});

test('a delayed production save cannot republish a pruned version after newer saves commit', async () => {
 const f = fixture();
 let release, arrived;
 const paused = new Promise(resolve => { release = resolve; });
 const entered = new Promise(resolve => { arrived = resolve; });
 const read = f.service.storageService.getDownloadTarget;
 let first = true;
 f.service.storageService.getDownloadTarget = async file => {
  const target = await read(file);
  if (first) { first = false; arrived(); await paused; }
  return target;
 };
 const stale = f.service.updateTextContent('f', { content: 'stale', expectedVersion: 1 }, { id: 'u' });
 const rejected = assert.rejects(stale, error => error.getStatus?.() === 409);
 await entered;
 for (let expectedVersion = 1; expectedVersion <= 6; expectedVersion++) {
  await f.service.updateTextContent('f', { content: `new-${expectedVersion}`, expectedVersion }, { id: 'u' });
 }
 release(); await rejected;
 assert.deepEqual(f.versions.map(row => row.version).sort((a, b) => b - a), [6, 5, 4]);
 assert.equal(f.head().currentVersion, 7);
});

test('failed object upload does not publish history for an unchanged HEAD', async () => {
 const f = fixture();
 f.service.storageService.upload = async () => { throw new Error('storage offline'); };
 await assert.rejects(f.service.updateTextContent('f', { content: 'new', expectedVersion: 1 }, { id: 'u' }), /storage offline/);
 assert.deepEqual(f.versions, []);
 assert.equal(f.head().currentVersion, 1);
});

test('DAV overwrites publish revisions and retain the same three usable historical versions', async () => {
 const { WebdavFileService } = require('../../apps/api/src/webdav/webdav-file.service.ts');
 const f = fixture();
 const dav = new WebdavFileService(f.service.prisma, f.service.storageService, { ensure: async () => {} }, f.service, { emit() {} });
 for (let version = 2; version <= 7; version++) {
  await dav.writeFile({ projectId: 'p', projectName: 'project', username: 'backup' }, 'notes.txt', Buffer.from(`dav-${version}`), 'text/plain', 'webdav:backup');
 }
 assert.equal(f.head().currentVersion, 7);
 assert.deepEqual(f.versions.map(row => row.version).sort((a, b) => b - a), [6, 5, 4]);
 for (const version of f.versions) assert.equal(f.objects.has(version.storageKey), true);
});
