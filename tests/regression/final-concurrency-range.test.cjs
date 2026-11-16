const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {Readable,Writable,PassThrough}=require('node:stream');
require('ts-node').register({project:path.resolve(__dirname,'../../apps/api/tsconfig.json'),transpileOnly:true});
const {FilesService}=require('../../apps/api/src/files/files.service.ts');
const {PublicFilesController}=require('../../apps/api/src/files/files.controller.ts');
const {sliceByteRange,pipeStreamToResponse}=require('../../apps/api/src/common/utils/http-range.util.ts');
const file={id:'f',projectId:'p',storageKey:'source',currentVersion:4,size:10n,checksum:'hash',cdnConfigId:'local',mimeType:'video/mp4',originalName:'v.mp4'};
test('simultaneous identical version snapshot survives MySQL upsert unique race',async()=>{
 const s=Object.create(FilesService.prototype);let audits=0;
 Object.assign(s,{prisma:{fileVersion:{upsert:async()=>{throw Object.assign(new Error('race'),{code:'P2002'});},findUnique:async()=>({...file,fileId:file.id,version:4})}},auditService:{write:async()=>audits++}});
 await s.snapshotCurrentVersion(file);assert.equal(audits,1);
});
test('canceling a range before its first read closes the verified source',async()=>{
 const source=new PassThrough(),wrapped=sliceByteRange(source,{start:5,end:9,size:20,length:5});wrapped.destroy();
 await new Promise(r=>setImmediate(r));assert.equal(source.destroyed,true);
});
test('browser disconnect closes a partially streamed range and its source',async()=>{
 const source=new PassThrough(),wrapped=sliceByteRange(source,{start:0,end:99,size:100,length:100});
 const destination=new Writable({write(c,e,cb){this.destroy();cb();}});pipeStreamToResponse(wrapped,destination,e=>assert.fail(e.message));source.write(Buffer.from('partial'));
 await new Promise(r=>setImmediate(r));assert.equal(destination.destroyed,true);assert.equal(wrapped.destroyed,true);assert.equal(source.destroyed,true);
});
test('unique collision with a different historical object reports conflict',async()=>{
 const s=Object.create(FilesService.prototype);
 Object.assign(s,{prisma:{fileVersion:{upsert:async()=>{throw Object.assign(new Error('race'),{code:'P2002'});},findUnique:async()=>({...file,storageKey:'different'})}},auditService:{write:async()=>assert.fail('must not audit failed snapshot')}});
 await assert.rejects(s.snapshotCurrentVersion(file),e=>e.getStatus?.()===409);
});
test('HLS child resource uses its verified size instead of master playlist size',async()=>{
 const s=Object.create(FilesService.prototype);
 Object.assign(s,{prisma:{managedFile:{findFirst:async()=>file},fileDerivative:{findUnique:async()=>({kind:'HLS',status:'READY',storageKey:'hls/master.m3u8',size:123n,meta:{segmentPrefix:'hls'}})}},storageService:{getDownloadTargetForKey:async()=>({type:'stream',stream:Readable.from(['segment']),verified:true,contentLength:12345})}});
 const result=await s.getPublicDerivativeTarget('f','HLS','480p/seg_000.ts');assert.equal(result.size,12345);result.target.stream.destroy();
});
function response(){const chunks=[],headers=new Map(),r=new Writable({write(c,e,cb){chunks.push(Buffer.from(c));cb();}});r.setHeader=(k,v)=>headers.set(k.toLowerCase(),v);r.removeHeader=k=>headers.delete(k.toLowerCase());r.status=n=>{r.statusCode=n;return r;};r.send=b=>{r.end(b);return r;};return {r,chunks,headers};}

test('public thumbnail header and history name the actual thumbnail storage', async () => {
 const source = (id, provider) => { const selected = { configId: id, configName: id, provider }; return { strategy: 'CLOUD_PRIORITY', selected, attempts: [{ ...selected, outcome: 'SELECTED' }] }; };
 const bytes = Buffer.from('thumbnail'), image = { ...file, category: 'IMAGE', mimeType: 'image/png' }, records = [];
 const c = new PublicFilesController({ get: () => '' }, { getPublicDownloadTarget: async () => ({ file: image, target: { type: 'stream', stream: Readable.from(['original']), storageSource: source('original-local', 'LOCAL') }, isOpenPublic: true }), getReadyThumbDerivative: async () => ({ storageKey: 'thumb', size: bytes.length, mimeType: 'image/webp' }) }, {}, { getDownloadTargetForKey: async () => ({ type: 'stream', stream: Readable.from([bytes]), storageSource: source('thumb-cloud', 'S3') }) }, { recordPublicAccess: () => {} }, { record: value => records.push(value) });
 c.enforcePublicAccessPolicy = async () => 'open';
 const { r, chunks, headers } = response(), finished = new Promise(resolve => r.on('finish', resolve));
 await c.access('f', undefined, undefined, '320', undefined, undefined, undefined, undefined, undefined, 'webp', undefined, { headers: {}, get: () => undefined }, r);
 await finished;
 assert.deepEqual(Buffer.concat(chunks), bytes);
 assert.equal(JSON.parse(decodeURIComponent(headers.get('x-ufm-download-storage'))).selected.configId, 'thumb-cloud');
 assert.equal(records.length, 1);
 assert.equal(records[0].storageSource.selected.configId, 'thumb-cloud');
 assert.equal(records[0].bytes, bytes.length);
});

test('public Range history matches the final range source instead of the initial source', async () => {
 const source = id => ({ strategy: 'CLOUD_PRIORITY', selected: { configId: id, configName: id, provider: 'S3' }, attempts: [] });
 const records = [], c = new PublicFilesController({ get: () => '' }, { getPublicDownloadTarget: async () => ({ file, target: { type: 'stream', stream: Readable.from(['0123456789']), storageSource: source('initial') }, isOpenPublic: true }) }, {}, { getDownloadTarget: async () => ({ type: 'stream', stream: Readable.from(['2345']), storageSource: source('range-cloud') }) }, { recordPublicAccess: () => {} }, { record: value => records.push(value) });
 c.enforcePublicAccessPolicy = async () => 'open';
 const { r, chunks, headers } = response(), finished = new Promise(resolve => r.on('finish', resolve));
 await c.access('f', undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { headers: { range: 'bytes=2-5' }, get: () => undefined }, r);
 await finished;
 assert.equal(Buffer.concat(chunks).toString(), '2345');
 assert.equal(records.length, 1);
 assert.equal(records[0].storageSource.selected.configId, 'range-cloud');
 assert.equal(JSON.parse(decodeURIComponent(headers.get('x-ufm-download-storage'))).selected.configId, 'range-cloud');
 assert.equal(records[0].bytes, 4);
 assert.equal(records[0].rangeStart, 2);
 assert.equal(records[0].rangeEnd, 5);
});

test('open API Range audit retains the final source and exact bounds', async () => {
 const { OpenApiController } = require('../../apps/api/src/open-api/open-api.controller.ts');
 const records = [], source = { strategy: 'CLOUD_PRIORITY', selected: { configId: 's3', configName: 'S3', provider: 'S3' }, attempts: [] };
 const c = new OpenApiController({ record: value => records.push(value) }, {
  getForProject: async () => file,
  getDownloadTargetForProject: async (_id, _project, range) => {
   assert.deepEqual(range, { start: 2, end: 5 });
   return { file, target: { type: 'stream', stream: Readable.from(['2345']), storageSource: source } };
  },
 }, {});
 const { r, chunks } = response(), finished = new Promise(resolve => r.on('finish', resolve));
 await c.download({ openProject: { id: 'p' }, headers: { range: 'bytes=2-5' }, get: () => undefined }, 'f', r);
 await finished; assert.equal(Buffer.concat(chunks).toString(), '2345');
 assert.equal(records.length, 1); assert.equal(records[0].rangeStart, 2); assert.equal(records[0].rangeEnd, 5);
 assert.equal(records[0].storageSource.selected.configId, 's3');
});
test('public derivative nonzero Range streams only requested bytes',async()=>{
 const bytes=Buffer.from('0123456789abcdef'),target=()=>({type:'stream',stream:Readable.from([bytes.subarray(0,5),bytes.subarray(5)]),contentLength:bytes.length,verified:true});
 const service={getPublicDownloadTarget:async()=>({file,isOpenPublic:true,allowedDomains:[],signatureValid:false,target:target()}),getPublicDerivativeTarget:async()=>({file,target:target(),size:bytes.length,mimeType:'video/mp4'})};
 const c=new PublicFilesController({get:()=>undefined},service,{}, {},{},{});c.enforcePublicAccessPolicy=async()=> 'public';c.applyPublicCacheHeaders=()=>{};
 const {r,chunks,headers}=response();const finished=new Promise((resolve,reject)=>{r.on('finish',resolve);r.on('error',reject);});
 await c.accessDerivative('f','MP4_720',{headers:{range:'bytes=6-10'},query:{},originalUrl:'/api/public/files/f/derivatives/MP4_720'},r);await finished;
 assert.equal(r.statusCode,206);assert.equal(headers.get('content-range'),'bytes 6-10/16');assert.deepEqual(Buffer.concat(chunks),bytes.subarray(6,11));
});
test('empty verified derivative rejects a byte range with its actual zero size',async()=>{
 const target=()=>({type:'stream',stream:Readable.from([]),contentLength:0,verified:true});
 const c=new PublicFilesController({get:()=>undefined},{getPublicDownloadTarget:async()=>({file,target:target()}),getPublicDerivativeTarget:async()=>({file,target:target(),size:0,mimeType:'text/plain'})},{},{},{},{});c.enforcePublicAccessPolicy=async()=> 'public';
 const {r,headers}=response();await c.accessDerivative('f','HLS',{headers:{range:'bytes=0-0'},query:{},originalUrl:'/api/public/files/f/derivatives/HLS'},r);
 assert.equal(r.statusCode,416);assert.equal(headers.get('content-range'),'bytes */0');
});
test('download preparation finishing after client disconnect releases its source immediately',async()=>{
 const source=new PassThrough(),destination=new Writable({write(c,e,cb){cb();}});destination.destroy();await new Promise(r=>setImmediate(r));
 pipeStreamToResponse(source,destination,e=>assert.fail(e.message));assert.equal(source.destroyed,true);
});
test('HLS nested playlist is registered as an actual HTTP route',async t=>{
 const {Module}=require('@nestjs/common'),{NestFactory}=require('@nestjs/core');
 const payload=Buffer.from('#EXTM3U\n#EXT-X-ENDLIST\n'),service={getPublicDownloadTarget:async()=>({file,target:{type:'stream',stream:Readable.from(['original'])},isOpenPublic:true,allowedDomains:[],signatureValid:false}),getPublicDerivativeTarget:async(id,kind,subPath)=>{assert.equal(kind,'HLS');assert.equal(subPath,'480p/index.m3u8');return {file,target:{type:'stream',stream:Readable.from([payload]),verified:true,contentLength:payload.length},size:payload.length,mimeType:'application/vnd.apple.mpegurl'};}};
 const deps=Reflect.getMetadata('design:paramtypes',PublicFilesController);class TestModule{};
 Module({controllers:[PublicFilesController],providers:deps.map((provide,i)=>({provide,useValue:i===0?{get:()=>undefined}:i===1?service:i===2?{isHttpsRequired:async()=>false}:{}}))})(TestModule);
 const app=await NestFactory.create(TestModule,{logger:false});app.setGlobalPrefix('api');await app.listen(0,'127.0.0.1');t.after(()=>app.close());
 const r=await fetch((await app.getUrl())+'/api/public/files/f/derivatives/HLS/480p/index.m3u8'),body=await r.text();assert.equal(r.status,200,body);assert.equal(body,payload.toString());
});
test('stable public file and derivative URLs must not cache old bytes after replacement',()=>{
 const c=new PublicFilesController({}, {}, {}, {}, {}, {}),{r,headers}=response();
 c.applyPublicCacheHeaders(r,'open');assert.match(headers.get('cache-control'),/no-store/);assert.doesNotMatch(headers.get('cache-control'),/stale-while-revalidate/);
});

test('original public response preserves no-store instead of overriding it with stale caching',()=>{
 const c=new PublicFilesController({}, {}, {}, {}, {}, {}),{r,headers}=response();
 c.applyOriginalCacheHeaders(r,{checksum:'current',size:10n},'current','open');
 assert.match(headers.get('cache-control'),/no-store/);
});

test('stored thumbnail public response is not immutable after same file ID replacement',async()=>{
 const bytes=Buffer.from('thumbnail'),image={...file,category:'IMAGE',mimeType:'image/png'};
 const c=new PublicFilesController({get:()=>''},{getPublicDownloadTarget:async()=>({file:image,target:{type:'stream',stream:Readable.from(['original'])},isOpenPublic:true}),getReadyThumbDerivative:async()=>({storageKey:'thumb',size:bytes.length,mimeType:'image/webp'})},{},{getDownloadTargetForKey:async()=>({type:'stream',stream:Readable.from([bytes])})},{recordPublicAccess:()=>{}},{record:()=>{}});
 c.enforcePublicAccessPolicy=async()=> 'open';
 const {r,chunks,headers}=response();const finished=new Promise(resolve=>r.on('finish',resolve));
 await c.access('f',undefined,undefined,'320',undefined,undefined,undefined,undefined,undefined,'webp',undefined,{headers:{},get:()=>undefined},r);
 await finished;assert.deepEqual(Buffer.concat(chunks),bytes);assert.match(headers.get('cache-control'),/no-store/);
});

test('transformed public image response cannot cache old bytes after replacement',async()=>{
 const sharp=require('sharp'),bytes=await sharp({create:{width:20,height:20,channels:3,background:'red'}}).png().toBuffer();
 const image={...file,category:'IMAGE',mimeType:'image/png',size:BigInt(bytes.length)};
 const target=()=>({type:'stream',stream:Readable.from([bytes])});
 const c=new PublicFilesController({get:()=>''},{getPublicDownloadTarget:async()=>({file:image,target:target(),isOpenPublic:true})},{},{getDownloadTarget:async()=>target()},{recordPublicAccess:()=>{}},{record:()=>{}});c.enforcePublicAccessPolicy=async()=> 'open';
 const {r,chunks,headers}=response();const finished=new Promise(resolve=>r.on('finish',resolve));
 await c.access('f',undefined,undefined,'10',undefined,undefined,undefined,undefined,undefined,'webp',undefined,{headers:{},get:()=>undefined},r);
 await finished;assert.match(headers.get('cache-control'),/no-store/);assert.equal((await sharp(Buffer.concat(chunks)).metadata()).width,16);
});
