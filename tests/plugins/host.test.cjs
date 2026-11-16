const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs/promises');
const os=require('node:os');
const archiver=require('archiver');
require('ts-node').register({project:path.resolve(__dirname,'../../apps/api/tsconfig.json'),transpileOnly:true});
const manifest={id:'EXAMPLE',name:'Example',version:'1.0.0',apiVersion:1,entry:'index.cjs',fields:[],capabilities:{directUpload:false,usage:false}};
async function zip(entries){const a=archiver('zip');const chunks=[];a.on('data',c=>chunks.push(c));const done=new Promise((r,j)=>{a.on('end',r);a.on('error',j)});for(const [name,value]of Object.entries(entries))a.append(value,{name});await a.finalize();await done;return Buffer.concat(chunks);}
const code=`exports.createAdapter=()=>({provider:'EXAMPLE',upload:async(c,p)=>({storageKey:p.key}),uploadFile:async(c,p)=>({storageKey:p.key}),remove:async()=>{},objectExists:async()=>true,getDownloadUrl:async()=> 'https://example.com/object'})`;
test('host starts with no remote plugins; installs, reloads and uninstalls independent bundle',async()=>{
 const file=path.resolve(__dirname,'../../apps/api/src/storage/plugins/plugin-store.ts');assert.equal(require('node:fs').existsSync(file),true,'plugin store exists');
 const {PluginStore}=require(file);const root=await fs.mkdtemp(path.join(os.tmpdir(),'ufm-plugin-'));
 try {const store=new PluginStore(root);await store.load();assert.equal(store.list().length,0);await store.install(await zip({'storage-plugin.json':JSON.stringify(manifest),'index.cjs':code}));assert.equal(store.adapter('EXAMPLE').provider,'EXAMPLE');const again=new PluginStore(root);await again.load();assert.equal(await again.adapter('EXAMPLE').objectExists({config:{}},'a'),true);await again.uninstall('EXAMPLE');assert.equal(again.list().length,0);await assert.rejects(again.install(await zip({'storage-plugin.json':JSON.stringify({...manifest,id:'LOCAL'}),'index.cjs':code})));}finally{await fs.rm(root,{recursive:true,force:true});}
});
test('failed upgrade preserves the active version and malformed paths are rejected',async()=>{
 const file=path.resolve(__dirname,'../../apps/api/src/storage/plugins/plugin-store.ts');assert.equal(require('node:fs').existsSync(file),true,'plugin store exists');
 const {PluginStore}=require(file);const root=await fs.mkdtemp(path.join(os.tmpdir(),'ufm-plugin-'));
 try{const store=new PluginStore(root);await store.load();await store.install(await zip({'storage-plugin.json':JSON.stringify(manifest),'index.cjs':code}));await assert.rejects(store.install(await zip({'storage-plugin.json':JSON.stringify({...manifest,version:'2.0.0'}),'index.cjs':'exports.createAdapter=()=>({})'})));assert.equal(store.list()[0].version,'1.0.0');await assert.rejects(store.install(Buffer.from('bad zip')));assert.equal(store.list()[0].version,'1.0.0');}finally{await fs.rm(root,{recursive:true,force:true});}
});

test('archive rejects case aliases and nested entries before running plugin code',async()=>{
 const {unpack}=require('../../apps/api/src/storage/plugins/plugin-store.ts');
 await assert.rejects(unpack(await zip({'index.cjs':'ok','INDEX.CJS':'bad'})),/重复|路径/);
 await assert.rejects(unpack(await zip({'sub/index.cjs':'bad'})),/路径/);
 await assert.rejects(unpack(await zip({'package.zip':'bad'})),/路径/);
});
test('host applies manifest defaults and redacts custom secret values in plugin failures',async()=>{
 const {PluginStore}=require('../../apps/api/src/storage/plugins/plugin-store.ts');const root=await fs.mkdtemp(path.join(os.tmpdir(),'ufm-plugin-'));
 const m={...manifest,fields:[{key:'credential',label:'Credential',type:'string',secret:true},{key:'prefix',label:'Prefix',type:'string',default:'default-key'}]};
 const source=code.replace("upload:async(c,p)=>({storageKey:p.key})","upload:async(c,p)=>{if(c.config.credential)throw Error('bad '+c.config.credential);return {storageKey:c.config.prefix}}")
 try{const s=new PluginStore(root);await s.load();await s.install(await zip({'storage-plugin.json':JSON.stringify(m),'index.cjs':source}));const a=s.adapter('EXAMPLE');assert.equal((await a.upload({config:{}},{})).storageKey,'default-key');await assert.rejects(a.upload({config:{credential:'private-value'}},{}),e=>!e.message.includes('private-value'));}finally{await fs.rm(root,{recursive:true,force:true});}
});
