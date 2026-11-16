const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
require('ts-node').register({project:path.resolve(__dirname,'../../apps/api/tsconfig.json'),transpileOnly:true});
const {QiniuAdapter}=require('../../plugins/qiniu/index.ts');
const qiniu=require('qiniu');
const config={id:'qiniu-test',provider:'QINIU',name:'fixture',config:{accessKey:'fixture-ak',secretKey:'fixture-sk',bucket:'fixture',domain:'http://cdn.example.test'}};
test('Qiniu signed download addresses the original object path, not a base64 alias',async()=>{
 const u=new URL(await new QiniuAdapter().getDownloadUrl(config,'project/docs/file.txt',60));
 assert.equal(u.pathname,'/project/docs/file.txt');
 const token=u.searchParams.get('token');u.searchParams.delete('token');
 const sdk=new qiniu.rs.BucketManager(new qiniu.auth.digest.Mac('fixture-ak','fixture-sk'));
 const expected=new URL(sdk.privateDownloadUrl('http://cdn.example.test','project/docs/file.txt',Number(u.searchParams.get('e'))));
 assert.equal(token,expected.searchParams.get('token'));
});
test('Qiniu download key percent encodes Unicode, spaces and query characters once',async()=>{
 const u=new URL(await new QiniuAdapter().getDownloadUrl(config,'中文目录/a b#?.txt',60));
 assert.equal(decodeURIComponent(u.pathname),'/中文目录/a b#?.txt');
 assert.equal(u.searchParams.size,2);
});

test('Qiniu Unicode private download signature matches the SDK for the original key',async()=>{
 const key='博客系统/project/2026/10/28/40c3401a87a996fa-_.txt';
 const u=new URL(await new QiniuAdapter().getDownloadUrl(config,key,60));
 const sdk=new qiniu.rs.BucketManager(new qiniu.auth.digest.Mac('fixture-ak','fixture-sk'));
 const expected=new URL(sdk.privateDownloadUrl(config.config.domain,key,Number(u.searchParams.get('e'))));
 assert.equal(u.searchParams.get('token'),expected.searchParams.get('token'));
});
