const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
require('ts-node').register({ project: path.resolve(__dirname, '../../apps/api/tsconfig.json'), transpileOnly: true, moduleTypes: { '**/apps/web/src/utils/remote-sync.ts': 'cjs' } });
const { collectRemoteSyncFiles, createRemoteSyncBatches, refreshRemoteSyncBatch } = require('../../apps/web/src/utils/remote-sync.ts');

const file = (id, parentId = 'root', extra = {}) => ({ id, parentId, name: `${id}.txt`, type: 'file', size: 1, ...extra });
const folder = (id, name = id, parentId = 'root') => ({ id, name, parentId, type: 'folder', size: 0 });
const page = (parentId, items, nextCursor = null) => ({ parentId, items, nextCursor });

// These tests catch incomplete recursive imports, accidental duplicate work, lost
// relative paths, unbounded cloud pagination and incorrectly combined API batches.
test('selected files and folder contents keep relative paths and exhaust every directory page', async () => {
  const calls = [];
  const files = await collectRemoteSyncFiles({
    entries: [file('direct'), folder('assets', '设计资料')],
    folderPath: '拉取/资料',
    list: async query => {
      calls.push(query);
      if (query.parentId === 'assets' && !query.cursor) return page('assets', [file('a', 'assets'), folder('nested', '图标', 'assets')], 'page-2');
      if (query.parentId === 'assets') return page('assets', [file('b', 'assets', { originalName: '原始名称.pdf' })]);
      return page('nested', [file('c', 'nested')]);
    },
  });
  assert.deepEqual(files.map(({ id, name, folderPath }) => ({ id, name, folderPath })), [
    { id: 'direct', name: 'direct.txt', folderPath: '拉取/资料' },
    { id: 'a', name: 'a.txt', folderPath: '拉取/资料/设计资料' },
    { id: 'b', name: '原始名称.pdf', folderPath: '拉取/资料/设计资料' },
    { id: 'c', name: 'c.txt', folderPath: '拉取/资料/设计资料/图标' },
  ]);
  assert.deepEqual(calls, [{ parentId: 'assets' }, { parentId: 'assets', cursor: 'page-2' }, { parentId: 'nested' }]);
});

test('current-directory sync re-reads every page and deduplicates overlapping files', async () => {
  const files = await collectRemoteSyncFiles({
    parentId: 'root',
    folderPath: '',
    list: async query => !query.cursor ? page('root', [file('a'), folder('assets', '资料')], 'again')
      : page('root', [file('a'), file('b')]),
  }).catch(error => error);
  // A provider returning the root page for a child is rejected before importing
  // the otherwise valid first page.
  assert.ok(files instanceof Error);
  assert.match(files.message, /目录/);
  const collected = await collectRemoteSyncFiles({
    parentId: 'root',
    list: async query => query.parentId === 'assets' ? page('assets', [file('a', 'assets'), file('c', 'assets')])
      : !query.cursor ? page('root', [file('a'), folder('assets', '资料')], 'again')
        : page('root', [file('a'), file('b')]),
  });
  assert.deepEqual(collected.map(({ id, folderPath }) => ({ id, folderPath })), [
    { id: 'a', folderPath: '' }, { id: 'b', folderPath: '' }, { id: 'c', folderPath: '资料' },
  ]);
});

test('pagination cycles, directory cycles and partial listing failures abort enumeration', async () => {
  let reads = 0;
  await assert.rejects(collectRemoteSyncFiles({ parentId: 'root', list: async () => { reads++; return page('root', [file('a')], 'same'); } }), /分页/);
  assert.equal(reads, 2);
  await assert.rejects(collectRemoteSyncFiles({ parentId: 'root', list: async () => page('root', [folder('root')]) }), /循环|重复/);
  await assert.rejects(collectRemoteSyncFiles({ parentId: 'root', list: async query => {
    if (query.cursor) throw new Error('第二页无法读取');
    return page('root', [file('a')], 'next');
  } }), /第二页无法读取/);
});

test('2000 files are allowed and a 2001st file aborts before any import', async () => {
  const entries = Array.from({ length: 2000 }, (_, index) => file(String(index)));
  const collected = await collectRemoteSyncFiles({ entries, list: async () => { throw new Error('files need no listing'); } });
  assert.equal(collected.length, 2000);
  await assert.rejects(collectRemoteSyncFiles({ entries: [...entries, file('overflow')], list: async () => page('root', []) }), /2000/);
});

test('directory depth, empty-directory fanout and unsafe relative paths are bounded', async () => {
  await assert.rejects(collectRemoteSyncFiles({ parentId: 'root', list: async ({ parentId }) => {
    const depth = parentId === 'root' ? 0 : Number(parentId.slice(1));
    return page(parentId, [folder(`d${depth + 1}`, '层', parentId)]);
  } }), /64/);
  await assert.rejects(collectRemoteSyncFiles({ parentId: 'root', list: async ({ parentId }) => parentId === 'root'
    ? page('root', Array.from({ length: 2001 }, (_, i) => folder(`dir-${i}`))) : page(parentId, []) }), /2000/);
  await assert.rejects(collectRemoteSyncFiles({ entries: [folder('unsafe', '../其他目录')], list: async () => page('unsafe', []) }), /目录名/);
  await assert.rejects(collectRemoteSyncFiles({ entries: [file('a')], folderPath: '../外部', list: async () => page('root', []) }), /目标目录/);
});

test('API batches preserve destination and target identity, submit one source per request and reject missing targets', () => {
  const files = Array.from({ length: 21 }, (_, index) => ({ id: `f${index}`, name: `f${index}`, folderPath: '资料' }));
  files.push({ id: 'other', name: 'other', folderPath: '资料/子目录' });
  const batches = createRemoteSyncBatches(files, ['p1', 'p2']);
  assert.deepEqual(batches.map(batch => ({ ids: batch.files.map(file => file.id), folderPath: batch.folderPath, projectIds: batch.projectIds })), [
    ...Array.from({ length: 21 }, (_, i) => ({ ids: [`f${i}`], folderPath: '资料', projectIds: ['p1', 'p2'] })),
    { ids: ['other'], folderPath: '资料/子目录', projectIds: ['p1', 'p2'] },
  ]);
  assert.throws(() => createRemoteSyncBatches(files, []), /项目/);
  assert.throws(() => createRemoteSyncBatches(files, Array.from({ length: 21 }, (_, i) => `p${i}`)), /20/);
});

test('verified source business folders append to relative destination and unsafe paths stop discovery', async () => {
  const collected = await collectRemoteSyncFiles({ entries: [
    file('a', 'root', { folderPath: '设计/指南', originalName: '原始文件.pdf' }),
    folder('assets', '云盘资料'),
  ], folderPath: '取回', list: async () => page('assets', [file('b', 'assets', { folderPath: '业务目录' })]) });
  assert.deepEqual(collected.map(({ id, folderPath }) => ({ id, folderPath })), [
    { id: 'a', folderPath: '取回/设计/指南' }, { id: 'b', folderPath: '取回/云盘资料/业务目录' },
  ]);
  for (const folderPath of ['/绝对路径', '../上级', 'a/../上级', 'C:/Windows', 'a\\b', 'a//b']) {
    await assert.rejects(collectRemoteSyncFiles({ entries: [file('unsafe', 'root', { folderPath })], list: async () => page('root', []) }), /原目录/);
  }
});

test('every batch refreshes its exact source page immediately before import without evicting earlier snapshots', async () => {
  const queries = [];
  const collected = await collectRemoteSyncFiles({ parentId: 'root', list: async query => {
    if (!query.cursor) return page('root', [file('first')], 'last-page');
    return page('root', [file('last')]);
  } });
  const batches = createRemoteSyncBatches(collected, ['p1']);
  assert.equal(batches.length, 2, 'source pages must not share a batch');
  for (const batch of batches) {
    await refreshRemoteSyncBatch(batch, async query => {
      queries.push(query);
      return page('root', [query.cursor ? file('last') : file('first')]);
    });
  }
  assert.deepEqual(queries, [{ parentId: 'root' }, { parentId: 'root', cursor: 'last-page' }]);
  queries.length = 0;
  await refreshRemoteSyncBatch(batches[0], async query => { queries.push(query); return page('root', [file('first')]); });
  assert.deepEqual(queries, [{ parentId: 'root' }], 'retry also renews its source snapshot');
});

test('batch refresh refuses missing, resized, rehashed, renamed or moved files against the original baseline', async () => {
  const original = file('a', 'root', { sha1: 'a'.repeat(40), checksum: 'b'.repeat(64), originalName: '原名.txt', folderPath: '目录' });
  const files = await collectRemoteSyncFiles({ entries: [original], list: async () => page('root', []) });
  const batch = createRemoteSyncBatches(files, ['p1'])[0];
  const mutations = [undefined, { ...original, type: 'folder' }, { ...original, size: 2 }, { ...original, sha1: 'c'.repeat(40) },
    { ...original, checksum: undefined }, { ...original, originalName: '改名.txt' }, { ...original, folderPath: '其他目录' }];
  for (const changed of mutations) await assert.rejects(refreshRemoteSyncBatch(batch, async () => page('root', changed ? [changed] : [])), /变化|不存在|位置/);
  await assert.rejects(refreshRemoteSyncBatch(batch, async () => page('elsewhere', [original])), /目录/);
});
