/* Read-only metadata audit: required enabled bindings and all referenced object replicas. */
const {db,fs,path,root}=require('./replica-runtime.cjs');
const report={retained:true,readOnly:true,checkedAt:new Date().toISOString(),projects:[],failures:[]};
(async()=>{try{
 const local=await db.cdnConfig.findFirst({where:{provider:'LOCAL',projectId:null},orderBy:{createdAt:'asc'}}),projects=await db.project.findMany({where:{name:{startsWith:'验收-'},deletedAt:null},include:{storageBindings:{include:{config:true}}}});
 for(const p of projects){const files=await db.managedFile.findMany({where:{projectId:p.id,status:'ACTIVE'},include:{versions:true,derivatives:true}}),keys=new Set();
  for(const f of files){keys.add(f.storageKey);for(const v of f.versions)keys.add(v.storageKey);for(const d of f.derivatives.filter(d=>d.status==='READY')){keys.add(d.storageKey);if(d.kind==='HLS'&&Array.isArray(d.meta?.files))for(const name of d.meta.files)keys.add(d.meta.segmentPrefix+'/'+name);}}
  const required=[...new Set([local?.id,...p.storageBindings.filter(b=>b.config.enabled).map(b=>b.configId)].filter(Boolean))],rows=await db.storageReplica.findMany({where:{projectId:p.id,storageKey:{in:[...keys]}}}),counts={};for(const r of rows)counts[r.status]=(counts[r.status]||0)+1;
  for(const key of keys)for(const configId of required){const r=rows.find(r=>r.storageKey===key&&r.configId===configId);if(!r||r.status!=='READY')report.failures.push({projectId:p.id,storageKey:key,configId,status:r?.status||'UNINDEXED'});}
  report.projects.push({id:p.id,name:p.name,activeFiles:files.length,referencedObjects:keys.size,requiredStorages:required.length,states:counts});
 }
 report.counts={projects:report.projects.length,referencedObjects:report.projects.reduce((n,p)=>n+p.referencedObjects,0),unreadyRequiredReplicas:report.failures.length};fs.writeFileSync(path.join(root,'.runtime/acceptance-20261113/retained-replica-audit.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report.counts));process.exitCode=report.failures.length?1:0;
}catch(e){console.error(e.message);process.exitCode=2;}finally{await db.$disconnect();}})();
