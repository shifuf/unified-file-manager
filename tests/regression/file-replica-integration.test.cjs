const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
require('ts-node').register({project:path.resolve(__dirname,'../../apps/api/tsconfig.json'),transpileOnly:true});
const {FilesService}=require('../../apps/api/src/files/files.service.ts');
function fixture() {
 const original={id:'file',projectId:'p',originalName:'old.txt',storageKey:'p/old',cdnConfigId:'local',cdnConfig:{id:'local'},size:3n,checksum:'old',status:'ACTIVE',currentVersion:1};
 const removed=[],snapshots=[];
 const service=Object.create(FilesService.prototype);
 Object.assign(service,{prisma:{managedFile:{findFirst:async()=>original,update:async({data})=>({...original,...data})}},storageService:{upload:async()=>({cdnConfigId:'local',storageKey:'p/new',publicUrl:null}),remove:async(c,key)=>removed.push(key)},auditService:{write:async()=>{}},eventBus:{emit:()=>{}},logger:{warn:()=>{}}});
 service.snapshotCurrentVersion=async(file)=>snapshots.push({...file});
 service.prisma.fileVersion={findFirst:async()=>({version:original.currentVersion})};
 let head=original;
 service.prisma.managedFile.updateMany=async({data})=>{head={...head,...data};return {count:1};};
 service.prisma.managedFile.findUnique=async()=>head;
 service.prisma.$transaction=async fn=>fn(service.prisma);
 service.prisma.fileDerivative={updateMany:async()=>({count:0})};
 service.toResponse=file=>file;
 service.buildStorageKey=()=> 'p/new';
 return {service,removed,snapshots};
}
test('overwrite retains the immutable object referenced by the saved historical version',async()=>{
 const f=fixture();
 const result=await f.service.replaceExistingFile({projectId:'p',projectName:'p',buffer:Buffer.from('new'),originalName:'new.txt',mimeType:'text/plain',size:3,folderPath:null,extension:'txt',category:'DOCUMENT',checksum:'new',targetFileId:'file'});
 assert.equal(result.currentVersion,2);
 assert.equal(f.snapshots[0].storageKey,'p/old');
 assert.deepEqual(f.removed,[],'a version must remain downloadable after replacement');
});
test('externally uploaded completion must materialize a verified local copy before metadata is accepted',async()=>{
 const f=fixture();
 f.service.prisma.project={findFirst:async()=>({id:'p',name:'p'})};
 f.service.prisma.managedFile.findFirst=async()=>null;
 f.service.prisma.managedFile.create=async({data})=>({id:'created',...data});
 f.service.storageService.objectExists=async()=>true;
 f.service.assertSafeStorageKey=()=>{};
 f.service.assertProjectQuota=async()=>{};
 const denied=new Error('cannot persist verified local copy');
 f.service.storageService.materializeUploadedObject=async()=>{throw denied;};
 await assert.rejects(f.service.registerUploadedObject({projectId:'p',storageKey:'p/new',originalName:'new.txt',mimeType:'text/plain',size:3,cdnConfigId:'cloud'}),error=>error===denied);
});
test('persisted cloud thumbnail and video URLs are exposed only through the unified public origin',()=>{
 const service=Object.create(FilesService.prototype);
 service.storageService={buildPublicAccessUrl:id=>'https://files.shifuf.com/api/public/files/'+id,buildPublicDerivativeUrl:(id,kind)=>'https://files.shifuf.com/api/public/files/'+id+'/derivatives/'+kind,absolutizeIfNeeded:value=>value};
 const f={id:'f',projectId:'p',status:'ACTIVE',category:'VIDEO',mimeType:'video/mp4',originalName:'v.mp4',size:1n,thumbnailUrl:'https://qn.shifuf.com/thumb',_videoDerivatives:[{kind:'MP4_720',status:'READY',storageKey:'p/mp4',publicUrl:'https://qn.shifuf.com/mp4'},{kind:'HLS',status:'READY',storageKey:'p/hls',publicUrl:'https://yp.shifuf.com/hls'}]};
 const result=service.toResponse(f);
 for(const key of ['publicUrl','thumbnailUrl','progressiveUrl','hlsUrl'])assert.ok(result[key].startsWith('https://files.shifuf.com/'),key+' must use unified domain');
});
test('video playback does not expose a READY derivative belonging to a previous source version',()=>{
 const s=Object.create(FilesService.prototype);s.storageService={buildPublicDerivativeUrl:()=>'/unexpected'};
 const f={id:'f',category:'VIDEO',status:'ACTIVE',storageKey:'new',checksum:'new-hash',currentVersion:2,_videoDerivatives:[{kind:'HLS',status:'READY',storageKey:'old/hls',meta:{sourceStorageKey:'old',sourceChecksum:'old-hash',sourceVersion:1}}]};
 assert.equal(s.resolveVideoDerivativeUrl(f,'HLS','/source'),null);
});
