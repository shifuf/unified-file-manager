/* Real saved cloud accounts, unique retained fixtures, no credential output. */
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),api='http://localhost:3000/api',web='http://localhost:5175';
const env=Object.fromEntries(fs.readFileSync(path.join(root,'.env'),'utf8').split(/\r?\n/).filter(s=>/^\w+=/.test(s)).map(s=>{const i=s.indexOf('=');return [s.slice(0,i),s.slice(i+1).trim().replace(/^['"]|['"]$/g,'')];}));
const run='replicas-'+Date.now().toString(36),out=path.join(root,'.runtime/acceptance-20261113',run);
fs.mkdirSync(out,{recursive:true});
const report={run,retained:true,checks:[],files:[],startedAt:new Date().toISOString()};
let cookie,project,configs;
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const save=()=>{fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(report,null,2));fs.writeFileSync(path.join(root,'.runtime/acceptance-20261113/replica-latest.json'),JSON.stringify({out,project:report.project},null,2));};
const check=(name,pass,evidence)=>{report.checks.push({name,pass,evidence});console.log(JSON.stringify({name,pass}));save();};
async function request(p,method='GET',body,headers={}) {return fetch(api+p,{method,headers:{cookie,'user-agent':'UFM-Replica-Acceptance','content-type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(90000),redirect:'manual'});}
async function json(p,method='GET',body){const r=await request(p,method,body);if(!r.ok)throw new Error(method+' '+p+' HTTP '+r.status);return r.json();}
async function upload(name,bytes,query='') {
 fs.writeFileSync(path.join(out,name),bytes);
 const form=new FormData();form.append('files',new Blob([bytes],{type:'application/octet-stream'}),name);
 const r=await fetch(api+'/projects/'+project.id+'/files?folderPath='+encodeURIComponent('完整验收')+query,{method:'POST',headers:{cookie},body:form,signal:AbortSignal.timeout(90000)});
 assert.ok(r.ok,'upload HTTP '+r.status);const f=(await r.json())[0];
 const rec={id:f.id,name:f.originalName,size:bytes.length,sha256:sha(bytes),fixturePath:path.join(out,name)};report.files.push(rec);
 check('本地可靠上传 '+name,f.cdnProvider==='LOCAL'&&f.checksum===rec.sha256,{id:f.id,provider:f.cdnProvider});return {f,bytes,rec};
}
async function waitReplicas(file,seconds=100){const deadline=Date.now()+seconds*1000;let rows=[];while(Date.now()<deadline){const data=await json('/projects/'+project.id+'/storage/replicas');rows=data.items.filter(r=>r.checksum===file.checksum);if(rows.length>=3&&rows.every(r=>r.status==='READY'))break;await new Promise(r=>setTimeout(r,2000));}return rows;}
async function download(file,bytes){const r=await request('/files/'+file.id+'/download');const actual=Buffer.from(await r.arrayBuffer());check('代理完整下载 '+file.originalName,r.status===200&&!r.headers.get('location')&&sha(actual)===sha(bytes),{status:r.status,size:actual.length});for(const range of ['bytes=3-12','bytes=-7','bytes=9-']){const rr=await request('/files/'+file.id+'/download','GET',undefined,{Range:range});const b=Buffer.from(await rr.arrayBuffer());const expected=range==='bytes=3-12'?bytes.subarray(3,13):range==='bytes=-7'?bytes.subarray(-7):bytes.subarray(9);check('Range '+range,rr.status===206&&b.equals(expected),{status:rr.status,length:b.length,contentRange:rr.headers.get('content-range')});}const bad=await request('/files/'+file.id+'/download','GET',undefined,{Range:'bytes=999999999-'});check('越界 Range 416',bad.status===416,{status:bad.status});}
async function shareFlow(file,bytes){
 const s=await json('/files/'+file.id+'/shares','POST',{password:'Acceptance-Only-2026',maxDownloads:1});
 check('分享地址使用本地统一入口',s.url.startsWith(web+'/'),{url:s.url});
 const page=await fetch(s.url);check('生成的分享页可打开',page.status===200,{status:page.status});
 const session=await json('/shares/'+s.token+'/download-session','POST',{password:'Acceptance-Only-2026'});
 const sessionUrl=new URL(session.url,web);
 const p=sessionUrl.pathname.replace(/^\/api/,'')+sessionUrl.search;
 const head=await request(p,'HEAD');const list1=await json('/files/'+file.id+'/shares');
 check('HEAD不消耗分享次数',head.status===200&&list1.find(x=>x.id===s.id).downloadCount===0,{status:head.status});
 const invalid=await request(p,'GET',undefined,{Range:'bytes=999999999-'});const list2=await json('/files/'+file.id+'/shares');
 check('416不消耗分享次数',invalid.status===416&&list2.find(x=>x.id===s.id).downloadCount===0,{status:invalid.status});
 for(const [i,range] of ['bytes=0-9','bytes=10-19'].entries()){const r=await request(p,'GET',undefined,{Range:range});const b=Buffer.from(await r.arrayBuffer());check('同会话续传 '+range,r.status===206&&b.equals(bytes.subarray(i*10,(i+1)*10)),{status:r.status,length:b.length});}
 const list3=await json('/files/'+file.id+'/shares');check('两段续传仅计一次',list3.find(x=>x.id===s.id).downloadCount===1,{count:list3.find(x=>x.id===s.id).downloadCount});
 await json('/file-shares/'+s.id,'PUT',{enabled:false});const revoked=await request(p);check('撤销分享后旧ticket拒绝',revoked.status>=400,{status:revoked.status});
 report.share={id:s.id,url:s.url};
}
(async()=>{try{
 const login=await fetch(api+'/auth/login',{method:'POST',headers:{'content-type':'application/json','user-agent':'UFM-Replica-Acceptance'},body:JSON.stringify({username:env.ADMIN_USERNAME,password:env.ADMIN_PASSWORD})});assert.ok(login.ok,'login');cookie=login.headers.getSetCookie().map(s=>s.split(';')[0]).join('; ');
 configs=await json('/storage-configs');const clouds=configs.filter(c=>['UPYUN','QINIU'].includes(c.provider));assert.equal(clouds.length,2,'two saved real accounts');
 project=await json('/projects','POST',{name:'验收-本地与双云副本-'+run});report.project={id:project.id,name:project.name,url:web+'/projects/'+project.id};save();
 for(const c of clouds){const assignments=await json('/storage-configs/'+c.id+'/projects');await json('/storage-configs/'+c.id+'/projects','PUT',{projectIds:[...assignments.map(p=>p.id),project.id]});}
 const a=await upload('全文与分段-'+run+'.bin',Buffer.from('真实账户全流程测试\n0123456789abcdefghijklmnopqrstuvwxyz\n'+run));
 const b=await upload('二进制-'+run+'.bin',crypto.randomBytes(3*1024*1024+31));
 for(const item of [a,b]){const rows=await waitReplicas(item.f);check('本地与两云全部校验READY '+item.f.originalName,rows.length===3&&rows.every(r=>r.status==='READY'&&r.checksum===sha(item.bytes)),{replicas:rows.map(r=>({id:r.id,provider:r.provider,status:r.status,size:r.size,checksum:r.checksum}))});await download(item.f,item.bytes);}
 await json('/files/'+a.f.id,'PUT',{isPublic:true,originalName:'改名可搜索-'+run+'.bin'});const search=await json('/files?projectId='+project.id+'&keyword='+encodeURIComponent('改名可搜索-'+run));check('重命名后新名称搜索可见',search.items.some(f=>f.id===a.f.id),{total:search.total});
 const publicRead=await fetch(web+'/api/public/files/'+a.f.id,{redirect:'manual'});check('统一公开直链无云跳转',publicRead.status===200&&!publicRead.headers.get('location')&&sha(Buffer.from(await publicRead.arrayBuffer()))===sha(a.bytes),{status:publicRead.status});
 await shareFlow(a.f,a.bytes);
 const replacement=await upload('新版-'+run+'.bin',Buffer.from('new version '+run),'&duplicateStrategy=replace&targetFileId='+a.f.id);check('覆盖保留文件ID',replacement.f.id===a.f.id,{id:replacement.f.id});
 await json('/files/'+a.f.id+'/versions/1/restore','POST',{});const restored=await request('/files/'+a.f.id+'/download');check('历史版本完整恢复',restored.status===200&&sha(Buffer.from(await restored.arrayBuffer()))===sha(a.bytes),{status:restored.status});
 await json('/files/'+b.f.id,'DELETE');await json('/files/'+b.f.id+'/restore','POST',{});const recycled=await request('/files/'+b.f.id+'/download');check('回收恢复后仍可下载',recycled.status===200&&sha(Buffer.from(await recycled.arrayBuffer()))===sha(b.bytes),{status:recycled.status});
 const inspect=await json('/projects/'+project.id+'/storage/replicas/inspect','POST',{});check('完整性巡检接口成功',!!inspect,{result:inspect});
 report.finishedAt=new Date().toISOString();report.counts={passed:report.checks.filter(c=>c.pass).length,failed:report.checks.filter(c=>!c.pass).length};save();console.log(JSON.stringify({out,counts:report.counts}));process.exitCode=report.counts.failed?1:0;
}catch(e){report.error=e.message;save();console.error(e.message);process.exitCode=2;}finally{if(cookie)await request('/auth/logout','POST',{}).catch(()=>{});}})();
