const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
require('ts-node').register({project:path.resolve(__dirname,'../../apps/api/tsconfig.json'),transpileOnly:true});
const {FilesService}=require('../../apps/api/src/files/files.service.ts');
const {MaintenanceService}=require('../../apps/api/src/maintenance/maintenance.service.ts');

test('permanent share deletion checks project permission and removes only the link',async()=>{
 const calls=[];const share={id:'s',fileId:'f',file:{projectId:'p'}};
 const service=Object.assign(Object.create(FilesService.prototype),{
  prisma:{shareLink:{findUnique:async()=>share,delete:async args=>calls.push(['delete',args.where.id])}},
  projectAccessService:{assertProjectAccess:async(...args)=>calls.push(['access',...args])},
  auditService:{write:async event=>calls.push(['audit',event])},
 });
 assert.deepEqual(await service.deleteShareLink('s',{id:'u'}),{success:true});
 assert.deepEqual(calls[0],['access',{id:'u'},'p',true]);
 assert.deepEqual(calls[1],['delete','s']);assert.equal(calls[2][1].detail.permanent,true);
 service.projectAccessService.assertProjectAccess=async()=>{throw Error('denied')};
 await assert.rejects(service.deleteShareLink('s',{id:'other'}),/denied/);assert.equal(calls.length,3);
});

test('batch purge persists failed identities and safe errors for real retries',async()=>{
 const files=[{id:'ok',projectId:'p',status:'RECYCLED'},{id:'bad',projectId:'p',status:'RECYCLED'}];let created;
 const service=Object.assign(Object.create(FilesService.prototype),{
  findFilesForUser:async()=>files,purgeFile:async f=>{if(f.id==='bad')throw Error('unsafe provider detail')},
  writeBatchAudit:async()=>{},tasksService:{create:async params=>{created=params;return params}},
 });
 const result=await service.batchPurge({fileIds:['ok','bad']},{id:'u'});
 assert.equal(result.failed,1);assert.equal(created.status,'FAILED');
 assert.deepEqual(created.detail.fileIds,['ok','bad']);assert.deepEqual(created.detail.failedFileIds,['bad']);
 assert.equal(created.detail.actorId,'u');assert.equal(created.detail.failures[0].fileId,'bad');
 assert.doesNotMatch(created.detail.failures[0].error,/unsafe/);
});

test('retention scans expired recycled entries in bounded pages and retains failed rows',async()=>{
 let round=0,query;const removed=[];
 const service=Object.assign(Object.create(FilesService.prototype),{
  prisma:{managedFile:{findMany:async args=>{query=args;return round++?[]:[{id:'old',status:'RECYCLED'},{id:'fail',status:'RECYCLED'}]}}},
  purgeFile:async(file,actor,source)=>{assert.equal(source,'retention');if(file.id==='fail')throw Error('offline');removed.push(file.id)},
 });
 const result=await service.purgeExpiredRecycledFiles();
 assert.deepEqual(result,{scanned:2,purged:1,failed:1});assert.deepEqual(removed,['old']);
 assert.equal(query.where.status,'RECYCLED');assert.ok(query.take<=100);assert.ok(query.where.purgeAt.lte instanceof Date);
});

test('scheduled maintenance invokes expiry purge without overlapping runs',async()=>{
 let purges=0;const db={openApiNonce:{deleteMany:async()=>({count:0})},refreshToken:{deleteMany:async()=>({count:0})}};
 const service=new MaintenanceService(db,{get:(_key,fallback)=>fallback},{runDuePolicies:async()=>({policies:0,affected:0})},
  {purgeExpiredRecycledFiles:async()=>{purges++;return {scanned:0,purged:0,failed:0}}});
 service.cleanupAuditLogs=async()=>0;service.cleanupStaleUploads=async()=>0;
 await service.runCleanup();assert.equal(purges,1);
});

test('admin share responses use the current storage forecast rather than the immutable original',async()=>{
 const head={id:'old',name:'stopped',provider:'QINIU',enabled:false,config:{domain:'https://old.invalid'}};
 const active={id:'new',name:'available cloud',provider:'UPYUN',config:{domain:'https://new.invalid'}};
 const share={id:'s',token:'token',customPath:null,file:{id:'f',projectId:'p',storageKey:'p/key',size:1n,originalName:'f.txt',cdnConfig:head},maxDownloads:null,downloadCount:0,enabled:true};
 const service=Object.assign(Object.create(FilesService.prototype),{configService:{get:()=>undefined},storageService:{describeDownloadStorages:async files=>{assert.equal(files[0].id,'f');return new Map([['f',active]])}}});
 let [response]=await service.toAdminShareResponses([share]);assert.equal(response.storageConfigName,'available cloud');assert.equal(response.storageProvider,'UPYUN');assert.equal(share.file.cdnConfig.id,'old');
 service.storageService.describeDownloadStorages=async()=>new Map([['f',{id:'local',name:'本地存储',provider:'LOCAL',config:{}}]]);
 [response]=await service.toAdminShareResponses([share]);assert.equal(response.storageProvider,'LOCAL');
 service.storageService.describeDownloadStorages=async()=>new Map([['f',null]]);
 [response]=await service.toAdminShareResponses([share]);assert.equal(response.storageProvider,null);
});

test('retention advances beyond a full pass of persistent failures and then wraps for retries',async()=>{
 const entries=Array.from({length:251},(_,i)=>({id:String(i).padStart(4,'0'),status:'RECYCLED'})),seen=[];
 const service=Object.assign(Object.create(FilesService.prototype),{prisma:{managedFile:{findMany:async({where,take})=>entries.filter(f=>!where.id||f.id>where.id.gt).slice(0,take)}},
 purgeFile:async file=>{seen.push(file.id);throw Error('provider offline')}});
 assert.equal((await service.purgeExpiredRecycledFiles()).scanned,250);
 assert.equal((await service.purgeExpiredRecycledFiles()).scanned,1);assert.equal(seen.at(-1),'0250');
 await service.purgeExpiredRecycledFiles();assert.equal(seen[251],'0000');
});
