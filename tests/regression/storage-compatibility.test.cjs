const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
let DatabaseSync;
try { ({DatabaseSync}=require('node:sqlite')); } catch { /* Node 20 has no embedded SQLite. */ }
require('ts-node').register({project:path.resolve(__dirname,'../../apps/api/tsconfig.json'),transpileOnly:true});
const {CdnService}=require('../../apps/api/src/cdn/cdn.service.ts');
const {Prisma}=require('@prisma/client');
const user={id:'admin',role:'SUPER_ADMIN'};
function setup() {
 const configs=[{id:'bound',provider:'LOCAL',name:'original',enabled:true,projectId:null,config:{},priority:10,autoFailover:true,failoverThresholdPercent:90},{id:'unbound',provider:'LOCAL',name:'other',enabled:true,projectId:null,config:{},priority:20}];
 const bindings=new Set(['bound']);
 let active='bound';
 const db={cdnConfig:{findFirst:async({where})=>configs.find(c=>c.id===where.id&&c.enabled&&(where.projectId===undefined||c.projectId===where.projectId)&&(!where.projectBindings||bindings.has(c.id)))??null,update:async({where,data})=>Object.assign(configs.find(c=>c.id===where.id),Object.fromEntries(Object.entries(data).filter(([,v])=>v!==undefined)))}};
 db.cdnConfig.create=async({data})=>{const row={...configs[0],...data,id:'created',projectId:null};configs.push(row);return row;};
 db.projectStorageBinding={create:async({data})=>{bindings.add(data.configId);return data;},findUnique:async({where})=>bindings.has(where.projectId_configId.configId)?where.projectId_configId:null};
 db.project={update:async({data})=>{active=data.activeCdnConfigId;return {activeCdnConfigId:active};}};
 db.$queryRaw=async()=>[];db.$transaction=async fn=>fn(db);
 const service=new CdnService({write:async()=>{}},null,{get:(key,fallback)=>key==='NODE_ENV'?'test':key==='APP_CRYPTO_KEY'?'test-crypto-key-with-more-than-32-characters':fallback},db,{assertProjectAccess:async()=>{}},null,null,null);
 service.testLocalConfig=async()=>[{name:'fixture',status:'PASS',message:'ok'}];
 return {service,configs,db,getActive:()=>active};
}
test('legacy project creation with active true selects the new assigned global target',async()=>{
 const {service,getActive}=setup();
 const result=await service.createForProject('p',{provider:'LOCAL',name:'created',config:{},active:true},user);
 assert.equal(getActive(),'created');assert.equal(result.active,true);
});
test('global creation does not select a project when active true is supplied',async()=>{
 const {service,getActive}=setup();
 const result=await service.create({provider:'LOCAL',name:'created',config:{},active:true},user);
 assert.equal(getActive(),'bound');assert.equal(result.active,false);
});
test('project health and usage endpoints reject unassigned global accounts',async()=>{
 const {service}=setup();
 await assert.rejects(service.testForProject('p','unbound',user),e=>e.getStatus()===404);
 await assert.rejects(service.getUsageForProject('p','unbound',user),e=>e.getStatus()===404);
});
test('legacy project update edits its assigned global configuration',async()=>{
 const {service,configs}=setup();
 const result=await service.updateForProject('p','bound',{name:'renamed'},user);
 assert.equal(result.name,'renamed');assert.equal(configs[0].name,'renamed');
});
test('legacy project draft test accepts its assigned global configuration',async()=>{
 const {service}=setup();
 const result=await service.testDraftForConfig('bound',{name:'renamed'},user,'p');
 assert.equal(result.success,true);
});
test('project update rejects an unassigned global configuration',async()=>{
 const {service,configs}=setup();
 await assert.rejects(service.updateForProject('p','unbound',{name:'unauthorized'},user),e=>e.getStatus()===404);
 assert.equal(configs[1].name,'other');
});
test('legacy project delete directs the user to global management without disabling shared storage',async()=>{
 const {service,configs}=setup();
 await assert.rejects(service.removeForProject('p','bound',user,true),e=>e.getStatus()===400&&e.message.includes('全局存储管理'));
 assert.equal(configs[0].enabled,true);
});
test('updating manual policy invalidates the displayed usage immediately',async()=>{
 const {service}=setup();
 await service.getUsage('bound',user);
 await service.update('bound',{storageQuotaBytes:100,manualStorageUsedBytes:95},user);
 const usage=await service.getUsage('bound',user);
 assert.equal(usage.storageQuotaBytes,100);assert.equal(usage.storageUsedBytes,95);
});
test('compensating migration binds legacy LOCAL fallback by priority then age and keeps existing targets',{skip:!DatabaseSync},()=>{
 const db=new DatabaseSync(':memory:');
 try {
  db.exec("CREATE TABLE Project(id TEXT PRIMARY KEY,activeCdnConfigId TEXT,deletedAt TEXT); CREATE TABLE CdnConfig(id TEXT PRIMARY KEY,provider TEXT,enabled INTEGER,projectId TEXT,priority INTEGER,createdAt TEXT); CREATE TABLE ProjectStorageBinding(projectId TEXT,configId TEXT,PRIMARY KEY(projectId,configId)); INSERT INTO Project VALUES('legacy',NULL,NULL),('current','remote',NULL),('deleted',NULL,'2026-01-01'); INSERT INTO CdnConfig VALUES('old-local','LOCAL',1,NULL,50,'2020'),('preferred','LOCAL',1,NULL,1,'2021'),('newer','LOCAL',1,NULL,1,'2022'),('disabled','LOCAL',0,NULL,0,'2019'),('remote','UPYUN',1,NULL,0,'2019'); INSERT INTO ProjectStorageBinding VALUES('current','remote');");
  const migration=path.resolve(__dirname,'../../apps/api/prisma/migrations/20261113010000_backfill_local_fallback/migration.sql');
  const sql=fs.existsSync(migration)?fs.readFileSync(migration,'utf8'):'';
  db.exec(sql.replace(/INSERT IGNORE/gi,'INSERT OR IGNORE'));
  assert.equal(db.prepare("SELECT activeCdnConfigId FROM Project WHERE id='legacy'").get().activeCdnConfigId,'preferred');
  assert.equal(db.prepare("SELECT configId FROM ProjectStorageBinding WHERE projectId='legacy'").get().configId,'preferred');
  assert.equal(db.prepare("SELECT activeCdnConfigId FROM Project WHERE id='current'").get().activeCdnConfigId,'remote');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM ProjectStorageBinding WHERE projectId='deleted'").get().count,0);
 } finally {db.close();}
});

test('global deletion racing with selection never leaves the project on disabled storage',async()=>{
 const source={id:'source',provider:'UPYUN',name:'source',enabled:true,projectId:null,config:{}};
 const target={id:'target',provider:'UPYUN',name:'target',enabled:true,projectId:null,config:{}};
 let active='source', bound=true, selection;
 let owner, release;
 const waiters=[];
 const db={};
 function client(inTransaction=false,token) {
  return {
   $queryRaw:async(strings)=>{
    const sql=strings.join('?');
    if(sql.includes('FROM Project WHERE')) {
     while(owner&&owner!==token) await new Promise(resolve=>waiters.push(resolve));
     owner=token;
    }
    return sql.includes('FROM ProjectStorageBinding')?(bound?[{projectId:'p'}]:[]):[];
   },
   cdnConfig:{
    findFirst:async({where})=>[source,target].find(c=>c.enabled&&(!where.id||c.id===(where.id.not?'source':where.id))&&(!where.projectBindings||c.id==='source'||bound))??null,
    update:async({data})=>Object.assign(target,data),
   },
   projectStorageBinding:{
    findMany:async()=>bound?[{projectId:'p'}]:[],findUnique:async()=>bound?{projectId:'p',configId:'target'}:null,
    deleteMany:async()=>{bound=false;},createMany:async()=>{},
   },
   project:{
    count:async()=>{
     const count=active==='target'?1:0;
     if(!selection) {
      selection=service.selectForProject('p','target',user);
      selection.catch(()=>{});
      // On the old implementation selection finishes after the stale count.
      // Inside the fixed transaction it waits for the project's row lock.
      if(!inTransaction) await selection;
     }
     return count;
    },
    findMany:async()=>[{id:'p',activeCdnConfigId:active,deletedAt:null}],
    findUnique:async()=>({id:'p',name:'p',activeCdnConfigId:active,deletedAt:null}),
    update:async({data})=>{active=data.activeCdnConfigId;return {activeCdnConfigId:active};},
   },
  };
 }
 Object.assign(db,client());
 db.$transaction=async fn=>{
  const token=Symbol('tx');
  try {return await fn(client(true,token));}
  finally {if(owner===token){owner=null;while(waiters.length)waiters.shift()();}}
 };
 const service=new CdnService({write:async()=>{}},null,{get:()=>undefined},db,{assertProjectAccess:async()=>{}},null,null,null);
 const deletion=await service.remove('target',user).then(()=>({ok:true}),error=>({ok:false,error}));
 if(selection) await selection.catch(()=>{});
 assert.ok(active!=='target'||target.enabled,'project must never retain disabled current storage');
 if(deletion.ok) assert.equal(bound,false,'deleting storage removes its assignments atomically');
 else assert.equal(deletion.error.getStatus(),400);
});

function retryFixture(failures) {
 const {service,configs,db}=setup();
 db.project.count=async()=>0;db.project.findMany=async()=>[];
 db.cdnConfig.count=async()=>1;
 db.projectStorageBinding.deleteMany=async()=>{};
 let attempts=0;
 db.$transaction=async fn=>{
  const error=failures[attempts++];
  if(error) throw error;
  return fn(db);
 };
 return {service,configs,attempts:()=>attempts};
}
const deadlock=(code,meta)=>new Prisma.PrismaClientKnownRequestError('fixture database deadlock',{code,meta,clientVersion:'6.19.0'});
for(const [name,error] of [['Prisma write conflict',deadlock('P2034')],['raw MySQL deadlock',deadlock('P2010',{code:'1213'})]]) {
 test(`global delete retries a ${name} as a fresh transaction`,async()=>{
  const {service,configs,attempts}=retryFixture([error]);
  assert.deepEqual(await service.remove('unbound',user),{success:true});
  assert.equal(configs[1].enabled,false);assert.equal(attempts(),2);
 });
}
test('global delete caps repeated deadlocks at three transaction attempts',async()=>{
 const error=deadlock('P2034');
 const {service,configs,attempts}=retryFixture([error,error,error,error]);
 await assert.rejects(service.remove('unbound',user),e=>e===error);
 assert.equal(attempts(),3);assert.equal(configs[1].enabled,true);
});
test('global delete never retries unrelated database failures',async()=>{
 const error=deadlock('P2010',{code:'1146'});
 const {service,configs,attempts}=retryFixture([error]);
 await assert.rejects(service.remove('unbound',user),e=>e===error);
 assert.equal(attempts(),1);assert.equal(configs[1].enabled,true);
});
