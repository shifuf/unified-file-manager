const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
require('ts-node').register({ project: path.resolve(__dirname, '../../apps/api/tsconfig.json'), transpileOnly: true });
const { FilesService } = require('../../apps/api/src/files/files.service.ts');

test('retention cleanup purges expired recycle entries, preserves future and active files, and retries failures', async () => {
  const service=Object.create(FilesService.prototype), removed=[], queries=[];
  const rows=[
    {id:'expired',status:'RECYCLED',purgeAt:new Date(0)},
    {id:'retry',status:'RECYCLED',purgeAt:new Date(0)},
    {id:'future',status:'RECYCLED',purgeAt:new Date(Date.now()+86400000)},
    {id:'active',status:'ACTIVE',purgeAt:new Date(0)},
  ];
  let fail=true;
  Object.assign(service,{
    prisma:{managedFile:{findMany:async args=>{queries.push(args);return rows.filter(row=>row.status===args.where.status&&row.purgeAt<=args.where.purgeAt.lte);}}},
    purgeFile:async(file,actor,source)=>{
      assert.equal(actor,undefined);assert.equal(source,'retention');
      if(file.id==='retry'&&fail)throw Error('provider offline');
      removed.push(file.id);rows.splice(rows.findIndex(row=>row.id===file.id),1);
    },
  });
  assert.deepEqual(await service.purgeExpiredRecycledFiles(),{scanned:2,purged:1,failed:1});
  assert.deepEqual(removed,['expired']);assert.deepEqual(rows.map(row=>row.id),['retry','future','active']);
  fail=false;
  assert.deepEqual(await service.purgeExpiredRecycledFiles(),{scanned:1,purged:1,failed:0});
  assert.deepEqual(removed,['expired','retry']);assert.deepEqual(rows.map(row=>row.id),['future','active']);
  assert.ok(queries.every(query=>query.where.status==='RECYCLED'&&query.take<=100));
});

for(const provider of ['QINIU','UPYUN','ALIYUN','S3','CLOUDFLARE_R2']) {
  test(`${provider}: recycle preserves bytes until the explicit purge action`,async()=>{
    const file={id:'file',projectId:'p',status:'ACTIVE',cdnConfig:{provider},storageKey:'own-key',currentVersion:1};
    const prisma={
      $queryRaw:async()=>[],
      managedFile:{
        findUnique:async()=>({...file}),
        updateMany:async({where,data})=>{
          if(Object.entries(where).some(([key,value])=>file[key]!==value))return {count:0};
          Object.assign(file,data);return {count:1};
        },
      },
      storageReplica:{findFirst:async()=>null},
    };
    prisma.$transaction=async callback=>callback(prisma);
    const service=Object.assign(Object.create(FilesService.prototype),{
      projectAccessService:{assertProjectAccess:async()=>{}},settingsService:{getRecycleRetentionDays:async()=>1},
      prisma,
      disableFileShareLinks:async()=>0,auditService:{write:async()=>{}},eventBus:{emit(){}},
      storageService:{remove:async()=>assert.fail('recycle must not delete bytes'),removeFileObjects:async()=>assert.fail('recycle must not delete bytes')},
    });
    await service.recycle(file.id,{id:'admin'});assert.equal(file.status,'RECYCLED');
    let confirmed=false;service.purgeFile=async()=>{confirmed=true;};
    await service.purge(file.id,{id:'admin'});assert.equal(confirmed,true);
  });
}
