const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createHash } = require('node:crypto');
const path = require('node:path');
require('ts-node').register({ project: path.resolve(__dirname, '../../apps/api/tsconfig.json'), transpileOnly: true });
const { StorageService } = require('../../apps/api/src/storage/storage.service.ts');
const hash = data => createHash('sha256').update(data).digest('hex');
const configService = { get: (_, fallback) => fallback };
const bytes = Buffer.from('replica verification bytes');
function config(id, provider, priority) {
  return { id, provider, priority, enabled: true, name: id, config: {}, projectId: null,
    autoFailover: false, createdAt: new Date(), updatedAt: new Date() };
}
function matches(row, where = {}) {
  return Object.entries(where).every(([key, value]) => {
    if (key === 'OR') return value.some(v => matches(row, v));
    if (key === 'AND') return value.every(v => matches(row, v));
    if (key === 'projectBindings') return !row.unbound;
    if (key === 'projectId_storageKey_configId') return matches(row, value);
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      if ('in' in value) return value.in.includes(row[key]);
      if ('not' in value) return row[key] !== value.not;
      if ('lte' in value) return row[key] != null && row[key] <= value.lte;
      if ('gt' in value) return row[key] > value.gt;
      return matches(row[key] || {}, value);
    }
    return row[key] === value;
  });
}
function fixture() {
  const configs = [config('local', 'LOCAL', 100), config('cloud-a', 'S3', 1), config('cloud-b', 'UPYUN', 2)];
  const records = [], objects = new Map(), uploads = [], failedUploads = new Set();
  let nextId = 1;
  const create = data => { const row = { id: String(nextId++), status: 'PENDING', attempts: 0,
    nextAttemptAt: new Date(0), leaseOwner: null, leaseUntil: null, lastError: null,
    verifiedAt: null, checksum: null, createdAt: new Date(), updatedAt: new Date(), ...data }; records.push(row); return row; };
  const replica = {
    findMany: async ({ where, take = Infinity } = {}) => records.filter(r => matches({ ...r, config: configs.find(c => c.id === r.configId) }, where)).slice(0, take).map(r => ({ ...r, config: configs.find(c => c.id === r.configId) })),
    findFirst: async ({ where } = {}) => records.find(r => matches(r, where)) || null,
    findUnique: async ({ where }) => records.find(r => matches(r, where)) || null,
    create: async ({ data }) => create(data),
    createMany: async ({ data, skipDuplicates }) => { let count = 0; for (const d of data) { if (skipDuplicates && records.some(r => matches(r, { projectId: d.projectId, storageKey: d.storageKey, configId: d.configId }))) continue; create(d); count++; } return { count }; },
    upsert: async ({ where, create: data, update }) => { const r = records.find(r => matches(r, where)); if (r) { Object.assign(r, update); return r; } return create(data); },
    update: async ({ where, data }) => { const row = records.find(r => matches(r, where)); assert.ok(row); for (const [k,v] of Object.entries(data)) row[k] = v && typeof v === 'object' && 'increment' in v ? row[k] + v.increment : v; return row; },
    updateMany: async ({ where, data }) => { const found = records.filter(r => matches(r, where)); for (const row of found) for (const [k,v] of Object.entries(data)) row[k] = v && typeof v === 'object' && 'increment' in v ? row[k] + v.increment : v; return { count: found.length }; },
    groupBy: async () => [...new Set(records.map(r => r.status))].map(status => ({ status, _count: { _all: records.filter(r => r.status === status).length } })),
  };
  const tasks=[];
  const db = { storageReplica: replica,
    cdnConfig: { findMany: async ({ where } = {}) => configs.filter(c => matches(c, where)), findFirst: async ({ where } = {}) => configs.find(c => matches(c, where)) || null },
    project: { findFirst: async () => ({ id: 'p', activeCdnConfigId: 'cloud-a', activeCdnConfig: configs[1] }), findMany: async()=>[] },
    task:{findFirst:async({where})=>tasks.find(t=>matches(t,where))||null,findUnique:async({where})=>tasks.find(t=>matches(t,where))||null, create:async({data})=>{const t={id:`task${tasks.length}`,leaseOwner:null,leaseUntil:null,createdAt:new Date(),...data};tasks.push(t);return t;},updateMany:async({where,data})=>{const found=tasks.filter(t=>matches(t,where));for(const t of found)Object.assign(t,data);return{count:found.length};}},
    $queryRaw:async()=>[],
    managedFile: { findMany: async () => [] },
    $transaction: async fn => fn(db),
  };
  const registry = { adapter: provider => ({
    upload: async (c, p) => { uploads.push(c.id); if (failedUploads.has(c.id)) throw new Error('network unavailable'); objects.set(`${c.id}:${p.key}`, Buffer.from(p.buffer)); return { storageKey: p.key, publicUrl: 'https://cloud.invalid/secret' }; },
    getDownloadTarget: async (c, key) => { const data = objects.get(`${c.id}:${key}`); if (!data) throw new Error('object missing'); return { type: 'stream', stream: Readable.from([data]), contentLength: data.length }; },
    getDownloadUrl: async (c, key) => `https://cloud.invalid/${c.id}/${key}`,
    createDirectUpload: async () => ({ provider, uploadUrl: 'https://cloud.invalid/upload' }),
  }) };
  const service = new StorageService(configService, db, registry);
  return { configs, records, objects, uploads, failedUploads, db, registry, service, tasks };
}
async function collect(target) { assert.equal(target.type, 'stream'); const chunks = []; for await (const c of target.stream) chunks.push(Buffer.from(c)); return Buffer.concat(chunks); }
function replicas(f) { const { ReplicaService } = require('../../apps/api/src/storage/replica.service.ts'); return new ReplicaService(configService, f.db, f.registry); }
function row(f, configId, status = 'READY', key = 'p/object') { const r = { id: `r${f.records.length}`, projectId: 'p', configId, storageKey: key, size: BigInt(bytes.length), checksum: hash(bytes), status, attempts: 0, nextAttemptAt: new Date(0), leaseOwner: null, leaseUntil: null, verifiedAt: null }; f.records.push(r); return r; }

test('normal upload first writes LOCAL and never gives the browser a cloud URL', async () => {
  const f = fixture();
  const result = await f.service.upload('p', { key: 'p/object', buffer: bytes, mimeType: 'text/plain', originalName: 'object' });
  assert.equal(result.cdnConfigId, 'local');
  assert.equal(result.publicUrl, null);
  assert.deepEqual(f.objects.get('local:p/object'), bytes);
});
test('direct cloud credentials are disabled so uploads cannot bypass the safety copy', async () => {
  const f = fixture(); assert.equal(await f.service.createDirectUploadCredential('p', { fileName: 'object', mimeType: 'text/plain', size: bytes.length }), null);
});
test('durable upload records a verified local replica and enqueues every assigned enabled cloud', async () => {
  const f = fixture(); f.configs.push({ ...config('disabled', 'S3', 0), enabled: false }, { ...config('unbound', 'S3', 0), unbound: true });
  const service = new StorageService(configService, f.db, f.registry, replicas(f));
  await service.upload('p', { key: 'p/object', buffer: bytes, mimeType: 'text/plain', originalName: 'object' });
  assert.deepEqual(f.records.map(r => [r.configId, r.status]).sort(), [['cloud-a','PENDING'],['cloud-b','PENDING'],['local','READY']]);
  assert.ok(f.records.every(r => r.checksum === hash(bytes) && r.size === BigInt(bytes.length)));
  assert.deepEqual(f.uploads, ['local']);
});
test('worker verifies both target bytes and hash before declaring READY', async () => {
  const f = fixture(), service = replicas(f); f.objects.set('local:p/object', bytes);
  row(f, 'local'); const target = row(f, 'cloud-a', 'PENDING');
  await service.runBatch('worker-a', 1);
  assert.equal(target.status, 'READY'); assert.ok(target.verifiedAt); assert.equal(target.leaseOwner, null);
  assert.deepEqual(f.objects.get('cloud-a:p/object'), bytes);
});
test('worker rejects same-size corrupted remote content rather than accepting HEAD existence', async () => {
  const f = fixture(), service = replicas(f); f.objects.set('local:p/object', bytes); row(f, 'local'); const target = row(f, 'cloud-a', 'PENDING');
  const base = f.registry.adapter; f.registry.adapter = p => { const a = base(p); if (p === 'S3') a.upload = async (c, params) => { f.objects.set(`${c.id}:${params.key}`, Buffer.alloc(bytes.length)); return { storageKey: params.key }; }; return a; };
  await service.runBatch('worker-a', 1);
  assert.equal(target.status, 'FAILED'); assert.ok(target.lastError); assert.equal(target.verifiedAt, null);
  assert.ok(target.nextAttemptAt > new Date());
});
test('failed uploads retry with backoff while unrelated cloud copies complete', async () => {
  const f = fixture(), service = replicas(f); f.objects.set('local:p/object', bytes); row(f,'local'); const a = row(f,'cloud-a','PENDING'), b = row(f,'cloud-b','PENDING'); f.failedUploads.add('cloud-a');
  await service.runBatch('worker-a', 10);
  assert.equal(a.status,'FAILED'); assert.equal(a.attempts,1); assert.equal(b.status,'READY');
  const uploads = f.uploads.length; await service.runBatch('worker-a',10); assert.equal(f.uploads.length,uploads);
  f.failedUploads.clear(); a.nextAttemptAt = new Date(0); await service.runBatch('worker-b',10); assert.equal(a.status,'READY');
});
test('expired leases can be resumed after worker restart without stealing an unexpired lease', async () => {
  const f = fixture(), service = replicas(f); f.objects.set('local:p/object',bytes); row(f,'local'); const a = row(f,'cloud-a','PENDING'), b = row(f,'cloud-b','PENDING');
  a.leaseOwner='dead'; a.leaseUntil=new Date(0); b.leaseOwner='alive'; b.leaseUntil=new Date(Date.now()+60000);
  await service.runBatch('replacement',10); assert.equal(a.status,'READY'); assert.equal(b.status,'PENDING'); assert.equal(b.leaseOwner,'alive');
});
test('download prefers ready cloud priority and returns only verified proxy bytes', async () => {
  const f = fixture(), service = replicas(f); for (const id of ['local','cloud-a','cloud-b']) { row(f,id); f.objects.set(`${id}:p/object`,bytes); }
  f.objects.set('cloud-a:p/object',Buffer.alloc(bytes.length));
  const target = await service.getDownloadTargetForKey({ id:'f',projectId:'p',storageKey:'p/object',size:BigInt(bytes.length),mimeType:'text/plain',originalName:'object',cdnConfig:f.configs[0] },'p/object');
  assert.deepEqual(await collect(target),bytes); assert.equal(f.records.find(r=>r.configId==='cloud-a').status,'FAILED');
});
test('both unavailable clouds fall back to verified LOCAL including exact range', async () => {
  const f = fixture(), service = replicas(f); for(const id of ['local','cloud-a','cloud-b']) row(f,id); f.objects.set('local:p/object',bytes);
  const file={id:'f',projectId:'p',storageKey:'p/object',size:BigInt(bytes.length),mimeType:'text/plain',originalName:'object',cdnConfig:f.configs[0]};
  assert.deepEqual(await collect(await service.getDownloadTargetForKey(file,'p/object',{start:3,end:8})),bytes.subarray(3,9));
});
test('missing or corrupt copies return 404 without a successful empty stream', async () => {
  const f = fixture(), service = replicas(f); row(f,'local');
  await assert.rejects(service.getDownloadTargetForKey({id:'f',projectId:'p',storageKey:'p/object',size:BigInt(bytes.length),mimeType:'text/plain',originalName:'object',cdnConfig:f.configs[0]},'p/object'),e=>e.getStatus()===404);
});
test('historical and derivative keys are validated against their replica metadata, not current file size', async () => {
  const f=fixture(), service=replicas(f); const old=Buffer.from('old'); const r=row(f,'local','READY','p/history'); r.size=3n; r.checksum=hash(old); f.objects.set('local:p/history',old);
  const file={id:'f',projectId:'p',storageKey:'p/object',size:BigInt(bytes.length),mimeType:'text/plain',originalName:'object',cdnConfig:f.configs[0]};
  assert.deepEqual(await collect(await service.getDownloadTargetForKey(file,'p/history')),old);
});
test('same immutable key cannot silently replace a previously verified object with other bytes', async () => {
  const f=fixture(), service=replicas(f); row(f,'local');
  await assert.rejects(service.recordLocalAndEnqueue('p','local','p/object',BigInt(bytes.length),'different-checksum'),/不可变|冲突/);
});
test('StorageService delegates arbitrary derivative keys to the replica selector', async () => {
  const f=fixture(), service=new StorageService(configService,f.db,f.registry,replicas(f));
  const r=row(f,'local','READY','p/derivative'); const small=Buffer.from('tiny'); r.size=4n; r.checksum=hash(small); f.objects.set('local:p/derivative',small);
  const file={id:'f',projectId:'p',storageKey:'p/object',size:BigInt(bytes.length),mimeType:'text/plain',originalName:'object',cdnConfig:f.configs[1]};
  assert.deepEqual(await collect(await service.getDownloadTargetForKey(file,'p/derivative')),small);
  f.objects.set('local:p/object',bytes); row(f,'local'); assert.deepEqual(await collect(await service.getDownloadTarget(file)),bytes);
});
test('LOCAL lookup assigns the enabled global safety store when the legacy project bound only clouds', async () => {
  const f=fixture(); f.configs[0].unbound=true;
  f.db.projectStorageBinding={upsert:async({create})=>{const local=f.configs.find(c=>c.id===create.configId); local.unbound=false; return create;}};
  await f.service.upload('p',{key:'p/object',buffer:bytes,mimeType:'text/plain',originalName:'object'});
  assert.equal(f.configs[0].unbound,false); assert.deepEqual(f.objects.get('local:p/object'),bytes);
});
test('materializing a historical direct cloud upload verifies its content before saving and indexing LOCAL', async()=>{
  const f=fixture(),service=replicas(f); f.objects.set('cloud-a:p/direct',bytes);
  const result=await service.materializeUploadedObject('p','cloud-a','p/direct',BigInt(bytes.length),hash(bytes),'text/plain','direct');
  assert.equal(result.cdnConfigId,'local'); assert.equal(result.publicUrl,null); assert.deepEqual(f.objects.get('local:p/direct'),bytes);
  assert.equal(f.records.find(r=>r.configId==='local').status,'READY');
});
test('direct cloud import rejects truncated bytes without registering a ready safety copy', async()=>{
  const f=fixture(),service=replicas(f); f.objects.set('cloud-a:p/direct',Buffer.from('short'));
  await assert.rejects(service.materializeUploadedObject('p','cloud-a','p/direct',BigInt(bytes.length),hash(bytes),'text/plain','direct'));
  assert.equal(f.records.length,0); assert.equal(f.objects.has('local:p/direct'),false);
});
test('sync discovers file history and creates missing replicas even after a new binding',async()=>{
  const f=fixture(),service=replicas(f); f.objects.set('local:p/object',bytes); row(f,'local');
  f.db.managedFile.findMany=async()=>[{id:'f',storageKey:'p/object',size:BigInt(bytes.length),checksum:hash(bytes),cdnConfigId:'local',versions:[{storageKey:'p/history',size:3n,checksum:hash(Buffer.from('old')),cdnConfigId:'local'}],derivatives:[]}];
  const result=await service.ensureProjectReplicas('p'); assert.equal(result.scanned,1);
  assert.deepEqual(f.records.filter(r=>r.storageKey==='p/history').map(r=>r.configId).sort(),['cloud-a','cloud-b','local']);
  assert.equal(f.records.filter(r=>r.storageKey==='p/object').length,3);
  await service.ensureProjectReplicas('p'); assert.equal(f.records.length,6);
});
test('status API returns project replica counts and excludes configuration credentials',async()=>{
  const f=fixture(),service=replicas(f); row(f,'local'); row(f,'cloud-a','FAILED'); f.configs[1].config={secretKey:'hidden'};
  const result=await service.listProject('p'); assert.equal(result.counts.READY,1); assert.equal(result.counts.FAILED,1);
  assert.equal(result.items[0].size,String(bytes.length)); assert.equal(JSON.stringify(result).includes('hidden'),false);
});
test('manual retry requeues failures without disturbing a running unexpired lease',async()=>{
  const f=fixture(),service=replicas(f); const a=row(f,'cloud-a','FAILED'),b=row(f,'cloud-b','FAILED'); b.leaseOwner='running'; b.leaseUntil=new Date(Date.now()+60000);
  assert.equal((await service.retryProject('p')).queued,1); assert.equal(a.status,'PENDING'); assert.equal(b.status,'FAILED'); assert.equal(b.leaseOwner,'running');
});
test('inspect invalidates corrupt objects and keeps verified objects ready',async()=>{
  const f=fixture(),service=replicas(f); row(f,'local'); row(f,'cloud-a'); f.objects.set('local:p/object',bytes); f.objects.set('cloud-a:p/object',Buffer.alloc(bytes.length));
  const result=await service.inspectProject('p'); assert.equal(result.ready,1); assert.equal(result.failed,1); assert.equal(f.records[1].status,'FAILED');
});
test('a verified legacy read backfills LOCAL and enqueues all clouds',async()=>{
  const f=fixture(),service=replicas(f); f.objects.set('cloud-a:p/object',bytes);
  const file={id:'f',projectId:'p',storageKey:'p/object',size:BigInt(bytes.length),checksum:hash(bytes),mimeType:'text/plain',originalName:'object',cdnConfig:f.configs[1]};
  assert.deepEqual(await collect(await service.getDownloadTargetForKey(file,'p/object')),bytes); assert.deepEqual(f.objects.get('local:p/object'),bytes);
  assert.equal(f.records.length,3);
});
test('sync persists its cursor and a replacement worker resumes the remaining files',async()=>{
 const f=fixture(),service=replicas(f);
 const files=Array.from({length:23},(_,i)=>({id:`f${String(i).padStart(3,'0')}`,storageKey:`p/file${i}`,size:1n,checksum:null,cdnConfigId:'local',versions:[],derivatives:[]}));
 f.db.managedFile.findMany=async({where,take})=>files.filter(f=>!where.id||f.id>where.id.gt).slice(0,take);
 const result=await service.enqueueProject('p'); assert.ok(result.taskId); assert.equal(f.tasks.length,1);
 await service.processSyncBatch('original'); assert.equal(f.tasks[0].status,'RUNNING'); assert.equal(f.tasks[0].detail.scanned,20);
 f.tasks[0].leaseOwner='dead'; f.tasks[0].leaseUntil=new Date(0);
 await replicas(f).processSyncBatch('replacement'); assert.equal(f.tasks[0].status,'COMPLETED'); assert.equal(f.tasks[0].detail.scanned,23); assert.equal(f.records.length,69);
});
test('background worker refuses overlapping runs so one process cannot duplicate an upload',async()=>{
 const f=fixture(),service=replicas(f); f.objects.set('local:p/object',bytes); row(f,'local'); const target=row(f,'cloud-a','PENDING');
 let release,started;const gate=new Promise(r=>release=r),start=new Promise(r=>started=r);const base=f.registry.adapter;
 f.registry.adapter=p=>{const a=base(p);if(p==='S3'){const upload=a.upload;a.upload=async(c,p)=>{started();await gate;return upload(c,p);};}return a;};
 const {ReplicaWorker}=require('../../apps/api/src/storage/replica.worker.ts');const worker=new ReplicaWorker(configService,f.db,service);
 const running=worker.runOnce();await start;await worker.runOnce();release();await running;
 assert.equal(target.attempts,1);assert.equal(target.status,'READY');worker.onModuleDestroy();
});
test('replica management endpoints enforce SUPER_ADMIN and enabled project access before changes',async()=>{
 const f=fixture(),service=replicas(f),{ProjectAccessService}=require('../../apps/api/src/projects/project-access.service.ts');
 const {ReplicaController}=require('../../apps/api/src/storage/replica.controller.ts');const controller=new ReplicaController(new ProjectAccessService(f.db),service);
 await assert.rejects(controller.sync('p',{}, {id:'user',role:'USER'}),e=>e.getStatus()===403);assert.equal(f.records.length,0);assert.equal(f.tasks.length,0);
 f.db.project.findFirst=async()=>null;await assert.rejects(controller.retry('p',{id:'admin',role:'SUPER_ADMIN'}),e=>e.getStatus()===404);
});
test('ready clouds at known space or traffic thresholds are skipped while unknown usage remains eligible',async()=>{
 const f=fixture(),service=replicas(f); for(const id of ['local','cloud-a','cloud-b']){row(f,id);f.objects.set(`${id}:p/object`,bytes);}
 Object.assign(f.configs[1],{storageQuotaBytes:100n,manualStorageUsedBytes:95n,failoverThresholdPercent:90});
 const accessed=[];const base=f.registry.adapter;f.registry.adapter=p=>{const a=base(p),read=a.getDownloadTarget;a.getDownloadTarget=async(c,k)=>{accessed.push(c.id);return read(c,k);};return a;};
 const file={id:'f',projectId:'p',storageKey:'p/object',size:BigInt(bytes.length),mimeType:'text/plain',originalName:'object',cdnConfig:f.configs[0]};
 assert.deepEqual(await collect(await service.getDownloadTargetForKey(file,'p/object')),bytes);assert.deepEqual(accessed,['cloud-b']);
 Object.assign(f.configs[2],{trafficQuotaBytes:100n,manualTrafficUsedBytes:95n,failoverThresholdPercent:90});accessed.length=0;
 assert.deepEqual(await collect(await service.getDownloadTargetForKey(file,'p/object')),bytes);assert.deepEqual(accessed,['local']);
});
test('worker delays known exhausted clouds while continuing other replica uploads',async()=>{
 const f=fixture(),service=replicas(f);f.objects.set('local:p/object',bytes);row(f,'local');const a=row(f,'cloud-a','PENDING'),b=row(f,'cloud-b','PENDING');
 Object.assign(f.configs[1],{storageQuotaBytes:100n,manualStorageUsedBytes:95n,failoverThresholdPercent:90});
 await service.runBatch('worker',10);assert.equal(a.status,'FAILED');assert.ok(a.nextAttemptAt>new Date());assert.equal(b.status,'READY');assert.deepEqual(f.uploads,['cloud-b']);
});
test('HLS backfill uses each indexed object actual size rather than the aggregate derivative size',async()=>{
 const f=fixture(),service=replicas(f),data=Buffer.from('hls'); const master=row(f,'local','READY','p/hls/master.m3u8');master.size=3n;master.checksum=hash(data);
 f.db.managedFile.findMany=async()=>[{id:'f',storageKey:'p/object',size:BigInt(bytes.length),checksum:hash(bytes),cdnConfigId:'local',versions:[],derivatives:[{kind:'HLS',storageKey:'p/hls/master.m3u8',size:999n,status:'READY',mimeType:'application/vnd.apple.mpegurl',meta:{segmentPrefix:'p/hls',files:['720/index.m3u8','720/segment.ts']}}]}];
 f.objects.set('local:p/hls/720/index.m3u8',Buffer.from('playlist')); f.objects.set('local:p/hls/720/segment.ts',Buffer.from('segment'));
 await service.ensureProjectReplicas('p');assert.equal(f.records.find(r=>r.configId==='cloud-a'&&r.storageKey==='p/hls/master.m3u8').size,3n);
 assert.equal(f.records.find(r=>r.configId==='cloud-a'&&r.storageKey==='p/hls/720/segment.ts').size,7n);
});
test('a checksum-less backfill cannot trust a same-size target before comparing against its source',async()=>{
 const f=fixture(),service=replicas(f);row(f,'local');f.objects.set('local:p/object',bytes);const target=row(f,'cloud-a','PENDING');target.checksum=null;f.objects.set('cloud-a:p/object',Buffer.alloc(bytes.length));
 await service.runBatch('worker',1);assert.equal(target.status,'READY');assert.equal(target.checksum,hash(bytes));assert.deepEqual(f.objects.get('cloud-a:p/object'),bytes);
});
test('ready clouds detached from a project are skipped without hiding its disabled LOCAL safety copy',async()=>{
 const f=fixture(),service=replicas(f);for(const id of ['local','cloud-a']){row(f,id);f.objects.set(`${id}:p/object`,bytes);}f.configs[1].unbound=true;f.configs[0].enabled=false;f.configs[0].unbound=true;
 const accessed=[];const base=f.registry.adapter;f.registry.adapter=p=>{const a=base(p),read=a.getDownloadTarget;a.getDownloadTarget=async(c,k)=>{accessed.push(c.id);return read(c,k);};return a;};
 const file={id:'f',projectId:'p',storageKey:'p/object',size:BigInt(bytes.length),mimeType:'text/plain',originalName:'object',cdnConfig:f.configs[0]};
 assert.deepEqual(await collect(await service.getDownloadTargetForKey(file,'p/object')),bytes);assert.deepEqual(accessed,['local']);
});
test('upload validates actual LOCAL bytes before registering READY',async()=>{
 const f=fixture(),service=new StorageService(configService,f.db,f.registry,replicas(f)),base=f.registry.adapter;
 f.registry.adapter=p=>{const a=base(p),upload=a.upload;if(p==='LOCAL')a.upload=async(c,p)=>{const result=await upload(c,p);f.objects.set(`${c.id}:${p.key}`,Buffer.alloc(bytes.length));return result;};return a;};
 await assert.rejects(service.upload('p',{key:'p/object',buffer:bytes,mimeType:'text/plain',originalName:'object'}),/SHA256/);assert.equal(f.records.length,0);
});
test('a newly bound cloud forces a persisted rescan of files already passed by a running sync cursor',async()=>{
 const f=fixture(),service=replicas(f);const files=Array.from({length:23},(_,i)=>({id:`f${String(i).padStart(3,'0')}`,storageKey:`p/file${i}`,size:1n,checksum:null,cdnConfigId:'local',versions:[],derivatives:[]}));
 f.db.managedFile.findMany=async({where,take})=>files.filter(f=>!where.id||f.id>where.id.gt).slice(0,take);
 const started=await service.enqueueProject('p');await service.processSyncBatch('worker');assert.equal(f.tasks[0].detail.scanned,20);
 f.configs.push(config('new-cloud','S3',3));const resumed=await service.enqueueProject('p');assert.equal(resumed.taskId,started.taskId);assert.equal(f.tasks.length,1);
 await service.processSyncBatch('worker');assert.equal(f.tasks[0].status,'RUNNING','the final page must retain the rescan request');
 await replicas(f).processSyncBatch('after-restart');await replicas(f).processSyncBatch('after-restart');
 assert.equal(f.tasks[0].status,'COMPLETED');assert.equal(f.records.filter(r=>r.configId==='new-cloud').length,23);
});
test('concurrent workers claim one object only once across separate service instances',async()=>{
 const f=fixture();f.objects.set('local:p/object',bytes);row(f,'local');const target=row(f,'cloud-a','PENDING');
 await Promise.all([replicas(f).runBatch('worker-a',10),replicas(f).runBatch('worker-b',10)]);
 assert.equal(target.attempts,1);assert.equal(target.status,'READY');assert.deepEqual(f.uploads,['cloud-a']);
});
test('a worker that loses its lease cannot publish READY and its successor verifies existing bytes',async()=>{
 const f=fixture(),service=replicas(f);f.objects.set('local:p/object',bytes);row(f,'local');const target=row(f,'cloud-a','PENDING');
 const base=f.registry.adapter;f.registry.adapter=p=>{const a=base(p),upload=a.upload;if(p==='S3')a.upload=async(c,p)=>{const result=await upload(c,p);target.leaseOwner='replacement';target.leaseUntil=new Date(Date.now()+60000);return result;};return a;};
 await service.runBatch('stale-worker',10);assert.equal(target.status,'PENDING');assert.equal(target.verifiedAt,null);
 await replicas(f).runBatch('replacement',10);assert.equal(target.status,'READY');assert.deepEqual(f.uploads,['cloud-a']);
});
test('large background replication uploads a disk stream instead of materializing a whole-file buffer',async()=>{
 const f=fixture(),service=replicas(f),chunk=Buffer.alloc(1024*1024,97),blocks=48,total=blocks*chunk.length;
 const h=createHash('sha256');for(let i=0;i<blocks;i++)h.update(chunk);const checksum=h.digest('hex');
 const local=row(f,'local'),target=row(f,'cloud-a','PENDING');for(const r of [local,target]){r.size=BigInt(total);r.checksum=checksum;}
 let remote=false,uploads=0;
 f.registry.adapter=p=>({upload:async()=>{throw new Error('whole-buffer upload must not be used');},
  uploadFile:async(c,params)=>{uploads++;const hash=createHash('sha256');let size=0;for await(const b of require('node:fs').createReadStream(params.path)){size+=b.length;hash.update(b);}assert.equal(size,total);assert.equal(hash.digest('hex'),checksum);remote=true;return{storageKey:params.key};},
  getDownloadTarget:async(c)=>{if(c.provider!=='LOCAL'&&!remote)throw new Error('missing');return{type:'stream',stream:Readable.from((function*(){for(let i=0;i<blocks;i++)yield chunk;})()),contentLength:total};}});
 await service.runBatch('worker',1);assert.equal(target.status,'READY');assert.equal(uploads,1);
});
test('provider errors never persist signed URLs or credentials even when their text includes SHA256',async()=>{
 const f=fixture(),service=replicas(f);row(f,'local');f.objects.set('local:p/object',bytes);const target=row(f,'cloud-a','PENDING'),base=f.registry.adapter;
 f.registry.adapter=p=>{const a=base(p);if(p==='S3')a.upload=async()=>{throw new Error('SHA256 signing mismatch https://cloud.invalid/object?token=secret');};return a;};
 await service.runBatch('worker',1);assert.equal(target.status,'FAILED');assert.equal(target.lastError.includes('token='),false);assert.equal(target.lastError.includes('https://'),false);
});
test('queued replicas stop writing to a cloud once its project binding is removed',async()=>{
 const f=fixture(),service=replicas(f);row(f,'local');f.objects.set('local:p/object',bytes);row(f,'cloud-a','PENDING');f.configs[1].unbound=true;
 await service.runBatch('worker',10);assert.deepEqual(f.uploads,[]);assert.equal(f.objects.has('cloud-a:p/object'),false);assert.equal(f.records[1].status,'SKIPPED');
 f.configs[1].unbound=false;await service.ensureProjectReplicas('p');assert.equal(f.records[1].status,'PENDING');await service.runBatch('worker',10);assert.equal(f.records[1].status,'READY');
});
test('a legacy object remains downloadable while its backfill replicas are still pending',async()=>{
 const f=fixture(),service=replicas(f);for(const id of ['local','cloud-a','cloud-b'])row(f,id,'PENDING');f.objects.set('cloud-a:p/object',bytes);
 const file={id:'f',projectId:'p',storageKey:'p/object',size:BigInt(bytes.length),checksum:hash(bytes),mimeType:'text/plain',originalName:'object',cdnConfig:f.configs[1]};
 assert.deepEqual(await collect(await service.getDownloadTargetForKey(file,'p/object')),bytes);assert.deepEqual(f.objects.get('local:p/object'),bytes);
});
test('inspect compares checksum-less cloud objects against verified LOCAL source instead of trusting target digest',async()=>{
 const f=fixture(),service=replicas(f);row(f,'local');f.objects.set('local:p/object',bytes);const cloud=row(f,'cloud-a','PENDING');cloud.checksum=null;f.objects.set('cloud-a:p/object',Buffer.alloc(bytes.length));
 const result=await service.inspectProject('p');assert.equal(result.failed,1);assert.equal(cloud.status,'FAILED');assert.equal(cloud.verifiedAt,null);
});
test('inspect cannot certify a checksum-less cloud object when no independent source is readable',async()=>{
 const f=fixture(),service=replicas(f),cloud=row(f,'cloud-a','PENDING');cloud.checksum=null;f.objects.set('cloud-a:p/object',bytes);
 const result=await service.inspectProject('p');assert.equal(result.ready,0);assert.notEqual(cloud.status,'READY');assert.equal(cloud.verifiedAt,null);
});
test('inspection marks corrupted LOCAL failed and the worker safely restores it from a verified independent cloud',async()=>{
 const fsp=require('node:fs/promises'),{tmpdir}=require('node:os'),{LocalStorageAdapter}=require('../../apps/api/src/storage/adapters/local.adapter.ts');
 const f=fixture(),service=replicas(f),dir=await fsp.mkdtemp(path.join(tmpdir(),'ufm-repair-worker-test-')),localAdapter=new LocalStorageAdapter(),base=f.registry.adapter;
 f.configs[0].config={root:dir};f.registry.adapter=p=>p==='LOCAL'?localAdapter:base(p);const local=row(f,'local');row(f,'cloud-a');f.objects.set('cloud-a:p/object',bytes);
 try{
  await fsp.mkdir(path.join(dir,'p'));await fsp.writeFile(path.join(dir,'p/object'),Buffer.alloc(bytes.length));
  const inspection=await service.inspectProject('p');assert.equal(inspection.failed,1);assert.equal(local.status,'FAILED');local.nextAttemptAt=new Date(0);
  await service.runBatch('repair-worker',10);assert.equal(local.status,'READY');assert.equal(local.checksum,hash(bytes));assert.ok(local.verifiedAt);assert.deepEqual(await fsp.readFile(path.join(dir,'p/object')),bytes);
 }finally{await fsp.rm(dir,{recursive:true,force:true});}
});
test('enqueueProject can durably create the scan inside an existing binding transaction without nesting transactions',async()=>{
 const f=fixture(),service=replicas(f);f.db.$transaction=async()=>{throw new Error('nested transaction');};
 const result=await service.enqueueProject('p','',f.db);assert.equal(result.taskId,'task0');assert.equal(f.tasks[0].status,'RUNNING');
});
