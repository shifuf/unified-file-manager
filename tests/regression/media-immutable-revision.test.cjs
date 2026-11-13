const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const { Readable } = require('node:stream');
const sharp = require('sharp');
require('ts-node').register({ project: path.resolve(__dirname, '../../apps/api/tsconfig.json'), transpileOnly: true });
const { VideoPipelineService } = require('../../apps/api/src/media/video-pipeline.service.ts');
const { ImagePipelineService } = require('../../apps/api/src/media/image-pipeline.service.ts');
const hash = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
const copy = value => structuredClone(value);

async function fixture(category = 'VIDEO') {
  const source = category === 'IMAGE' ? await sharp({ create: { width: 8, height: 8, channels: 3, background: '#dd2211' } }).png().toBuffer() : Buffer.from('video source A');
  let current = { id: 'same-file', projectId: 'p', storageKey: 'p/2026-11-13/original.jpg', originalName: 'original', currentVersion: 1, checksum: hash(source), size: BigInt(source.length), status: 'ACTIVE', category, cdnConfig: null, thumbnailUrl: null };
  const sources = new Map([[current.storageKey, source]]), objects = new Map(), derivatives = new Map(), commits = [], listeners = new Map();
  let onUpload;
  const readCurrent = include => ({ ...copy(current), ...(include?.derivatives ? { derivatives: copy([...derivatives.values()]) } : {}) });
  const managedFile = {
    findFirst: async ({ where, include }) => matches(current, where) ? readCurrent(include) : null,
    findUnique: async ({ include }) => readCurrent(include),
    update: async ({ data }) => { Object.assign(current, data); return copy(current); },
    updateMany: async ({ where, data }) => {
      if (!matches(current, where)) return { count: 0 };
      Object.assign(current, data); return { count: 1 };
    },
  };
  const fileDerivative = { upsert: async ({ where, create, update }) => {
    const kind = where.fileId_kind.kind;
    const row = derivatives.has(kind) ? { ...derivatives.get(kind), ...update } : { ...create };
    derivatives.set(kind, row); commits.push(copy(row)); return copy(row);
  } };
  const tx = { managedFile, fileDerivative };
  const prisma = { ...tx, $transaction: async operation => typeof operation === 'function' ? operation(tx) : Promise.all(operation) };
  const storage = {
    getDownloadTarget: async file => ({ type: 'stream', stream: Readable.from([sources.get(file.storageKey)]) }),
    upload: async (projectId, { key, buffer }) => {
      if (objects.has(key) && !objects.get(key).equals(buffer)) throw new Error('immutable object key collision');
      objects.set(key, Buffer.from(buffer));
      await onUpload?.(key);
      return { storageKey: key, publicUrl: null };
    },
    buildPublicAccessUrl: id => `https://files.shifuf.com/api/public/files/${id}`,
    buildPublicDerivativeUrl: (id, kind) => `https://files.shifuf.com/api/public/files/${id}/derivatives/${kind}`,
    buildPublicDerivativePath: (id, kind, name) => `/api/public/files/${id}/derivatives/${kind}/${name}`,
  };
  const config = { get: key => ['VIDEO_TRANSCODE_ENABLED', 'VIDEO_HLS_ENABLED'].includes(key) ? true : undefined };
  const events = { on(event, listener) { listeners.set(event, listener); } };
  const service = category === 'IMAGE' ? new ImagePipelineService(config, events, prisma, storage) : new VideoPipelineService(config, events, prisma, storage);
  service.onModuleInit();
  if (category === 'VIDEO') service.runFfmpeg = async args => {
    const input = args[args.indexOf('-i') + 1], output = args.at(-1), bytes = await fs.readFile(input);
    if (output.endsWith('.m3u8')) {
      await fs.writeFile(path.join(path.dirname(output), 'seg_000.ts'), Buffer.concat([Buffer.from('segment:'), bytes]));
      await fs.writeFile(output, '#EXTM3U\n#EXTINF:6,\nseg_000.ts\n#EXT-X-ENDLIST\n');
    } else await fs.writeFile(output, Buffer.concat([Buffer.from(path.basename(output) + ':'), bytes]));
  };
  return { service, objects, derivatives, commits, async emitUpdated() { await listeners.get('file.updated')?.({ fileId: 'same-file', projectId: 'p', originalName: current.originalName }); }, get current() { return current; }, set onUpload(hook) { onUpload = hook; }, async replace(label = 'B') {
    const buffer = category === 'IMAGE' ? await sharp({ create: { width: 8, height: 8, channels: 3, background: '#1155dd' } }).png().toBuffer() : Buffer.from(`video source ${label}`);
    // Same stem and day, distinct source key: image used to lose the extension.
    current = { ...current, storageKey: `p/2026-11-13/original.${label === 'B' ? 'png' : 'webp'}`, currentVersion: current.currentVersion + 1, checksum: hash(buffer), size: BigInt(buffer.length), thumbnailUrl: null };
    sources.set(current.storageKey, buffer);
  } };
}
function matches(row, where = {}) { return Object.entries(where).every(([key, value]) => value === undefined || row[key] === value); }
const run = f => f.current.category === 'VIDEO' ? f.service.processVideo('same-file') : f.service.generateThumbnail('same-file');

for (const category of ['VIDEO', 'IMAGE']) test(`${category} updated source automatically regenerates derivatives for its current revision`, async () => {
  const f = await fixture(category);
  await run(f);
  const oldKeys = new Set(f.objects.keys());
  await f.replace();
  await f.emitUpdated();
  for (const row of f.derivatives.values()) {
    assert.equal(row.status, 'READY');
    assert.equal(row.meta.sourceVersion, 2, 'update event must publish the restored current revision');
    assert.equal(row.meta.sourceStorageKey, 'p/2026-11-13/original.png');
    assert.ok(!oldKeys.has(row.storageKey));
  }
});

for (const category of ['VIDEO', 'IMAGE']) test(`${category} metadata updates keep matching READY derivatives available without re-encoding`, async () => {
  const f = await fixture(category);
  await run(f);
  const commitCount = f.commits.length;
  f.current.originalName = 'renamed';
  if (category === 'VIDEO') await f.service.processVideo('same-file', true);
  else await f.service.generateThumbnail('same-file', true);
  await f.emitUpdated();
  assert.equal(f.commits.length, commitCount, 'matching READY derivatives must not enter PENDING again');
  assert.ok([...f.derivatives.values()].every(row => row.status === 'READY'));
});

for (const category of ['VIDEO', 'IMAGE']) test(`${category} update listener reads current category before generating`, async () => {
  const f = await fixture(category);
  f.current.category = 'DOCUMENT';
  await f.emitUpdated();
  assert.equal(f.objects.size, 0);
  assert.equal(f.derivatives.size, 0);
});

for (const category of ['VIDEO', 'IMAGE']) test(`${category} replacement gives every derivative a new immutable object key`, async () => {
  const f = await fixture(category);
  await run(f);
  const oldKeys = new Set(f.objects.keys()), oldRows = copy([...f.derivatives.values()]);
  await f.replace();
  await run(f);
  const newRows = [...f.derivatives.values()];
  assert.ok(newRows.every(row => row.status === 'READY'), 'all replacement derivatives must complete');
  for (const row of newRows) assert.ok(!oldKeys.has(row.storageKey), `${row.kind} must use the new source revision`);
  for (const row of oldRows) assert.ok(f.objects.has(row.storageKey), 'old immutable bytes remain available');
  if (category === 'VIDEO') {
    const oldHls = oldRows.find(row => row.kind === 'HLS'), newHls = newRows.find(row => row.kind === 'HLS');
    assert.notEqual(oldHls.meta.segmentPrefix, newHls.meta.segmentPrefix);
    for (const name of newHls.meta.files) assert.ok(!oldKeys.has(`${newHls.meta.segmentPrefix}/${name}`), 'HLS segment/playlist names stay isolated');
  }
});

for (const category of ['VIDEO', 'IMAGE']) test(`${category} worker cannot publish after its source changes during upload`, async () => {
  const f = await fixture(category);
  let replaced = false;
  const kind = category === 'VIDEO' ? 'COVER' : 'THUMB';
  f.onUpload = async () => {
    if (replaced) return;
    replaced = true; await f.replace();
    f.derivatives.set(kind, { fileId: 'same-file', kind, storageKey: 'newer-ready-object', status: 'READY', publicUrl: 'newer-url', meta: { sourceVersion: 2 } });
    f.current.thumbnailUrl = 'newer-thumbnail';
  };
  await run(f);
  assert.equal(f.derivatives.get(kind).storageKey, 'newer-ready-object');
  assert.equal(f.derivatives.get(kind).status, 'READY');
  assert.equal(f.current.thumbnailUrl, 'newer-thumbnail');
});

test('a late failed video worker cannot mark a newer READY cover as failed', async () => {
  const f = await fixture();
  f.service.runFfmpeg = async () => {
    await f.replace();
    f.derivatives.set('COVER', { fileId: 'same-file', kind: 'COVER', storageKey: 'new-cover', status: 'READY' });
    throw new Error('old encoder failed');
  };
  await run(f);
  assert.equal(f.derivatives.get('COVER').status, 'READY');
  assert.equal(f.derivatives.get('COVER').storageKey, 'new-cover');
});

test('a late failed image worker cannot mark a newer READY thumbnail as failed', async () => {
  const f = await fixture('IMAGE');
  f.service.readFileBuffer = async () => {
    await f.replace();
    f.derivatives.set('THUMB', { fileId: 'same-file', kind: 'THUMB', storageKey: 'new-thumb', status: 'READY' });
    throw new Error('old image decode failed');
  };
  await f.service.handleUploaded('same-file', 'IMAGE');
  assert.equal(f.derivatives.get('THUMB').status, 'READY');
  assert.equal(f.derivatives.get('THUMB').storageKey, 'new-thumb');
});

for (const kind of ['MP4_720', 'HLS']) test(`a ${kind} upload finishing for an old source cannot publish over a newer READY result`, async () => {
  const f = await fixture();
  let replaced = false;
  f.onUpload = async key => {
    if (replaced || !(kind === 'MP4_720' ? key.endsWith('-720p.mp4') : key.endsWith('/master.m3u8'))) return;
    replaced = true;
    await f.replace();
    f.derivatives.set(kind, { fileId: 'same-file', kind, storageKey: 'new-media-object', status: 'READY', meta: { sourceVersion: 2 } });
  };
  await run(f);
  assert.ok(replaced, 'exercise the selected output publication boundary');
  assert.equal(f.derivatives.get(kind).status, 'READY');
  assert.equal(f.derivatives.get(kind).storageKey, 'new-media-object');
});

for (const kind of ['MP4_720', 'HLS']) test(`a late failed ${kind} encoder cannot mark a newer READY result as failed`, async () => {
  const f = await fixture();
  const encode = f.service.runFfmpeg;
  let replaced = false;
  f.service.runFfmpeg = async args => {
    const output = args.at(-1);
    if (!replaced && (kind === 'MP4_720' ? output.endsWith('.mp4') : output.endsWith('.m3u8'))) {
      replaced = true;
      await f.replace();
      f.derivatives.set(kind, { fileId: 'same-file', kind, storageKey: 'new-media-object', status: 'READY' });
      throw new Error(`old ${kind} encoder failed`);
    }
    await encode(args);
  };
  await run(f);
  assert.ok(replaced, 'exercise the selected encoder failure boundary');
  assert.equal(f.derivatives.get(kind).status, 'READY');
  assert.equal(f.derivatives.get(kind).storageKey, 'new-media-object');
});
