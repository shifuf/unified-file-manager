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

test('retrying a failed selected cloud sync schedules a fresh scan and one replica retry while keeping its target', async () => {
 const failed={id:'failed',projectId:'p',type:'STORAGE_REPLICA_SYNC',title:'selected sync',status:'FAILED',detail:{
  phase:'AWAITING_REPLICAS',targetConfigId:'cloud-a',cursor:'',scanned:20,queued:40,replicaTotal:40,replicaReady:37,replicaFailed:3,replicaPending:0,
 },error:'replicas failed'};
 const created=[];
 const db={task:{findUnique:async()=>failed,create:async({data})=>{created.push(data);return{id:'retried',...data};}}};
 const service=new TasksService({write:async()=>{}},db,{assertProjectAccess:async()=>{}});
 const result=await service.retry('failed',{id:'admin',role:'SUPER_ADMIN'});
 assert.equal(result.status,'RUNNING'); assert.equal(created[0].detail.targetConfigId,'cloud-a');
 assert.equal(created[0].detail.phase,'SCANNING'); assert.equal(created[0].detail.retryReplicas,true);
 assert.equal(created[0].detail.cursor,''); assert.equal(created[0].detail.scanned,0); assert.equal(created[0].detail.queued,0);
 for(const key of ['replicaTotal','replicaReady','replicaFailed','replicaPending']) assert.equal(created[0].detail[key],0);
 assert.equal(created[0].detail.retriedFromTaskId,'failed'); assert.equal(created[0].finishedAt,null);
});
