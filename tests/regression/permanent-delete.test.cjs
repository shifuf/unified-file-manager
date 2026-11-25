const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
require('ts-node').register({ project: path.resolve(__dirname, '../../apps/api/tsconfig.json'), transpileOnly: true });
const { StorageService } = require('../../apps/api/src/storage/storage.service.ts');
const { FilesService } = require('../../apps/api/src/files/files.service.ts');

function fixture(provider = 'CLOUDFLARE_R2') {
  const local = { id: 'local', provider: 'LOCAL', config: {} }, cloud = { id: 'r2', provider, config: {} };
  const file = { id: 'f', projectId: 'p', status: 'RECYCLED', storageKey: 'p/current', cdnConfigId: local.id, cdnConfig: local,
    versions: [{ storageKey: 'p/old', cdnConfigId: local.id, cdnConfig: local }],
    derivatives: [{ kind: 'HLS', storageKey: 'p/hls/index.m3u8', meta: { segmentPrefix: 'p/hls', files: ['part.ts'] } }] };
  const keys = ['p/current', 'p/old', 'p/hls/index.m3u8', 'p/hls/part.ts'];
  const objects = new Set(keys.flatMap(k => ['local:'+k, 'r2:'+k]));
  const rows = keys.flatMap(storageKey => [local, cloud].map(config => ({ id: config.id+storageKey, projectId:'p', storageKey, configId:config.id, config, status:'READY', leaseOwner:null, leaseUntil:null })));
  let shared = null, failCloud = false, deleted = false, releaseRemove, removeStarted, removeGate, transactionDepth = 0;
  const db = {
    $queryRaw: async () => [],
    managedFile: { findUnique: async () => file, findFirst: async () => shared, updateMany: async ({where,data}) => { if(file.storageKey !== where.storageKey || file.status !== where.status) return {count:0}; Object.assign(file,data); return {count:1}; }, delete: async () => { deleted=true; }, deleteMany:async({where})=>{if(file.storageKey!==where.storageKey||file.currentVersion!==where.currentVersion||file.status!==where.status)return {count:0};deleted=true;return {count:1};} },
    fileVersion: { findFirst: async () => null }, fileDerivative: { findFirst: async () => null },
    storageReplica: {
      createMany: async () => ({count:0}),
      findMany: async () => rows,
      updateMany: async ({data}) => { rows.forEach(r=>Object.assign(r,data)); return {count:rows.length}; },
      deleteMany: async () => {rows.length=0;return {count:8};},
      findFirst: async () => rows.find(r=>r.status==='DELETING') || null,
    },
    cdnConfig: { findMany: async () => [local, cloud] }, shareLink: {count:async()=>0},
  };
  db.$transaction=async fn=>{transactionDepth++;try{return await fn(db);}finally{transactionDepth--;}};
  const registry={adapter:()=>({remove:async(c,k)=>{assert.equal(transactionDepth,0,'provider network must run outside DB locks');if(removeGate && c.id==='r2'){const gate=removeGate;removeGate=null;removeStarted();await gate;} if(failCloud&&c.id==='r2')throw Error('secret remote error');objects.delete(c.id+':'+k);},objectExists:async(c,k)=>objects.has(c.id+':'+k)})};
  const storage=new StorageService({get:()=>undefined},db,registry,undefined,{releaseDeletedObject:async()=>{}});
  const service=Object.assign(Object.create(FilesService.prototype),{prisma:db,storageService:storage,auditService:{write:async()=>{}},eventBus:{emit(){}},logger:{warn(){}}});
  return {file,objects,rows,storage,service,setShared:()=>shared={id:'other'},setFailure:v=>failCloud=v,isDeleted:()=>deleted,
    pauseRemove:()=>{removeGate=new Promise(resolve=>releaseRemove=resolve);return new Promise(resolve=>removeStarted=resolve);},resumeRemove:()=>releaseRemove?.()};
}

test('DAV deletion freezes the captured file HEAD until removal completes', async()=>{
 const f=fixture(); f.file.status='ACTIVE'; const started=f.pauseRemove(); const removing=f.storage.deleteDavFile('f');
 await started;
 assert.equal(f.file.status,'RECYCLED');
 await assert.rejects(f.service.updateRevisionIfCurrent({id:'f',projectId:'p',storageKey:'p/current',currentVersion:1,status:'ACTIVE'},
   {storageKey:'p/new',currentVersion:2},'ACTIVE'), e=>e.getStatus?.()===409);
 f.resumeRemove(); await removing; assert.equal(f.isDeleted(),true);
});

test('failed DAV deletion remains visible in recycle and every restore channel rejects it until deletion retry succeeds', async()=>{
 const f=fixture();f.file.status='ACTIVE';f.setFailure(true);
 await assert.rejects(f.storage.deleteDavFile('f'),/重试/);
 assert.equal(f.file.status,'RECYCLED');assert.equal(f.file.purgeAt.getTime(),0);
 f.service.findFileForUser=async()=>({...f.file});f.service.findFileForProject=async()=>({...f.file});
 f.service.findFilesForUser=async()=>[{...f.file}];f.service.findFilesForProject=async()=>[{...f.file}];
 for (const restore of [()=>f.service.restore('f',{id:'u'}),()=>f.service.restoreForProject('f','p'),
  ()=>f.service.batchRestore({fileIds:['f']},{id:'u'}),()=>f.service.batchRestoreForProject(['f'],'p')]) {
  await assert.rejects(restore(),e=>e.getStatus?.()===409);
  assert.equal(f.file.status,'RECYCLED');
 }
 await assert.rejects(f.storage.getDownloadTarget(f.file),e=>e.getStatus?.()===409);
 f.setFailure(false);await f.storage.deleteDavFile('f');assert.equal(f.isDeleted(),true);assert.equal(f.objects.size,0);
});

test('whole-file freeze blocks publishing even when all object keys are shared and no DELETING replica exists', async()=>{
 const f=fixture();f.setShared();const before={...f.file};await f.storage.removeFileObjects('f');
 f.rows.length=0;
 await assert.rejects(f.service.updateRevisionIfCurrent(before,{storageKey:'p/new',currentVersion:2}),e=>e.getStatus?.()===409);
 assert.equal(f.file.storageKey,'p/current');assert.equal(f.objects.size,8);
});

test('deletion finalization refuses to remove a different HEAD after provider calls finish', async()=>{
 const f=fixture();f.file.status='ACTIVE';f.file.currentVersion=1;
 const started=f.pauseRemove(),removing=f.storage.deleteDavFile('f');
 const rejected=assert.rejects(removing,e=>e.getStatus?.()===409);await started;
 f.file.storageKey='p/new';f.file.currentVersion=2;f.objects.add('local:p/new');
 f.resumeRemove();await rejected;assert.equal(f.isDeleted(),false);assert(f.objects.has('local:p/new'));
});

for (const provider of ['QINIU','UPYUN','ALIYUN','S3','CLOUDFLARE_R2']) test(`${provider} permanent deletion removes original, cloud replicas, versions and HLS segments`,async()=>{
  const f=fixture(provider);await f.service.purgeFile(f.file);assert.equal(f.objects.size,0);assert.equal(f.rows.length,0);assert.equal(f.isDeleted(),true);
});
test('provider failure retains metadata and blocked replicas for an idempotent retry',async()=>{
  const f=fixture();f.setFailure(true);await assert.rejects(f.service.purgeFile(f.file),/存储.*重试/);
  assert.equal(f.isDeleted(),false);assert(f.rows.every(r=>r.status==='DELETING'));assert(f.objects.has('r2:p/current'));
  f.setFailure(false);await f.service.purgeFile(f.file);assert.equal(f.objects.size,0);assert.equal(f.isDeleted(),true);
});
test('permanent deletion retains objects referenced by another file',async()=>{
  const f=fixture();f.setShared();await f.service.purgeFile(f.file);assert.equal(f.objects.size,8);assert.equal(f.isDeleted(),true);
});
test('active replica upload blocks physical deletion until its lease finishes',async()=>{
  const f=fixture();f.rows[1].leaseOwner='worker';f.rows[1].leaseUntil=new Date(Date.now()+60000);
  await assert.rejects(f.service.purgeFile(f.file),/同步.*重试/);assert.equal(f.objects.size,8);assert.equal(f.isDeleted(),false);
});
