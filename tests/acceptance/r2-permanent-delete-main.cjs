/* Writes and deletes only this run's isolated project and objects. Never prints credentials. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..');
const env=Object.fromEntries(fs.readFileSync(path.join(root,'.env'),'utf8').split(/\r?\n/).filter(s=>/^\w+=/.test(s)).map(s=>{const i=s.indexOf('=');return [s.slice(0,i),s.slice(i+1).trim().replace(/^['"]|['"]$/g,'')];}));Object.assign(process.env,env);
const {PrismaClient}=require('@prisma/client'),{ConfigService}=require('@nestjs/config');
require('../../apps/api/dist/common/utils/database-url.util.js').ensureDatabaseUrl();
const {StorageAdapterRegistry}=require('../../apps/api/dist/storage/storage-registry.service.js');
const {LocalStorageAdapter}=require('../../apps/api/dist/storage/adapters/local.adapter.js');
const {decryptText}=require('../../apps/api/dist/storage/crypto.util.js');
const db=new PrismaClient(),registry=new StorageAdapterRegistry(new LocalStorageAdapter(),new ConfigService(env));
let cookie;const api='http://localhost:3000/api';
const provider=process.env.TEST_STORAGE_PROVIDER||'CLOUDFLARE_R2';
async function req(url,method='GET',body){const r=await fetch(api+url,{method,headers:{cookie,...(body instanceof FormData?{}:{'content-type':'application/json'})},body:body instanceof FormData?body:body?JSON.stringify(body):undefined});if(!r.ok)throw Error(`${method} ${url}: ${r.status} ${(await r.text()).slice(0,250)}`);return r.json();}
function runtime(config){return {...config,config:Object.fromEntries(Object.entries(config.config).map(([k,v])=>[k,typeof v==='string'&&v.startsWith('vault:')?decryptText(v.slice(6),env.APP_CRYPTO_KEY||'local-development-crypto-key'):v]))};}
(async()=>{await registry.onModuleInit();
  const login=await fetch(api+'/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:env.ADMIN_USERNAME,password:env.ADMIN_PASSWORD})});assert.equal(login.status,201);cookie=login.headers.getSetCookie().map(s=>s.split(';')[0]).join('; ');
  const cloud=await db.cdnConfig.findFirst({where:{provider,enabled:true}});assert(cloud,'configured storage required');
  const project=await req('/projects','POST',{name:provider+'删除回归-'+Date.now()});
  await db.projectStorageBinding.create({data:{projectId:project.id,configId:cloud.id}});
  const form=new FormData(),bytes=Buffer.from('R2 permanent delete integration '+Date.now());form.append('files',new Blob([bytes]),'delete-test.txt');
  const [file]=await req(`/projects/${project.id}/files`,'POST',form);
  let rows=[];const deadline=Date.now()+90000;
  while(Date.now()<deadline){rows=await db.storageReplica.findMany({where:{projectId:project.id,storageKey:file.storageKey},include:{config:true}});if(rows.length>=2&&rows.every(r=>r.status==='READY'))break;await new Promise(r=>setTimeout(r,1000));}
  assert(rows.some(r=>r.configId===cloud.id&&r.status==='READY'),'R2 synchronization must complete');
  const record=await db.managedFile.findUnique({where:{id:file.id}});assert(record);
  // API response intentionally omits internal key; the test uses the DB-owned key.
  for(const row of rows)assert.equal(await registry.adapter(row.config.provider).objectExists(runtime(row.config),record.storageKey),true);
  await req('/files/'+file.id,'DELETE');
  await db.managedFile.update({where:{id:file.id},data:{purgeAt:new Date(0)}});
  const {FilesService}=require('../../apps/api/dist/files/files.service.js');
  const cleanup=Object.assign(Object.create(FilesService.prototype),{prisma:db});
  assert.deepEqual(await cleanup.purgeExpiredRecycledFiles(),{scanned:0,purged:0,failed:0});
  assert.equal(await registry.adapter(cloud.provider).objectExists(runtime(cloud),record.storageKey),true,'recycle retains R2 for restore');
  await req('/files/'+file.id+'/restore','POST',{});
  const download=await fetch(api+'/files/'+file.id+'/download',{headers:{cookie}});assert.equal(download.status,200);assert(Buffer.from(await download.arrayBuffer()).equals(bytes));
  await req('/files/'+file.id,'DELETE');await req('/files/'+file.id+'/purge','DELETE');
  for(const row of rows)assert.equal(await registry.adapter(row.config.provider).objectExists(runtime(row.config),record.storageKey),false,'physical object must be absent');
  assert.equal(await db.managedFile.count({where:{id:file.id}}),0);assert.equal(await db.storageReplica.count({where:{projectId:project.id}}),0);
  await req('/projects/'+project.id,'DELETE');
  fs.writeFileSync(path.join(root,`.runtime/plugin-work/${provider.toLowerCase()}-delete-result.json`),JSON.stringify({at:new Date().toISOString(),provider,projectId:project.id,fileId:file.id,checks:['real upload READY','expired recycle retains objects','restore exact bytes','confirmed permanent delete local and remote absence','metadata and replica queue removed'],passed:true},null,2));
  console.log(`PASS: ${provider} real upload, expired recycle retention, restore bytes, confirmed permanent deletion verified by provider HEAD, local removal and replica cleanup.`);
})().catch(e=>{console.error(e.message);process.exitCode=1;}).finally(async()=>{if(cookie)await req('/auth/logout','POST',{}).catch(()=>{});await db.$disconnect();});
