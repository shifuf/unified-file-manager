const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),{createHmac}=require('node:crypto');
require('ts-node').register({project:path.resolve(__dirname,'../../apps/api/tsconfig.json'),transpileOnly:true});
const {StorageService}=require('../../apps/api/src/storage/storage.service.ts');
const {FilesService}=require('../../apps/api/src/files/files.service.ts');
const {PublicFilesController}=require('../../apps/api/src/files/files.controller.ts');
test('private assets reject forged trusted source headers',async()=>{
 const c=new PublicFilesController({get:()=>''},{},{isHttpsRequired:async()=>false,getPublicFileAllowedDomains:async()=>['trusted.example']},{},{},{});
 const r={hostname:'files.example',secure:true,get:name=>name==='origin'?'https://trusted.example':name==='referer'?'https://trusted.example/article':undefined};
 await assert.rejects(c.enforcePublicAccessPolicy(r,{isOpenPublic:false,signatureValid:false,allowedDomains:['trusted.example']}),/签名|授权/);
});
test('expired signed URLs are rejected even with cryptographically valid tokens',()=>{
 const s=Object.create(StorageService.prototype),secret=process.env.PUBLIC_URL_SIGNING_KEY||process.env.JWT_SECRET||'local-development-secret';
 const expiry=Math.floor(Date.now()/1000)-10,signature=createHmac('sha256',secret).update(`ufm-public-file\nf\n${expiry}`).digest('base64url');
 assert.equal(s.verifyPublicAccess('f',expiry,signature),false);
});
test('temporary URL issuance enforces project scope and exposes stable canonical metadata separately',async()=>{
 const service=Object.create(FilesService.prototype),storage=Object.create(StorageService.prototype);
 service.storageService=storage;service.findFileForProject=async(id,project)=>{if(project!=='p')throw Error('project denied');return {id,status:'ACTIVE',isPublic:false}};
 const value=await service.getTemporaryAccessUrlForProject('f','p',300);
 const u=new URL(value.url,'https://files.example');assert.equal(u.pathname,'/api/public/files/f');assert.equal(storage.verifyPublicAccess('f',Number(u.searchParams.get('expires')),u.searchParams.get('signature')),true);
 await assert.rejects(service.getTemporaryAccessUrlForProject('f','other',300),/denied/);
 await assert.rejects(service.getTemporaryAccessUrlForProject('f','p',999999));
});
test('credential upload returns a signed preview while preserving the private canonical URL',async()=>{
 const service=Object.create(FilesService.prototype),storage=Object.create(StorageService.prototype);
 service.storageService=storage;
 service.uploadToProject=async()=>[{id:'f',status:'ACTIVE',isPublic:false,accessUrl:'/api/public/files/f',thumbnailUrl:'/api/public/files/f/thumbnail'},{id:'public',status:'ACTIVE',isPublic:true,accessUrl:'/api/public/files/public'}];
 const [privateFile,publicFile]=await service.uploadByCredential('p',[]);
 assert.equal(privateFile.accessUrl,'/api/public/files/f');assert.equal(privateFile.isPublic,false);
 const u=new URL(privateFile.previewUrl,'https://files.example');assert.equal(u.pathname,'/api/public/files/f');
 assert.equal(storage.verifyPublicAccess('f',Number(u.searchParams.get('expires')),u.searchParams.get('signature')),true);
 assert.match(privateFile.thumbnailUrl,/\/thumbnail\?expires=\d+&signature=/);
 assert.equal(publicFile.previewUrl,undefined);
});
test('authenticated upload checks project access before issuing private preview URLs',async()=>{
 const service=Object.create(FilesService.prototype);service.storageService=Object.create(StorageService.prototype);
 service.projectAccessService={assertProjectAccess:async()=>{throw Error('project denied')}};
 service.uploadToProject=async()=>[{id:'f',status:'ACTIVE',isPublic:false,accessUrl:'/api/public/files/f'}];
 await assert.rejects(service.upload('p',[],{id:'u'}),/project denied/);
 service.projectAccessService.assertProjectAccess=async()=>{};
 assert.match((await service.upload('p',[],{id:'u'}))[0].previewUrl,/\?expires=\d+&signature=/);
});
