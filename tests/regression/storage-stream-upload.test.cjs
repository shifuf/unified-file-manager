const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createServer}=require('node:http');
const {mkdtemp,writeFile,rm}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join,resolve}=require('node:path');
const {createHash}=require('node:crypto');
require('ts-node').register({project:resolve(__dirname,'../../apps/api/tsconfig.json'),transpileOnly:true});
const {S3Adapter}=require('../../packages/storage-plugin-sdk/dist/s3.js');
const {UpyunAdapter}=require('../../plugins/upyun/index.ts');
const {LocalStorageAdapter}=require('../../apps/api/src/storage/adapters/local.adapter.ts');
for(const [name,Adapter,config] of [['S3',S3Adapter,{bucket:'bucket',accessKeyId:'test',secretAccessKey:'test',pathStyle:true}],['UPYUN',UpyunAdapter,{bucket:'bucket',operator:'test',password:'test'}]]) {
 test(`${name} uploads a disk object through its streaming transport with exact bytes`,async()=>{
  const data=Buffer.alloc(1024*1024+7,97), digest=createHash('sha256').update(data).digest('hex');
  const dir=await mkdtemp(join(tmpdir(),'ufm-stream-test-')); const file=join(dir,'object'); await writeFile(file,data);
  let received=0,serverHash;
  const server=createServer(async(req,res)=>{const hash=createHash('sha256');for await(const chunk of req){received+=chunk.length;hash.update(chunk);}serverHash=hash.digest('hex');res.writeHead(200);res.end();});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try { const endpoint=`http://127.0.0.1:${server.address().port}`;
   const result=await new Adapter().uploadFile({id:'cfg',provider:name,name,config:{...config,endpoint}},{key:'p/object',path:file,size:data.length,checksum:digest,mimeType:'application/octet-stream',originalName:'object'});
   assert.equal(result.storageKey,'p/object'); assert.equal(received,data.length); assert.equal(serverHash,digest);
  } finally {await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});}
 });
}
test('LOCAL upload never replaces an existing immutable key with different bytes',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ufm-immutable-test-')),adapter=new LocalStorageAdapter(),cfg={id:'local',provider:'LOCAL',name:'local',config:{root:dir}};
 try {await adapter.upload(cfg,{key:'p/object',buffer:Buffer.from('old'),mimeType:'text/plain',originalName:'object'});
  await assert.rejects(adapter.upload(cfg,{key:'p/object',buffer:Buffer.from('new'),mimeType:'text/plain',originalName:'object'}),/不可变|冲突/);
  const target=await adapter.getDownloadTarget(cfg,'p/object');let data='';for await(const c of target.stream)data+=c.toString();assert.equal(data,'old');
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('LOCAL disk copying cannot overwrite a different immutable object and can reuse identical bytes',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ufm-stream-immutable-test-')),adapter=new LocalStorageAdapter(),cfg={id:'local',provider:'LOCAL',name:'local',config:{root:dir}};
 try {const disk=join(dir,'source');await writeFile(disk,Buffer.from('new'));await adapter.upload(cfg,{key:'p/object',buffer:Buffer.from('old'),mimeType:'text/plain',originalName:'object'});
  const params={key:'p/object',path:disk,size:3,checksum:createHash('sha256').update('new').digest('hex'),mimeType:'text/plain',originalName:'object'};
  await assert.rejects(adapter.uploadFile(cfg,params),/不可变|冲突/);await writeFile(disk,Buffer.from('old'));params.checksum=createHash('sha256').update('old').digest('hex');await adapter.uploadFile(cfg,params);
  const target=await adapter.getDownloadTarget(cfg,'p/object');let data='';for await(const c of target.stream)data+=c.toString();assert.equal(data,'old');
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('UPYUN verifies newly uploaded bytes through authenticated origin while CDN still returns cached 404',async()=>{
 const data=Buffer.from('origin is ready before the CDN cache'),expected=createHash('sha256').update(data).digest('hex');let stored,originReads=0,cdnReads=0;
 const origin=createServer(async(req,res)=>{
  assert.equal(req.headers.authorization,'Basic dGVzdDp0ZXN0');assert.equal(req.url,'/bucket/p/object');
  if(req.method==='PUT'){const chunks=[];for await(const c of req)chunks.push(c);stored=Buffer.concat(chunks);res.writeHead(200);res.end();return;}
  originReads++;res.writeHead(200,{'Content-Type':'text/plain','Content-Length':stored.length});res.end(stored);
 });
 const cdn=createServer((req,res)=>{cdnReads++;res.writeHead(404);res.end('cached missing');});
 await Promise.all([new Promise(r=>origin.listen(0,'127.0.0.1',r)),new Promise(r=>cdn.listen(0,'127.0.0.1',r))]);
 try {
  const cfg={id:'upyun',provider:'UPYUN',name:'upyun',config:{bucket:'bucket',operator:'test',password:'test',endpoint:`http://127.0.0.1:${origin.address().port}`,domain:`http://127.0.0.1:${cdn.address().port}`}};
  const adapter=new UpyunAdapter();await adapter.upload(cfg,{key:'p/object',buffer:data,mimeType:'text/plain',originalName:'object'});
  assert.equal((await fetch(await adapter.getDownloadUrl(cfg,'p/object',600))).status,404);
  const target=await adapter.getDownloadTarget(cfg,'p/object');assert.equal(target.type,'stream');assert.equal(target.contentLength,data.length);
  const hash=createHash('sha256');for await(const c of target.stream)hash.update(c);assert.equal(hash.digest('hex'),expected);assert.equal(originReads,1);assert.equal(cdnReads,1);
 }finally{await Promise.all([new Promise(r=>origin.close(r)),new Promise(r=>cdn.close(r))]);}
});
test('UPYUN origin missing object raises 404 instead of returning an empty successful stream',async()=>{
 const server=createServer((req,res)=>{res.writeHead(404);res.end('not present');});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{await assert.rejects(new UpyunAdapter().getDownloadTarget({id:'upyun',provider:'UPYUN',name:'upyun',config:{bucket:'bucket',operator:'test',password:'test',endpoint:`http://127.0.0.1:${server.address().port}`}},'p/missing'),error=>error.getStatus()===404);}
 finally{await new Promise(r=>server.close(r));}
});
test('LOCAL repair quarantines only the captured corrupt object and publishes verified bytes while existing readers retain their inode',async()=>{
 const fs=require('node:fs'),fsp=require('node:fs/promises'),{once}=require('node:events');
 const dir=await mkdtemp(join(tmpdir(),'ufm-repair-test-')),adapter=new LocalStorageAdapter(),cfg={id:'local',provider:'LOCAL',name:'local',config:{root:dir}};
 let reader;
 try{
  const key='p/object',object=join(dir,key),source=join(dir,'source'),bad=Buffer.from('bad stored bytes'),good=Buffer.from('correct contents');await fsp.mkdir(join(dir,'p'));await writeFile(object,bad);await writeFile(source,good);
  const fingerprint=await adapter.getObjectFingerprint(cfg,key);reader=fs.createReadStream(object,{highWaterMark:4});await once(reader,'open');
  await adapter.repairFile(cfg,{key,path:source,size:good.length,checksum:createHash('sha256').update(good).digest('hex'),mimeType:'text/plain',originalName:'object'},fingerprint);
  assert.deepEqual(await fsp.readFile(object),good);const old=[];for await(const c of reader)old.push(c);assert.deepEqual(Buffer.concat(old),bad);
  const quarantine=await fsp.readdir(join(dir,'.ufm-quarantine'));assert.equal(quarantine.length,1);assert.deepEqual(await fsp.readFile(join(dir,'.ufm-quarantine',quarantine[0])),bad);
 }finally{reader?.destroy();await rm(dir,{recursive:true,force:true});}
});
test('LOCAL repair refuses a stale fingerprint and leaves concurrently published content untouched',async()=>{
 const fsp=require('node:fs/promises'),dir=await mkdtemp(join(tmpdir(),'ufm-repair-cas-test-')),adapter=new LocalStorageAdapter(),cfg={id:'local',provider:'LOCAL',name:'local',config:{root:dir}};
 try{
  const key='p/object',object=join(dir,key),source=join(dir,'source');await fsp.mkdir(join(dir,'p'));await writeFile(object,'bad');const fingerprint=await adapter.getObjectFingerprint(cfg,key);
  await fsp.unlink(object);await writeFile(object,'concurrent replacement');await writeFile(source,'good');
  await assert.rejects(adapter.repairFile(cfg,{key,path:source,size:4,checksum:createHash('sha256').update('good').digest('hex'),mimeType:'text/plain',originalName:'object'},fingerprint),/变化|冲突|修复/);
  assert.equal(await fsp.readFile(object,'utf8'),'concurrent replacement');
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('LOCAL repair rejects incorrect replacement bytes before isolating any original content',async()=>{
 const fsp=require('node:fs/promises'),dir=await mkdtemp(join(tmpdir(),'ufm-repair-verify-test-')),adapter=new LocalStorageAdapter(),cfg={id:'local',provider:'LOCAL',name:'local',config:{root:dir}};
 try{
  const key='p/object',object=join(dir,key),source=join(dir,'source');await fsp.mkdir(join(dir,'p'));await writeFile(object,'bad');await writeFile(source,'evil');const fingerprint=await adapter.getObjectFingerprint(cfg,key);
  await assert.rejects(adapter.repairFile(cfg,{key,path:source,size:4,checksum:createHash('sha256').update('good').digest('hex'),mimeType:'text/plain',originalName:'object'},fingerprint),/SHA256/);
  assert.equal(await fsp.readFile(object,'utf8'),'bad');
 }finally{await rm(dir,{recursive:true,force:true});}
});
