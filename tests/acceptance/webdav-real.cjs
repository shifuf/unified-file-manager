/* Real DAV acceptance. Projects, files and reports are retained; credentials are never serialized. */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const root=process.env.UFM_TEST_ROOT||path.resolve(__dirname,'../..'),base=process.env.UFM_TEST_BASE||'http://localhost:5175',run='dav-'+Date.now().toString(36),out=path.join(root,'.runtime/acceptance-20261114-webdav',run);
fs.mkdirSync(out,{recursive:true});
const report={base,run,retained:true,startedAt:new Date().toISOString(),checks:[],projects:[],files:[]};
let cookie;
function save(){fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(report,null,2));}
function check(name,evidence){report.checks.push({name,pass:true,evidence});save();console.log(JSON.stringify({name,pass:true}));}
async function auth(){
 if(process.env.UFM_TEST_AUTH_STDIN==='1'){let input='';for await(const chunk of process.stdin)input+=chunk;return JSON.parse(input);}
 if(fs.existsSync(path.join(root,'.env'))){const env=Object.fromEntries(fs.readFileSync(path.join(root,'.env'),'utf8').split(/\r?\n/).filter(s=>/^\w+=/.test(s)).map(s=>{const i=s.indexOf('=');return [s.slice(0,i),s.slice(i+1).trim().replace(/^['"]|['"]$/g,'')]}));return {username:env.ADMIN_USERNAME,password:env.ADMIN_PASSWORD};}
 return {username:process.env.ADMIN_USERNAME,password:process.env.ADMIN_PASSWORD};
}
async function api(route,method='GET',body){return fetch(base+'/api'+route,{method,headers:{cookie,'content-type':'application/json','user-agent':'UFM-DAV-Acceptance'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(90000),redirect:'manual'});}
async function json(route,method='GET',body){const r=await api(route,method,body);assert.ok(r.ok,method+' '+route+' status '+r.status);return r.json();}
function dav(baseUrl,user,password){const authorization='Basic '+Buffer.from(user+':'+password).toString('base64');return (route,method='GET',body,headers={})=>fetch(baseUrl+'/'+route,{method,headers:{authorization,'user-agent':'UFM-DAV-Acceptance',...headers},body,redirect:'manual',signal:AbortSignal.timeout(90000)});}
async function read(request,route,expected){const r=await request(route);assert.equal(r.status,200);assert.equal(r.headers.get('location'),null);assert.deepEqual(Buffer.from(await r.arrayBuffer()),expected);}
async function exercise(project,settings,username,password,folder){
 const request=dav(settings.baseUrl,username,password),legacy=dav(base+'/api/dav/'+project.id,username,password),route=folder+'/test.txt';
 assert.equal((await request(folder+'/','MKCOL')).status,201);
 const bytes=Buffer.from('DAV 中文备份 0123456789 '+run),changed=Buffer.from('DAV 覆盖后的备份 9876543210 '+run);
 fs.writeFileSync(path.join(out,project.id+'-fixture.txt'),changed);
 assert.equal((await request(route,'PUT',bytes,{'content-type':'text/plain; charset=utf-8'})).status,201);
 await read(request,route,bytes);await read(legacy,route,bytes);
 const head=await request(route,'HEAD');assert.equal(head.status,200);assert.equal(head.headers.get('content-length'),String(bytes.length));
 const partial=await request(route,'GET',undefined,{range:'bytes=3-9'});assert.equal(partial.status,206);assert.equal(partial.headers.get('content-range'),'bytes 3-9/'+bytes.length);assert.deepEqual(Buffer.from(await partial.arrayBuffer()),bytes.subarray(3,10));
 assert.equal((await request(route,'PUT',changed,{'content-type':'text/plain'})).status,204);await read(request,route,changed);
 const xmlResponse=await request(folder+'/','PROPFIND',undefined,{depth:'1'});assert.equal(xmlResponse.status,207);const xml=await xmlResponse.text();assert.ok(xml.includes('/api/dav/'+settings.slug+'/'+folder+'/test.txt'));
 const copyRoute=folder+'/copy.txt',moveRoute=folder+'/moved.txt';
 assert.equal((await request(route,'COPY',undefined,{destination:settings.baseUrl+'/'+copyRoute})).status,201);await read(request,copyRoute,changed);
 assert.equal((await request(copyRoute,'MOVE',undefined,{destination:settings.baseUrl+'/'+moveRoute})).status,201);await read(request,moveRoute,changed);
 assert.equal((await request(copyRoute)).status,404);
 const badDestination=base+'/api/dav/'+settings.slug+'other/'+folder+'/escape.txt';assert.equal((await request(route,'COPY',undefined,{destination:badDestination})).status,400);
 const listed=await json('/files?projectId='+project.id+'&pageSize=100');const row=listed.items.find(f=>f.folderPath===folder&&f.originalName==='test.txt');assert.ok(row);assert.equal(row.checksum,crypto.createHash('sha256').update(changed).digest('hex'));assert.equal(row.size,changed.length);
 report.files.push({id:row.id,projectId:project.id,folderPath:folder,name:row.originalName,size:changed.length,sha256:row.checksum});
 check('DAV '+project.id+' MKCOL/PUT/GET/HEAD/Range/overwrite/PROPFIND/COPY/MOVE/isolation',{projectId:project.id,folder,slug:settings.slug,fileId:row.id,sha256:row.checksum});
}
(async()=>{try{
 const credentials=await auth(),login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:credentials.username,password:credentials.password}),signal:AbortSignal.timeout(20000)});assert.ok(login.ok,'admin login');cookie=login.headers.getSetCookie().map(s=>s.split(';')[0]).join('; ');
 const version=await json('/version');assert.equal(version.currentVersion,'v0.2.2');check('running version v0.2.2',{currentVersion:version.currentVersion});
 const username='davtest'+crypto.randomBytes(3).toString('hex'),password=crypto.randomBytes(18).toString('hex');
 const suffixes=['letters'+crypto.randomBytes(3).toString('hex').replace(/[0-9]/g,'a'),String(Date.now()),''];let primary,primarySettings;
 for(let i=0;i<suffixes.length;i++){
  const project=await json('/projects','POST',{name:'验收-DAV-'+['英文','数字','随机'][i]+'-'+run,webdavEnabled:true,webdavUsername:username,webdavPassword:password,webdavSlug:suffixes[i]});
  const settings=await json('/projects/'+project.id+'/webdav');assert.equal(settings.slug,project.webdavSlug);assert.ok(settings.baseUrl.endsWith('/'+settings.slug));
  if(suffixes[i])assert.equal(settings.slug,suffixes[i]);else assert.match(settings.slug,/^[a-f0-9]{24}$/);
  report.projects.push({id:project.id,name:project.name,slug:settings.slug,url:base+'/projects/'+project.id});check('create '+['alphabetic','numeric','random'][i]+' DAV address',{projectId:project.id,slug:settings.slug});
  if(i===0){primary=project;primarySettings=settings;}else{const request=dav(settings.baseUrl,username,password);assert.equal((await request('','PROPFIND',undefined,{depth:'0'})).status,207);}
 }
 const primaryId=primary.id;
 assert.equal((await api('/projects/'+primaryId+'/webdav','PUT',{slug:report.projects[1].slug})).status,409);
 assert.equal((await api('/projects/'+primaryId+'/webdav','PUT',{slug:'../bad'})).status,400);
 const preserved=await json('/projects/'+primaryId+'/webdav','PUT',{enabled:true});assert.equal(preserved.slug,primarySettings.slug);check('duplicate/invalid slug rejected; ordinary save preserves',{slug:preserved.slug});
 const configs=await json('/storage-configs'),clouds=configs.filter(c=>c.enabled&&['QINIU','UPYUN'].includes(c.provider));
 for(const config of clouds){const before=await json('/storage-configs/'+config.id+'/projects');await json('/storage-configs/'+config.id+'/projects','PUT',{projectIds:[...new Set([...before.map(p=>p.id),primaryId])]});}
 check('test project bound to enabled real clouds without replacing existing bindings',{cloudProviders:clouds.map(c=>c.provider)});
 await exercise(primary,primarySettings,username,password,'acceptance'+Date.now().toString(36));
 const beforeSlug=primarySettings.slug,changed=await json('/projects/'+primaryId+'/webdav','PUT',{slug:'Mixed'+crypto.randomBytes(4).toString('hex')});assert.match(changed.slug,/^mixed[a-f0-9]+$/);assert.equal((await dav(base+'/api/dav/'+beforeSlug,username,password)('','PROPFIND',undefined,{depth:'0'})).status,404);
 const randomized=await json('/projects/'+primaryId+'/webdav','PUT',{slug:''});assert.match(randomized.slug,/^[a-f0-9]{24}$/);assert.notEqual(randomized.slug,changed.slug);assert.equal((await dav(base+'/api/dav/'+primaryId,username,password)('','PROPFIND',undefined,{depth:'0'})).status,207);
 report.projects[0].slug=randomized.slug;check('mixed custom address and clear regenerate; legacy ID remains',{finalSlug:randomized.slug});
 await json('/projects/'+primaryId+'/webdav','PUT',{enabled:false});assert.equal((await dav(base+'/api/dav/'+primaryId,username,password)('','PROPFIND',undefined,{depth:'0'})).status,404);await json('/projects/'+primaryId+'/webdav','PUT',{enabled:true});check('disabled DAV is inaccessible and can be reenabled',{projectId:primaryId});
 for(const f of report.files){let ready=false;for(let attempt=0;attempt<120;attempt++){const metadata=await json('/files/'+f.id+'/storage-replicas');if(metadata.items.filter(r=>r.desired&&r.enabled).every(r=>r.status==='READY'&&r.verifiedAt)){ready=true;f.storageKey=metadata.storageKey;f.providers=metadata.items.filter(r=>r.desired&&r.enabled).map(r=>r.provider);break;}await new Promise(r=>setTimeout(r,1000));}assert.ok(ready,'DAV current replicas ready');}
 check('DAV uploads synced to all selected storages',{files:report.files.map(f=>({id:f.id,providers:f.providers}))});
 if(credentials.davProjectId){
  const project=await json('/projects/'+credentials.davProjectId),settings=await json('/projects/'+credentials.davProjectId+'/webdav');assert.equal(settings.username,credentials.davUsername);assert.match(settings.slug,/^[a-z0-9]{1,64}$/);
  await exercise(project,settings,credentials.davUsername,credentials.davPassword,'davacceptance'+Date.now().toString(36));
  const request=dav(settings.baseUrl,credentials.davUsername,credentials.davPassword),sub=await request('sub/','PROPFIND',undefined,{depth:'1'});
  if(sub.status===207){const xml=await sub.text(),nodes=(xml.match(/<D:response>/g)||[]).length;if(nodes===1){assert.equal((await request('sub/','DELETE')).status,204);check('user probe sub directory removed after verifying empty',{nodes});}else check('user probe directory retained because nonempty',{nodes});}else check('user probe sub directory already absent',{status:sub.status});
 }
 report.counts={passed:report.checks.length,failed:0};report.finishedAt=new Date().toISOString();save();fs.writeFileSync(path.join(root,'.runtime/acceptance-20261114-webdav/'+(base.includes('localhost')?'local':'public')+'-latest.json'),JSON.stringify({out,projects:report.projects},null,2));
}catch(error){report.error=error.message;report.counts={passed:report.checks.length,failed:1};save();console.error(error.message);process.exitCode=1;}finally{if(cookie)await fetch(base+'/api/auth/logout',{method:'POST',headers:{cookie,'content-type':'application/json'},body:'{}'}).catch(()=>{});}})();
