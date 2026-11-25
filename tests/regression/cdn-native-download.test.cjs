const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {Readable,Writable}=require('node:stream');
require('ts-node').register({project:path.resolve(__dirname,'../../apps/api/tsconfig.json'),transpileOnly:true});
const {FilesController,PublicFilesController,PublicSharesController}=require('../../apps/api/src/files/files.controller.ts');
const {FilesService}=require('../../apps/api/src/files/files.service.ts');
const {requireVerifiedShareTarget}=require('../../apps/api/src/files/share-download-session.util.ts');
const file={id:'f',projectId:'p',storageKey:'p/file',status:'ACTIVE',size:4n,mimeType:'application/octet-stream',category:'OTHER',originalName:'原名.bin',checksum:'hash'};
function response(){const headers=new Map(),chunks=[];const r=new Writable({write(c,e,cb){chunks.push(Buffer.from(c));cb();}});r.setHeader=(k,v)=>headers.set(k.toLowerCase(),v);r.removeHeader=k=>headers.delete(k.toLowerCase());r.status=function(n){this.statusCode=n;return this};r.send=function(x){this.end(x);return this};r.json=function(x){this.payload=x;this.end(JSON.stringify(x));return this};r.redirect=function(url){this.statusCode=302;this.location=url;this.end();return this};return {r,headers,chunks};}
const request=query=>({query,headers:{},get:()=>undefined});
test('native admin resolution returns one same-origin JSON result and one source record',async()=>{
 let calls=0,records=0;const target={type:'redirect',url:'https://cdn.test/f?_upd=name',verified:true,contentLength:4,storageSource:{strategy:'CLOUD_PRIORITY',selected:{provider:'UPYUN',configName:'CDN'},attempts:[]}};
 const c=Object.create(FilesController.prototype);Object.assign(c,{filesService:{get:async()=>file,getDownloadTarget:async(id,user,range,options)=>{calls++;assert.equal(options?.preferRedirect,true);return {file,target}}},downloadStatsService:{record:()=>records++}});
 const {r,headers}=response();await c.download('f',{id:'u'},request({native:'1'}),r);assert.equal(headers.get('x-ufm-download-mode'),'redirect');assert.deepEqual(r.payload,{type:'redirect',url:target.url});assert.equal(r.statusCode,undefined);assert.equal(r.location,undefined);assert.equal(calls,1);assert.equal(records,1);
});
test('legacy admin blob download explicitly keeps verified server streaming',async()=>{
 const c=Object.create(FilesController.prototype);Object.assign(c,{filesService:{get:async()=>file,getDownloadTarget:async(id,user,range,options)=>{assert.equal(options?.preferRedirect,false);return {file,target:{type:'stream',stream:Readable.from(['data']),verified:true}}}},downloadStatsService:{record:()=>{}}});
 const {r,chunks}=response();const finished=new Promise(resolve=>r.on('finish',resolve));await c.download('f',{id:'u'},request({}),r);await finished;assert.equal(Buffer.concat(chunks).toString(),'data');
});
test('verified share redirects are accepted, but unverified and wrong-length URLs fail before quota',async()=>{
 const target={type:'redirect',url:'https://cdn.test/f',verified:true,contentLength:4,checksum:'hash'};assert.equal(await requireVerifiedShareTarget(target,4),target);
 await assert.rejects(requireVerifiedShareTarget({...target,verified:false},4));await assert.rejects(requireVerifiedShareTarget({...target,contentLength:5},4));
});
test('share response sends a verified full attachment redirect',async()=>{
 const c=Object.create(PublicSharesController.prototype),{r}=response();await c.writeShareFileResponse(r,file,{type:'redirect',url:'https://cdn.test/f?_upd=name',verified:true},'attachment',{size:4});assert.equal(r.statusCode,302);assert.equal(r.location,'https://cdn.test/f?_upd=name');
});
for(const [label,query,headers,prefer] of [['full attachment',{download:'1'},{},true],['range',{}, {range:'bytes=0-1'},false],['transform',{}, {},false]])test('public '+label+' selects redirect policy before the verified read',async()=>{
 let calls=0;const c=Object.create(PublicFilesController.prototype);Object.assign(c,{configService:{get:()=>''},filesService:{getPublicDownloadTarget:async(id,e,s,range,options)=>{calls++;assert.equal(options?.preferRedirect,prefer);if(query.download)assert.equal(options.attachment,true);return {file,target:{type:'stream',stream:Readable.from(['data']),verified:true},isOpenPublic:true}}},accessStatsService:{recordPublicAccess:()=>{}},downloadStatsService:{record:()=>{}}});c.enforcePublicAccessPolicy=async()=> 'open';
 const {r}=response();const finished=new Promise(resolve=>r.on('finish',resolve));await c.access('f',undefined,undefined,label==='transform'?'32':undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,{query,headers,get:()=>undefined},r);await finished;assert.equal(calls,1);
});

test('native stream downloads preserve JSON file contents without a redirect marker',async()=>{const c=Object.create(FilesController.prototype);Object.assign(c,{filesService:{get:async()=>file,getDownloadTarget:async()=>({file:{...file,mimeType:'application/json'},target:{type:'stream',verified:true,stream:Readable.from(['null'])}})},downloadStatsService:{record:()=>{}}});const {r,chunks,headers}=response();const finished=new Promise(resolve=>r.on('finish',resolve));await c.download('f',{id:'u'},request({native:'1'}),r);await finished;assert.equal(Buffer.concat(chunks).toString(),'null');assert.equal(headers.get('content-type'),'application/json');assert.equal(headers.has('x-ufm-download-mode'),false);});

test('password POST share downloads explicitly keep the stream for blob clients',async()=>{const c=Object.create(PublicSharesController.prototype);Object.assign(c,{filesService:{getShareDownloadTarget:async(token,password,meta)=>{assert.equal(meta.preferRedirect,false);return {file,shareId:'s',target:{type:'stream',verified:true,stream:Readable.from(['data'])},recordDownload:false}}}});const {r,chunks}=response();const finished=new Promise(resolve=>r.on('finish',resolve));await c.downloadWithPassword('s','password',{method:'POST',headers:{},get:()=>undefined},r);await finished;assert.equal(Buffer.concat(chunks).toString(),'data');});
