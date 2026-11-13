/* Recover retained acceptance objects from exact-size/SHA256 sources; quarantine corrupt bytes. */
const {fs,path,root,db,config,registry,ReplicaService,StorageService}=require('./replica-runtime.cjs');
const crypto=require('node:crypto'),assert=require('node:assert/strict');
const audit=JSON.parse(fs.readFileSync(path.join(root,'.runtime/acceptance-20261113/retained-replica-audit.json'),'utf8'));
const replicas=new ReplicaService(config,db,registry),storage=new StorageService(config,db,registry,replicas);
const report={retained:true,checkedAt:new Date().toISOString(),objects:[],failures:[]},sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const manifestPath=path.join(root,'.runtime/acceptance-20261113/retained-history-recovery.json');
function* walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())yield*walk(p);else if(e.isFile())yield p;}}
(async()=>{try{
 const unique=[...new Map(audit.failures.map(f=>[f.projectId+':'+f.storageKey,f])).values()],needed=[];
 for(const entry of unique){const row=await db.storageReplica.findFirst({where:{projectId:entry.projectId,storageKey:entry.storageKey}});assert.ok(row,'indexed metadata required');assert.ok(row.checksum&&row.size>=0n,'size and checksum required for recovery');needed.push({...entry,size:Number(row.size),checksum:row.checksum});}
 const sizes=new Set(needed.map(r=>r.size)),sources=new Map();
 for(const directory of [path.join(root,'.runtime/acceptance-20261113'),path.join(root,'.runtime/storage-813adbb')])for(const p of walk(directory)){const stat=fs.statSync(p);if(!sizes.has(stat.size)||stat.size>32*1024*1024)continue;const b=fs.readFileSync(p),hash=sha(b);if(needed.some(n=>n.checksum===hash&&!sources.has(hash)))sources.set(hash,{path:p,buffer:b});}
 for(const entry of needed){const source=sources.get(entry.checksum);if(!source){report.failures.push({...entry,error:'no retained byte-identical source'});continue;}const target=await replicas.getLocalStorage(entry.projectId),adapter=registry.adapter('LOCAL'),fingerprint=await adapter.getObjectFingerprint(target,entry.storageKey);let action;
  if(fingerprint&&(fingerprint.size!==entry.size||fingerprint.checksum!==entry.checksum)){await adapter.repairFile(target,{key:entry.storageKey,path:source.path,size:entry.size,checksum:entry.checksum,mimeType:'application/octet-stream',originalName:path.basename(entry.storageKey)},fingerprint);action='quarantined-corrupt-and-restored';}
  else if(!fingerprint){await storage.upload(entry.projectId,{key:entry.storageKey,buffer:source.buffer,mimeType:'application/octet-stream',originalName:path.basename(entry.storageKey)});action='restored-missing';}
  else action='verified-existing';
  await replicas.verifyLocalObject(target,entry.storageKey,BigInt(entry.size),entry.checksum);await replicas.recordLocalAndEnqueue(entry.projectId,target.id,entry.storageKey,BigInt(entry.size),entry.checksum);report.objects.push({...entry,verifiedSource:source.path,recovered:true,action});fs.writeFileSync(manifestPath,JSON.stringify(report,null,2));
 }
 report.counts={recovered:report.objects.length,failed:report.failures.length};fs.writeFileSync(manifestPath,JSON.stringify(report,null,2));console.log(JSON.stringify({report:manifestPath,counts:report.counts}));process.exitCode=report.failures.length?1:0;
}catch(e){report.error=e.message;fs.writeFileSync(manifestPath,JSON.stringify(report,null,2));console.error(e.message);process.exitCode=2;}finally{await db.$disconnect();}})();
