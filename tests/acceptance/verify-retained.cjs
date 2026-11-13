/* Verify retained acceptance projects without mutating their data. */
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const root=path.resolve(__dirname,'../..');
const artifacts=path.join(root,'.runtime/acceptance-20261113');
const read=p=>JSON.parse(fs.readFileSync(path.join(artifacts,p),'utf8'));
const lifecycle=read('lifecycle/verification-retained.json');
const files=read('upload-share/runs/125217758-f19c/results.json');
const latest=read('primary/latest.json');
const primary=JSON.parse(fs.readFileSync(latest.results,'utf8'));
const api=process.env.ACCEPTANCE_API || 'http://localhost:3000/api';
const u=new URL(api); assert.ok(['localhost','127.0.0.1','[::1]'].includes(u.hostname) && u.protocol==='http:' && u.pathname==='/api');
const env=Object.fromEntries(fs.readFileSync(path.join(root,'.env'),'utf8').split(/\r?\n/).filter(s=>/^\w+=/.test(s)).map(s=>{const n=s.indexOf('=');return [s.slice(0,n),s.slice(n+1).replace(/^['"]|['"]$/g,'')];}));
const report={checkedAt:new Date().toISOString(),projects:[],files:[],failures:[],retained:true};
(async()=>{
 const login=await fetch(api+'/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:process.env.ACCEPTANCE_USERNAME || env.ADMIN_USERNAME,password:process.env.ACCEPTANCE_PASSWORD || env.ADMIN_PASSWORD})});assert.ok(login.ok);
 const cookie=login.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');
 try{
  const ids=[...lifecycle.projects.map(p=>p.id),files.project.id,...primary.projects.map(p=>p.id)];
  for(const id of ids){
   const r=await fetch(api+'/files?projectId='+id+'&pageSize=100',{headers:{cookie}});assert.ok(r.ok);const page=await r.json();
   const p=await fetch(api+'/projects/'+id,{headers:{cookie}});assert.ok(p.ok);const project=await p.json();
   report.projects.push({id,name:project.name,total:page.total,ui:'http://localhost:5175/files?projectId='+id});
   assert.equal(page.items.length,page.total);
   for(const f of page.items){
    try{assert.equal(f.status,'ACTIVE');const d=await fetch(api+'/files/'+f.id+'/download',{headers:{cookie},signal:AbortSignal.timeout(30000)});assert.equal(d.status,200);const data=Buffer.from(await d.arrayBuffer());const sha=crypto.createHash('sha256').update(data).digest('hex');assert.equal(data.length,f.size);assert.equal(sha,f.checksum);report.files.push({id:f.id,projectId:id,name:f.originalName,bytes:data.length,sha256:sha,status:'PASS'});}catch(e){report.failures.push({id:f.id,name:f.originalName,error:e.message});}
   }
  }
  const health=await fetch(api+'/healthz');assert.ok(health.ok);report.apiHealth=await health.json();
  const web=await fetch('http://localhost:5175/console-login');report.webStatus=web.status;assert.equal(web.status,200);
  const share=JSON.parse(fs.readFileSync(path.join(path.dirname(latest.results),'share-ui-results.json'),'utf8'));
  if(share.originalUrl){const bad=await fetch(share.originalUrl,{redirect:'manual'});report.generatedShareLink={url:share.originalUrl,status:bad.status,correctedBrowserUrl:share.browserUrl};}
 }finally{await fetch(api+'/auth/logout',{method:'POST',headers:{cookie,'content-type':'application/json'},body:'{}'});}
 report.counts={projects:report.projects.length,passedFiles:report.files.length,failedFiles:report.failures.length};
 fs.writeFileSync(path.join(artifacts,'final-verification.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({counts:report.counts,api:report.apiHealth,web:report.webStatus,generatedShareLink:report.generatedShareLink}));process.exitCode=report.failures.length?1:0;
})().catch(e=>{console.error(e.message);process.exitCode=2;});
