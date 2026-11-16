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
  let shared = null, failCloud = false, deleted = false;
  const db = {
    $queryRaw: async () => [],
    managedFile: { findUnique: async () => file, findFirst: async () => shared, delete: async () => { deleted=true; } },
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
  db.$transaction=async fn=>fn(db);
  const registry={adapter:()=>({remove:async(c,k)=>{if(failCloud&&c.id==='r2')throw Error('secret remote error');objects.delete(c.id+':'+k);},objectExists:async(c,k)=>objects.has(c.id+':'+k)})};
  const storage=new StorageService({get:()=>undefined},db,registry,undefined,{releaseDeletedObject:async()=>{}});
  const service=Object.assign(Object.create(FilesService.prototype),{prisma:db,storageService:storage,auditService:{write:async()=>{}},eventBus:{emit(){}},logger:{warn(){}}});
  return {file,objects,rows,storage,service,setShared:()=>shared={id:'other'},setFailure:v=>failCloud=v,isDeleted:()=>deleted};
}

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
