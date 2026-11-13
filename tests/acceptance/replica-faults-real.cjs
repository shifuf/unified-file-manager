/* Run while API worker is stopped. Uses real DB/files; cloud outages are adapter injection. */
const {fs,path,root,db,config,registry,ReplicaService,StorageService}=require('./replica-runtime.cjs');
const crypto=require('node:crypto'),assert=require('node:assert/strict'),{Readable}=require('node:stream');
const latest=JSON.parse(fs.readFileSync(path.join(root,'.runtime/acceptance-20261113/replica-latest.json'),'utf8'));
const projectId=latest.project.id,out=path.join(latest.out,'faults.json'),report={retained:true,cloudFailureMethod:'independent adapter injection; saved account settings unchanged',checks:[]};
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
function check(name,pass,evidence){report.checks.push({name,pass,evidence});fs.writeFileSync(out,JSON.stringify(report,null,2));console.log(JSON.stringify({name,pass}));}
async function bytes(target){const chunks=[];for await(const c of target.stream)chunks.push(Buffer.from(c));return Buffer.concat(chunks);}
function injected(failProviders=[],corruptProvider){const attempts=[];return {attempts,adapter(provider){const real=registry.adapter(provider);if(!failProviders.includes(provider)&&provider!==corruptProvider)return real;const proxy=Object.create(real);proxy.getDownloadTarget=async(c,key)=>{attempts.push(provider);if(provider===corruptProvider){const replica=await normal.readVerified(normal.runtime(await db.cdnConfig.findUnique({where:{id:c.id}})),key);const b=fs.readFileSync(replica.path);await replica.cleanup();b[0]^=255;return {type:'stream',stream:Readable.from([b]),contentLength:b.length};}throw new Error('controlled provider outage');};proxy.uploadFile=async()=>{throw new Error('controlled provider outage');};proxy.upload=async()=>{throw new Error('controlled provider outage');};return proxy;}};}
const normal=new ReplicaService(config,db,registry);
(async()=>{try{
 const project=await db.project.findUnique({where:{id:projectId}});
 const files=await db.managedFile.findMany({where:{projectId,status:'ACTIVE'},include:{cdnConfig:true}});
 await normal.runBatch('fault-preflight-expired-lease-recovery',50);
 assert.ok(files.length>=2,'retained acceptance fixtures');
 for(const file of files){const rows=await db.storageReplica.findMany({where:{projectId,storageKey:file.storageKey},include:{config:true}});for(const r of rows){const object=await normal.readVerified(normal.runtime(r.config),r.storageKey,r.size,r.checksum);check('实际来源逐副本SHA256 '+file.originalName+' '+r.config.provider,object.size===Number(file.size)&&object.checksum===file.checksum,{configId:r.configId,provider:r.config.provider,size:object.size,checksum:object.checksum});await object.cleanup();}}
 const file=files.find(f=>Number(f.size)<1024),first=(await db.storageReplica.findMany({where:{projectId,storageKey:file.storageKey},include:{config:true}})).filter(r=>r.config.provider!=='LOCAL').sort((a,b)=>a.config.priority-b.config.priority)[0];
 const one=injected([first.config.provider]);const oneService=new ReplicaService(config,db,one);const firstDownload=await bytes(await oneService.getDownloadTargetForKey(file,file.storageKey));check('首云故障切下一云',sha(firstDownload)===file.checksum&&one.attempts.length===1,{attempts:one.attempts});
 await normal.retryProject(projectId);await normal.runBatch('fault-recovery-1',50);
 const quota=injected([first.config.provider]);
 const quotaDb={project:db.project,cdnConfig:db.cdnConfig,projectStorageBinding:db.projectStorageBinding,storageReplica:{findMany:async args=>(await db.storageReplica.findMany(args)).map(r=>r.configId===first.configId?{...r,config:{...r.config,autoFailover:true,trafficQuotaBytes:100n,manualTrafficUsedBytes:95n,failoverThresholdPercent:90}}:r),updateMany:args=>db.storageReplica.updateMany(args)}};
 const quotaBytes=await bytes(await new ReplicaService(config,quotaDb,quota).getDownloadTargetForKey(file,file.storageKey));check('达到流量阈值跳过首云',sha(quotaBytes)===file.checksum&&quota.attempts.length===0,{blockedProvider:first.config.provider,attempts:quota.attempts});
 const bad=injected([],first.config.provider);const damaged=await bytes(await new ReplicaService(config,db,bad).getDownloadTargetForKey(file,file.storageKey));check('损坏副本被拒绝并切换',sha(damaged)===file.checksum,{corruptProvider:first.config.provider});
 await normal.retryProject(projectId);await normal.runBatch('fault-recovery-2',50);
 const all=injected(['QINIU','UPYUN']);const localBytes=await bytes(await new ReplicaService(config,db,all).getDownloadTargetForKey(file,file.storageKey));check('双云不可读仍本地下载',sha(localBytes)===file.checksum&&all.attempts.length===2,{attempts:all.attempts});
 const payload=Buffer.from('both clouds unavailable; durable local safety '+Date.now());const key=project.name+'/故障注入/'+crypto.randomUUID()+'.txt';
 const faultReplica=new ReplicaService(config,db,all),storage=new StorageService(config,db,all,faultReplica);
 const result=await storage.upload(projectId,{key,buffer:payload,mimeType:'text/plain',originalName:'双云故障仍可上传.txt'});
 const created=await db.managedFile.create({data:{projectId,cdnConfigId:result.cdnConfigId,storageKey:key,originalName:'双云故障仍可上传.txt',mimeType:'text/plain',extension:'txt',size:BigInt(payload.length),checksum:sha(payload),category:'DOCUMENT',folderPath:'故障注入'}});report.localFaultFile={id:created.id,sha256:sha(payload),size:payload.length};
 check('双云不可写仍本地上传',result.checksum===sha(payload),{id:created.id,localConfigId:result.cdnConfigId});
 const scopedDb={...db,project:db.project,cdnConfig:db.cdnConfig,projectStorageBinding:db.projectStorageBinding,storageReplica:{findMany:args=>db.storageReplica.findMany({...args,where:{...args.where,projectId,storageKey:key}}),updateMany:args=>db.storageReplica.updateMany(args)},$transaction:fn=>db.$transaction(fn)};
 const failed=await new ReplicaService(config,scopedDb,all).runBatch('injected-failure',10);const rows=await db.storageReplica.findMany({where:{projectId,storageKey:key}});check('失败同步持久退避且本地READY',failed.failed===2&&rows.filter(r=>r.status==='FAILED').length===2&&rows.some(r=>r.configId===result.cdnConfigId&&r.status==='READY'),{failed:failed.failed,states:rows.map(r=>({configId:r.configId,status:r.status,attempts:r.attempts}))});
 await normal.retryProject(projectId);await normal.runBatch('fault-recovery-final',50);
 const recovered=await db.storageReplica.findMany({where:{projectId,storageKey:key}});check('恢复云连接后自动补齐',recovered.length===3&&recovered.every(r=>r.status==='READY'),{states:recovered.map(r=>({configId:r.configId,status:r.status}))});
 // Leave an expired lease for the actual restarted worker to reclaim.
 const cloudRow=recovered.find(r=>r.configId!==result.cdnConfigId);await db.storageReplica.update({where:{id:cloudRow.id},data:{status:'PENDING',leaseOwner:'simulated-crashed-worker',leaseUntil:new Date(Date.now()-1000),nextAttemptAt:new Date()}});report.restartReplicaId=cloudRow.id;
 report.counts={passed:report.checks.filter(c=>c.pass).length,failed:report.checks.filter(c=>!c.pass).length};fs.writeFileSync(out,JSON.stringify(report,null,2));console.log(JSON.stringify({out,counts:report.counts}));process.exitCode=report.counts.failed?1:0;
}catch(e){report.error=e.message.replace(/https?:\/\/\S+/g,'[url]');fs.writeFileSync(out,JSON.stringify(report,null,2));console.error(report.error);process.exitCode=2;}finally{await db.$disconnect();}})();
