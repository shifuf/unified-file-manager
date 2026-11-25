const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { createHash } = require('node:crypto');
const { readFile } = require('node:fs/promises');
const { resolve } = require('node:path');
require('ts-node').register({ project: resolve(__dirname, '../../apps/api/tsconfig.json'), transpileOnly: true });
const { UpyunAdapter } = require('../../plugins/upyun/index.ts');
const { ReplicaService } = require('../../apps/api/src/storage/replica.service.ts');
const { StorageService } = require('../../apps/api/src/storage/storage.service.ts');
const { StorageLimitError } = require('../../apps/api/src/storage/storage-limits.service.ts');
const payload = Buffer.from('verified CDN immutable content');
const checksum = createHash('sha256').update(payload).digest('hex');

async function fixture(t, mode, { quota = 10000n, secret, badOrigin = false } = {}) {
 const calls = [];
 const origin = createServer((req, res) => {
  calls.push('ORIGIN');
  assert.equal(req.url, '/bucket/p/object');
  assert.equal(req.headers.authorization, 'Basic dGVzdDp0ZXN0');
  res.writeHead(200, { 'Content-Length': payload.length }); res.end(badOrigin ? Buffer.alloc(payload.length, 120) : payload);
 });
 const cdn = createServer((req, res) => {
  calls.push('CDN');
  assert.equal(req.url, '/p/object');
  assert.equal(req.headers.authorization, undefined, 'origin credentials must never be sent to CDN');
  if (mode === 403 || mode === 404) { res.writeHead(mode); res.end(); return; }
  res.writeHead(200, { 'Content-Length': payload.length });
  res.end(mode === 'bad-hash' ? Buffer.alloc(payload.length, 120) : payload);
 });
 await Promise.all([new Promise(r => origin.listen(0, '127.0.0.1', r)), new Promise(r => cdn.listen(0, '127.0.0.1', r))]);
 t.after(() => Promise.all([new Promise(r => origin.close(r)), new Promise(r => cdn.close(r))]));
 const config = { id: 'upyun', name: 'upyun', provider: 'UPYUN', enabled: true, priority: 1,
  trafficLimitEnabled: true, trafficQuotaMode: 'FIXED', trafficPeriodKey: null, quotaRevision: 0,
  manualTrafficUsedBytes: 0n, trafficQuotaBytes: quota, trackedStorageBytes: 0n, storageBaselineBytes: null,
  config: { bucket: 'bucket', operator: 'test', password: 'test', endpoint: `http://127.0.0.1:${origin.address().port}`, domain: `http://127.0.0.1:${cdn.address().port}`, ...(secret ? { tokenSecret: secret } : {}) } };
 const db = { cdnConfig: {
  findFirst: async () => ({ ...config }), findMany: async () => [config],
  updateMany: async ({ where, data }) => {
   if (!Object.entries(where).every(([key, value]) => config[key] === value)) return { count: 0 };
   for (const [key, value] of Object.entries(data)) config[key] = typeof value === 'object' && value !== null ? config[key] - value.decrement : value;
   return { count: 1 };
  },
 }, storageReplica: { findMany: async () => [{ configId: config.id, config, status: 'READY', size: BigInt(payload.length), checksum }] } };
 const service = new ReplicaService({ get: () => undefined }, db, { adapter: () => new UpyunAdapter() });
 return { config, calls, service, db, setMode: value => { mode = value; } };
}

test('upload confirmation rejects corrupt origin even when CDN has the expected bytes', async t => {
 const f = await fixture(t, 'good', { badOrigin: true });
 await assert.rejects(f.service.confirmStoredObject(f.config, 'p/object', payload.length, checksum), /checksum|校验|SHA/i);
 assert.deepEqual(f.calls, ['ORIGIN']);
});

test('UPYUN serves a fully SHA-verified CDN object without reading authenticated origin', async t => {
 const f = await fixture(t, 'good');
 const object = await f.service.readVerified(f.config, 'p/object', payload.length, checksum, undefined, { allowCdn: true });
 try { assert.deepEqual(await readFile(object.path), payload); assert.deepEqual(f.calls, ['CDN']); }
 finally { await object.cleanup(); }
 assert.equal(f.config.manualTrafficUsedBytes, BigInt(payload.length));
});

for (const mode of [403, 404, 'bad-hash']) {
 test(`UPYUN ${mode} CDN response falls back to verified REST with source attempts and actual consumed traffic`, async t => {
  const f = await fixture(t, mode);
  const target = await f.service.getDownloadTargetForKey({ id: 'file', projectId: 'p', storageKey: 'p/object', size: BigInt(payload.length), checksum, cdnConfig: f.config }, 'p/object');
  const chunks = []; for await (const chunk of target.stream) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), payload);
  assert.deepEqual(f.calls, ['CDN', 'ORIGIN']);
  assert.deepEqual(target.storageSource.attempts.map(({ route, outcome }) => ({ route, outcome })), [{ route: 'CDN', outcome: 'FAILED' }, { route: 'ORIGIN', outcome: 'SELECTED' }]);
  assert.equal(f.config.manualTrafficUsedBytes, BigInt(payload.length * (mode === 'bad-hash' ? 2 : 1)));
 });
}

test('UPYUN cannot spend the same traffic balance again after a bad CDN digest', async t => {
 const f = await fixture(t, 'bad-hash', { quota: BigInt(payload.length) });
 await assert.rejects(f.service.readVerified(f.config, 'p/object', payload.length, checksum, undefined, { allowCdn: true }), StorageLimitError);
 assert.deepEqual(f.calls, ['CDN']);
 assert.equal(f.config.manualTrafficUsedBytes, BigInt(payload.length));
});

test('UPYUN signed CDN configurations keep authenticated origin reads', async t => {
 const f = await fixture(t, 'good', { secret: 'token-secret' });
 const object = await f.service.readVerified(f.config, 'p/object', payload.length, checksum, undefined, { allowCdn: true });
 try { assert.deepEqual(await readFile(object.path), payload); assert.deepEqual(f.calls, ['ORIGIN']); }
 finally { await object.cleanup(); }
});

test('UPYUN rechecks SHA after a CDN object changes under the same immutable key', async t => {
 const f = await fixture(t, 'good');
 for (let i = 0; i < 2; i++) {
  const object = await f.service.readVerified(f.config, 'p/object', payload.length, checksum, undefined, { allowCdn: true });
  try { assert.deepEqual(await readFile(object.path), payload); } finally { await object.cleanup(); }
  f.setMode('bad-hash');
 }
 assert.deepEqual(f.calls, ['CDN', 'CDN', 'ORIGIN']);
});

test('UPYUN objects without an expected digest always use authenticated origin', async t => {
 const f = await fixture(t, 'good');
 const object = await f.service.readVerified(f.config, 'p/object', payload.length);
 try { assert.deepEqual(await readFile(object.path), payload); assert.deepEqual(f.calls, ['ORIGIN']); }
 finally { await object.cleanup(); }
});

test('non-replica download history also retains CDN failure and origin success', async t => {
 const f = await fixture(t, 'bad-hash');
 const storage = new StorageService({ get: () => undefined }, f.db, { adapter: () => new UpyunAdapter() });
 const target = await storage.getDownloadTarget({ id: 'file', projectId: 'p', storageKey: 'p/object', mimeType: 'text/plain', originalName: 'object', size: BigInt(payload.length), checksum, cdnConfig: f.config });
 const chunks = []; for await (const chunk of target.stream) chunks.push(chunk);
 assert.deepEqual(Buffer.concat(chunks), payload);
 assert.deepEqual(target.storageSource.attempts.map(({ route, outcome }) => ({ route, outcome })), [{ route: 'CDN', outcome: 'FAILED' }, { route: 'ORIGIN', outcome: 'SELECTED' }]);
});

for (const indexed of [false, true]) {
 test(`preferred full CDN download redirects only after SHA verification (${indexed ? 'replica' : 'legacy'})`, async t => {
  const f = await fixture(t, 'good');
  const adapter = new UpyunAdapter();
  const storage = new StorageService({ get: () => undefined }, f.db, { adapter: () => adapter }, indexed ? f.service : undefined);
  const reader = indexed ? f.service : null;
  let cleaned = 0, objectPath;
  const original = ReplicaService.prototype.readVerified;
  ReplicaService.prototype.readVerified = async function (...args) {
   const object = await original.apply(this, args); objectPath = object.path;
   const cleanup = object.cleanup; object.cleanup = async () => { cleaned++; await cleanup(); };
   return object;
  };
  t.after(() => { ReplicaService.prototype.readVerified = original; });
  const target = await storage.getDownloadTarget({ id: 'file', projectId: 'p', storageKey: 'p/object', mimeType: 'text/plain', originalName: '原始 name.txt', size: BigInt(payload.length), checksum, cdnConfig: f.config }, 120, undefined, { preferRedirect: true, downloadName: '原始 name.txt' });
  assert.equal(target.type, 'redirect');
  assert.equal(new URL(target.url).searchParams.get('_upd'), '原始 name.txt');
  assert.equal(target.verified, true); assert.equal(target.checksum, checksum);
  assert.equal(target.stream, undefined); assert.equal(cleaned, 1);
  await assert.rejects(readFile(objectPath), { code: 'ENOENT' });
  assert.deepEqual(f.calls, ['CDN']);
  assert.equal(target.storageSource.attempts.at(-1).route, 'CDN');
  assert.equal(f.config.manualTrafficUsedBytes, BigInt(payload.length));
 });
}

for (const scenario of ['false', 'range', 'default', 'bad-hash', '403', 'url-error', 'url-null', 'signed', 'no-digest']) {
 test(`preferred CDN download preserves verified stream for ${scenario}`, async t => {
  const f = await fixture(t, scenario === '403' ? 403 : scenario, { secret: scenario === 'signed' ? 'test-secret' : undefined });
  const adapter = new UpyunAdapter();
  if (scenario === 'url-error') adapter.getCdnDownloadUrl = async () => { throw new Error('URL unavailable'); };
  if (scenario === 'url-null') adapter.getCdnDownloadUrl = async () => null;
  const storage = new StorageService({ get: () => undefined }, f.db, { adapter: () => adapter });
  const range = scenario === 'range' ? { start: 2, end: 7 } : undefined;
  const options = scenario === 'default' ? {} : { preferRedirect: scenario !== 'false' };
  const target = await storage.getDownloadTarget({ id: 'file', projectId: 'p', storageKey: 'p/object', mimeType: 'text/plain', originalName: 'object', size: BigInt(payload.length), checksum: scenario === 'no-digest' ? undefined : checksum, cdnConfig: f.config }, 120, range, options);
  assert.equal(target.type, 'stream'); assert.equal(target.verified, true);
  const chunks = []; for await (const chunk of target.stream) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), range ? payload.subarray(2, 8) : payload);
  assert.deepEqual(f.calls, scenario === 'signed' || scenario === 'no-digest' ? ['ORIGIN'] : scenario === 'bad-hash' || scenario === '403' ? ['CDN', 'ORIGIN'] : ['CDN']);
 });
}

test('public inline CDN redirect does not request an attachment name', async t => {
 const f = await fixture(t, 'good');
 const storage = new StorageService({ get: () => undefined }, f.db, { adapter: () => new UpyunAdapter() });
 const target = await storage.getDownloadTarget({ id: 'file', projectId: 'p', storageKey: 'p/object', mimeType: 'text/plain', originalName: 'name.txt', size: BigInt(payload.length), checksum, cdnConfig: f.config }, 120, undefined, { preferRedirect: true });
 assert.equal(target.type, 'redirect'); assert.equal(new URL(target.url).searchParams.has('_upd'), false);
});
