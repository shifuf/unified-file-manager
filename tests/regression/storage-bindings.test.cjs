const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
require('ts-node').register({project:path.resolve(__dirname,'../../apps/api/tsconfig.json'),transpileOnly:true});
const {StorageService}=require('../../apps/api/src/storage/storage.service.ts');
const {CdnService}=require('../../apps/api/src/cdn/cdn.service.ts');
const user={id:'admin',role:'SUPER_ADMIN'};
const fixture=(id,priority,threshold=false)=>({id,provider:'UPYUN',name:id,config:{domain:'https://example.test'},enabled:true,projectId:null,priority,autoFailover:true,failoverThresholdPercent:90,storageQuotaBytes:100n,manualStorageUsedBytes:threshold?95n:10n,trafficQuotaBytes:100n,manualTrafficUsedBytes:10n});
test('quota failover cannot pick a globally available but unassigned storage',async()=>{
 const source=fixture('source',10,true),unbound=fixture('unbound',1),bound=fixture('bound',20);
 let current=source.id;let task;
 const all=[source,unbound,bound];
 const db={project:{findFirst:async()=>({id:'p',activeCdnConfigId:current,activeCdnConfig:all.find(c=>c.id===current)}),updateMany:async({data})=>{current=data.activeCdnConfigId;return {count:1}}},cdnConfig:{findMany:async({where})=>all.filter(c=>c.id!==where.id.not && (!where.projectBindings || c.id==='bound'))},projectStorageBinding:{findMany:async()=>[{projectId:'p',configId:'source'},{projectId:'p',configId:'bound'}]},task:{create:async({data})=>{task=data;}},$transaction:async fn=>fn(db)};
 db.$queryRaw=async()=>[];
 db.projectStorageBinding.findUnique=async({where})=>where.projectId_configId.configId==='bound'?{projectId:'p',configId:'bound'}:null;
 const service=new StorageService({get:()=>undefined},db,{adapter:()=>({getUsage:async()=>({})})});
 const result=await service.getActiveStorage('p');
 assert.equal(result.id,'bound');assert.equal(current,'bound');assert.equal(task,undefined,'quota failover changes preference without creating a whole-project migration task');
});
test('project cannot select a global storage without its explicit assignment',async()=>{
 let updated=false;
 const db={cdnConfig:{findFirst:async()=>fixture('unbound',10)},projectStorageBinding:{findUnique:async()=>null},project:{update:async()=>{updated=true;return {activeCdnConfigId:'unbound'}}}};
 db.$queryRaw=async()=>[];db.$transaction=async fn=>fn(db);
 const service=new CdnService({write:async()=>{}},null,{get:()=>undefined},db,{assertProjectAccess:async()=>{}},null,null,null);
 await assert.rejects(service.selectForProject('p','unbound',user));assert.equal(updated,false);
});
