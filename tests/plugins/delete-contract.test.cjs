const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
require('ts-node').register({project:path.resolve(__dirname,'../../apps/api/tsconfig.json'),transpileOnly:true});
const {QiniuAdapter}=require('../../plugins/qiniu/index.ts');
const {AliyunOssAdapter}=require('../../plugins/aliyun/index.ts');
const {UpyunAdapter}=require('../../plugins/upyun/index.ts');
const {S3Adapter}=require('../../packages/storage-plugin-sdk/dist/s3.js');
const {CloudflareR2Adapter}=require('../../plugins/cloudflare-r2/dist/index.cjs');
const config={id:'test',provider:'QINIU',name:'test',config:{bucket:'test',endpoint:'https://example.com',accessKeyId:'test',secretAccessKey:'test',accountId:'0123456789abcdef0123456789abcdef'}};

test('Qiniu delete and stat distinguish HTTP errors from missing objects even with a null SDK error',async()=>{
 const adapter=new QiniuAdapter();let code=403;
 adapter.manager=()=>({delete:(_b,_k,cb)=>cb(null,{}, {statusCode:code}),stat:(_b,_k,cb)=>cb(null,{}, {statusCode:code})});
 await assert.rejects(adapter.remove(config,'test-key'),/403/);await assert.rejects(adapter.objectExists(config,'test-key'),/403/);
 code=612;await adapter.remove(config,'test-key');assert.equal(await adapter.objectExists(config,'test-key'),false);
 code=200;await adapter.remove(config,'test-key');assert.equal(await adapter.objectExists(config,'test-key'),true);
});
test('OSS delete is idempotent for missing objects but rejects authorization and network failure',async()=>{
 const adapter=new AliyunOssAdapter();let error={status:404};adapter.client=()=>({delete:async()=>{if(error)throw error;},head:async()=>{if(error)throw error;}});
 await adapter.remove(config,'key');assert.equal(await adapter.objectExists(config,'key'),false);
 error={status:403};await assert.rejects(adapter.remove(config,'key'));await assert.rejects(adapter.objectExists(config,'key'));
 error=null;await adapter.remove(config,'key');assert.equal(await adapter.objectExists(config,'key'),true);
});
for(const provider of ['UPYUN','S3','CLOUDFLARE_R2'])test(`${provider} deletes the requested object, accepts absence and rejects failed deletes`,async()=>{
 let code=204;const requests=[];const transport=async(url,init)=>{requests.push([url,init.method]);return new Response(null,{status:code});};
 const adapter=provider==='UPYUN'?new UpyunAdapter():provider==='S3'?new S3Adapter('S3',transport):new CloudflareR2Adapter(transport);
 if(provider==='UPYUN')adapter.request=(_c,key,method)=>transport(key,{method});
 const c={...config,provider,config:{...config.config,endpoint:provider==='CLOUDFLARE_R2'?'':config.config.endpoint}};
 await adapter.remove(c,'own/key.txt');assert.equal(requests[0][1],'DELETE');assert(requests[0][0].includes('own/key.txt'));
 code=404;await adapter.remove(c,'own/key.txt');assert.equal(await adapter.objectExists(c,'own/key.txt'),false);
 code=403;await assert.rejects(adapter.remove(c,'own/key.txt'),/403/);await assert.rejects(adapter.objectExists(c,'own/key.txt'),/403/);
});
