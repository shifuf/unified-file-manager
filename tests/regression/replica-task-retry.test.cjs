const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
require('ts-node').register({project:path.resolve(__dirname,'../../apps/api/tsconfig.json'),transpileOnly:true});
const {TasksService}=require('../../apps/api/src/tasks/tasks.service.ts');
test('retrying failed replica backfill schedules real work from the durable cursor',async()=>{
 const failed={id:'failed',projectId:'p',type:'STORAGE_REPLICA_SYNC',title:'sync',status:'FAILED',detail:{cursor:'last',scanned:20,queued:40},error:'interrupted'};
 const created=[];
 const db={task:{findUnique:async()=>failed,create:async({data})=>{created.push(data);return {id:'retried',...data};}}};
 const service=new TasksService({write:async()=>{}},db,{assertProjectAccess:async()=>{}});
 const result=await service.retry('failed',{id:'admin',role:'SUPER_ADMIN'});
 assert.equal(result.status,'RUNNING');
 assert.equal(created[0].detail.cursor,'last');
 assert.equal(created[0].finishedAt,null);
 assert.equal(created[0].leaseOwner,null);
});
