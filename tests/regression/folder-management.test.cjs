const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
require('ts-node').register({ project: path.resolve(__dirname, '../../apps/api/tsconfig.json'), transpileOnly: true });
const { FolderManagerService } = require('../../apps/api/src/files/folder-manager.service.ts');
const { ProjectAccessService } = require('../../apps/api/src/projects/project-access.service.ts');
const admin = { id: 'admin', username: 'admin', displayName: 'Admin', role: 'SUPER_ADMIN', totpEnabled: false };

function matches(row, where = {}) {
  return Object.entries(where).every(([key, value]) => {
    if (key === 'OR') return value.some(part => matches(row, part));
    if (key === 'projectId_path') return matches(row, value);
    if (value && typeof value === 'object') {
      if ('startsWith' in value) return typeof row[key] === 'string' && row[key].startsWith(value.startsWith);
      if ('not' in value) return row[key] !== value.not;
    }
    return row[key] === value;
  });
}

function fixture({ folders = [], files = [], root = null } = {}) {
  const state = { folders: folders.map((row, index) => ({ id: `d${index}`, ...row })), files: files.map((row, index) => ({ id: `f${index}`, ...row })), transactions: [] };
  const tx = {
    managedFolder: {
      findUnique: async ({ where }) => state.folders.find(row => matches(row, where)) || null,
      findFirst: async ({ where }) => state.folders.find(row => matches(row, where)) || null,
      findMany: async ({ where }) => state.folders.filter(row => matches(row, where)),
      count: async ({ where }) => state.folders.filter(row => matches(row, where)).length,
      delete: async ({ where }) => { const index = state.folders.findIndex(row => matches(row, where)); assert.ok(index >= 0); return state.folders.splice(index, 1)[0]; },
      upsert: async ({ where, create }) => { const found = state.folders.find(row => matches(row, where)); if (found) return found; const row = { id: `new${state.folders.length}`, ...create }; state.folders.push(row); return row; },
    },
    managedFile: {
      count: async ({ where }) => state.files.filter(row => matches(row, where)).length,
      findMany: async ({ where }) => state.files.filter(row => matches(row, where)),
      groupBy: async ({ where }) => {
        const groups = new Map();
        for (const row of state.files.filter(row => matches(row, where))) groups.set(row.folderPath, (groups.get(row.folderPath) || 0) + 1);
        return Array.from(groups, ([folderPath, count]) => ({ folderPath, _count: { _all: count } }));
      },
    },
  };
  const prisma = { ...tx,
    project: { findFirst: async ({ where }) => ['p1', 'p2'].includes(where.id) ? { id: where.id } : null },
    $transaction: async (run, options) => {
      state.transactions.push(options);
      const before = structuredClone({ folders: state.folders, files: state.files });
      try { return await run(tx); } catch (error) { state.folders = before.folders; state.files = before.files; throw error; }
    },
  };
  const service = new FolderManagerService(prisma, new ProjectAccessService(prisma), { localRoot: () => root }, { getActiveStorage: async () => ({ id: 'local' }) });
  return { service, state, prisma, tx };
}

test('removing an empty folder deletes only its registration inside a serializable transaction', async () => {
  const f = fixture({ folders: [{ projectId: 'p1', path: 'docs' }, { projectId: 'p1', path: 'docs-old' }, { projectId: 'p2', path: 'docs' }] });
  assert.equal(typeof f.service.removeEmptyForUser, 'function');
  const result = await f.service.removeEmptyForUser('p1', 'docs', admin);
  assert.equal(result.success, true);
  assert.deepEqual(f.state.folders.map(row => [row.projectId, row.path]), [['p1', 'docs-old'], ['p2', 'docs']]);
  assert.equal(f.state.transactions.at(-1).isolationLevel, 'Serializable');
});

for (const folderPath of ['docs', 'docs/nested/deep']) test(`active files in ${folderPath} block directory removal with a cleanup instruction`, async () => {
  const f = fixture({ folders: [{ projectId: 'p1', path: 'docs' }], files: [{ projectId: 'p1', folderPath, status: 'ACTIVE' }] });
  await assert.rejects(f.service.removeEmptyForUser('p1', 'docs', admin), error => error.getStatus() === 409 && /先删除.*文件/.test(error.message));
  assert.equal(f.state.folders.length, 1); assert.equal(f.state.files.length, 1);
});

test('an empty child directory must be removed before its parent', async () => {
  const f = fixture({ folders: [{ projectId: 'p1', path: 'docs' }, { projectId: 'p1', path: 'docs/empty' }] });
  await assert.rejects(f.service.removeEmptyForUser('p1', 'docs', admin), error => error.getStatus() === 409 && /先删除.*子目录/.test(error.message));
  await f.service.removeEmptyForUser('p1', 'docs/empty', admin);
  await f.service.removeEmptyForUser('p1', 'docs', admin);
  assert.deepEqual(f.state.folders, []);
});

test('recycled file metadata and bytes survive removing the folder and its path stays out of the active tree', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ufm-empty-folder-'));
  try {
    await fs.mkdir(path.join(root, 'docs')); await fs.writeFile(path.join(root, 'docs', 'retained.txt'), 'recovery bytes');
    const f = fixture({ root, folders: [{ projectId: 'p1', path: 'docs' }], files: [{ projectId: 'p1', folderPath: 'docs', status: 'RECYCLED', storageKey: 'docs/retained.txt' }] });
    await f.service.removeEmptyForUser('p1', 'docs', admin);
    assert.equal(f.state.files[0].status, 'RECYCLED');
    assert.equal(await fs.readFile(path.join(root, 'docs', 'retained.txt'), 'utf8'), 'recovery bytes');
    assert.deepEqual(await f.service.listForUser('p1', admin), []);
    assert.deepEqual(await f.service.listTreeForUser('p1', admin), []);
    f.state.files[0].status = 'ACTIVE';
    assert.deepEqual(await f.service.listForUser('p1', admin), ['docs']);
    assert.equal((await f.service.listTreeForUser('p1', admin))[0].fileCount, 1);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

for (const invalid of ['', '/', '../docs', 'docs/../other', 'docs/./other', 'C:\\docs', '/outside', 'docs\u0000bad']) test(`unsafe/root path ${JSON.stringify(invalid)} cannot delete a normalized directory`, async () => {
  const f = fixture({ folders: [{ projectId: 'p1', path: 'docs' }, { projectId: 'p1', path: 'docs/other' }] });
  await assert.rejects(f.service.removeEmptyForUser('p1', invalid, admin), error => error.getStatus() === 400);
  assert.equal(f.state.folders.length, 2);
});

test('missing folder or another project registration returns 404 without changing any data', async () => {
  const f = fixture({ folders: [{ projectId: 'p2', path: 'docs' }] });
  await assert.rejects(f.service.removeEmptyForUser('p1', 'docs', admin), error => error.getStatus() === 404);
  assert.equal(f.state.folders.length, 1);
});

test('non-admin and missing project cannot list, create or remove folders', async () => {
  const f = fixture({ folders: [{ projectId: 'p1', path: 'docs' }] });
  for (const method of ['listForUser', 'listTreeForUser', 'createForUser', 'removeEmptyForUser']) {
    const invoke = (id, user) => method.startsWith('list') ? f.service[method](id, user) : f.service[method](id, 'docs', user);
    await assert.rejects(invoke('p1', { ...admin, role: 'USER' }), error => error.getStatus() === 403);
    await assert.rejects(invoke('missing', admin), error => error.getStatus() === 404);
  }
  assert.equal(f.state.folders.length, 1);
});

test('create registers all ancestors and the tree keeps empty and active directories with direct file counts', async () => {
  const f = fixture({ files: [{ projectId: 'p1', folderPath: 'media/videos', status: 'ACTIVE' }, { projectId: 'p2', folderPath: 'other', status: 'ACTIVE' }] });
  await f.service.createForUser('p1', 'contracts/2026/november', admin);
  assert.deepEqual(f.state.folders.map(row => row.path), ['contracts', 'contracts/2026', 'contracts/2026/november']);
  assert.deepEqual(await f.service.listForUser('p1', admin), ['contracts', 'contracts/2026', 'contracts/2026/november', 'media', 'media/videos']);
  const tree = await f.service.listTreeForUser('p1', admin);
  assert.equal(tree.find(row => row.path === 'media').children[0].fileCount, 1);
  assert.equal(tree.find(row => row.path === 'contracts').children[0].children[0].fileCount, 0);
});

test('create refuses traversal and a file collision at any ancestor without leaving partial registrations', async () => {
  const f = fixture({ files: [{ projectId: 'p1', folderPath: null, originalName: 'contracts', status: 'ACTIVE' }] });
  await assert.rejects(f.service.createForUser('p1', 'contracts/2026', admin), error => error.getStatus() === 409);
  await assert.rejects(f.service.createForUser('p1', '../escape', admin), error => error.getStatus() === 400);
  assert.deepEqual(f.state.folders, []);
});

test('list uses a single project-scoped transaction so directory paths and counts share a snapshot', async () => {
  const f = fixture({ folders: [{ projectId: 'p1', path: 'empty' }] });
  f.prisma.managedFolder = { findMany: async () => { throw new Error('outside transaction'); } };
  f.prisma.managedFile = { groupBy: async () => { throw new Error('outside transaction'); }, findMany: async () => { throw new Error('outside transaction'); } };
  assert.deepEqual(await f.service.listForUser('p1', admin), ['empty']);
  assert.equal((await f.service.listTreeForUser('p1', admin))[0].path, 'empty');
  assert.equal(f.state.transactions.length, 2);
});

test('explicit recycled browsing retains deleted folder paths while the active listing omits them', async () => {
  const f = fixture({ folders: [{ projectId: 'p1', path: 'empty' }], files: [{ projectId: 'p1', folderPath: 'old/sub', status: 'RECYCLED' }] });
  assert.deepEqual(await f.service.listForUser('p1', admin), ['empty']);
  assert.deepEqual(await f.service.listForUser('p1', admin, 'RECYCLED'), ['old', 'old/sub']);
  assert.equal((await f.service.listTreeForUser('p1', admin, 'RECYCLED'))[0].children[0].fileCount, 1);
});
