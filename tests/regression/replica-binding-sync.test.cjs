const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
require('ts-node').register({project:path.resolve(__dirname,'../../apps/api/tsconfig.json'),transpileOnly:true});
const {CdnService}=require('../../apps/api/src/cdn/cdn.service.ts');
test('assigning existing projects to a cloud enqueues durable replica backfill for each project',async()=>{
 const queued=[];
 const replica={enqueueProject:async id=>{queued.push(id);return {taskId:'sync-'+id};}};
 const service=new CdnService({write:async()=>{}},null,{get:()=>undefined},{},null,null,null,null,replica);
 service.assertCanManageStorage=async()=>{};
 service.findConfig=async()=>({id:'cloud',provider:'UPYUN'});
 service.runBindingTransaction=async fn=>fn({transaction:true});
 service.replaceAssignments=async()=>{};
 service.listAssignments=async()=>[{id:'p1'},{id:'p2'}];
 await service.assignProjects('cloud',['p1','p2','p1'],{id:'admin',role:'SUPER_ADMIN'});
 await new Promise(r=>setImmediate(r));
 assert.deepEqual(queued.sort(),['p1','p2']);
});
