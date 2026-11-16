const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
require('ts-node').register({ project: path.resolve(__dirname, '../../apps/api/tsconfig.json'), transpileOnly: true });
const { FilesService } = require('../../apps/api/src/files/files.service.ts');

test('expired recycle entries cannot be physically purged without confirmation', async () => {
  const service=Object.create(FilesService.prototype);let removed=0;
  Object.assign(service,{prisma:{managedFile:{findMany:async()=>[{id:'expired',status:'RECYCLED',purgeAt:new Date(0)}]}},purgeFile:async()=>{removed++;}});
  const result=await service.purgeExpiredRecycledFiles();
  assert.equal(removed,0);assert.deepEqual(result,{scanned:0,purged:0,failed:0});
});

for(const provider of ['QINIU','UPYUN','ALIYUN','S3','CLOUDFLARE_R2']) {
  test(`${provider}: recycle preserves bytes until the explicit purge action`,async()=>{
    const file={id:'file',projectId:'p',status:'ACTIVE',cdnConfig:{provider},storageKey:'own-key'};
    const service=Object.assign(Object.create(FilesService.prototype),{
      findFileForUser:async()=>file,settingsService:{getRecycleRetentionDays:async()=>1},
      prisma:{managedFile:{update:async({data})=>Object.assign(file,data)}},
      disableFileShareLinks:async()=>0,auditService:{write:async()=>{}},eventBus:{emit(){}},
      storageService:{remove:async()=>assert.fail('recycle must not delete bytes'),removeFileObjects:async()=>assert.fail('recycle must not delete bytes')},
    });
    await service.recycle(file.id,{id:'admin'});assert.equal(file.status,'RECYCLED');
    let confirmed=false;service.purgeFile=async()=>{confirmed=true;};
    await service.purge(file.id,{id:'admin'});assert.equal(confirmed,true);
  });
}
