const r=require('./replica-runtime.cjs');
const p=JSON.parse(r.fs.readFileSync(r.path.join(r.root,'.runtime/acceptance-20261113/replica-latest.json'),'utf8')).project.id;
r.db.storageReplica.findMany({where:{projectId:p},include:{config:true}}).then(rows=>console.log(JSON.stringify(rows.map(x=>({provider:x.config.provider,status:x.status,attempts:x.attempts,error:x.lastError,key:x.storageKey}))))).finally(()=>r.db.$disconnect());
