const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
require('ts-node').register({ project:path.resolve(__dirname,'../../apps/api/tsconfig.json'),transpileOnly:true });
const { resolveWebdavSlug, throwWebdavSlugConflict } = require('../../apps/api/src/webdav/webdav-address.util.ts');
const { WebdavSettingsService } = require('../../apps/api/src/webdav/webdav-settings.service.ts');
const { WebdavAccountService } = require('../../apps/api/src/webdav/webdav-account.service.ts');
const { WebdavMiddleware } = require('../../apps/api/src/webdav/webdav.middleware.ts');
const { WebdavTreeService } = require('../../apps/api/src/webdav/webdav-tree.service.ts');
const { ProjectsService } = require('../../apps/api/src/projects/projects.service.ts');
const { dispatchDav } = require('../../apps/api/src/webdav/webdav-verbs.ts');

const freeDb=()=>({project:{findFirst:async()=>null}});
test('DAV custom address accepts digits, letters and mixed ASCII; random blank values differ',async()=>{
  for(const [input,expected] of [['123456','123456'],['Backup','backup'],['AbC123','abc123']])assert.equal(await resolveWebdavSlug(freeDb(),input,null,'p'),expected);
  const a=await resolveWebdavSlug(freeDb(),'',null,'p'),b=await resolveWebdavSlug(freeDb(),null,null,'p');
  assert.match(a,/^[a-f0-9]{24}$/);assert.match(b,/^[a-f0-9]{24}$/);assert.notEqual(a,b);
});
test('DAV omitted address preserves existing; clearing regenerates and invalid values never query database',async()=>{
  assert.equal(await resolveWebdavSlug(freeDb(),undefined,'backup123','p'),'backup123');
  assert.notEqual(await resolveWebdavSlug(freeDb(),'','backup123','p'),'backup123');
  for(const invalid of ['../x','a-b','a_b','中文','a/b','x'.repeat(65),123,['abc']]){
    await assert.rejects(()=>resolveWebdavSlug({project:{findFirst:()=>assert.fail('invalid value reached DB')}},invalid,null,'p'),e=>e.getStatus?.()===400);
  }
});
test('DAV collision checks include recycled projects and all other legacy project IDs',async()=>{
  let query;const db={project:{findFirst:async args=>{query=args;return {id:'other'};}}};
  await assert.rejects(()=>resolveWebdavSlug(db,'backup123',null,'p'),e=>e.getStatus?.()===409);
  assert.deepEqual(query.where.OR,[{webdavSlug:'backup123'},{id:'backup123'}]);assert.equal(query.where.deletedAt,undefined);assert.deepEqual(query.where.NOT,{id:'p'});
  assert.throws(()=>throwWebdavSlugConflict({code:'P2002',meta:{target:['webdavSlug']}}),e=>e.getStatus?.()===409);
  const unrelated={code:'P2002',meta:{target:['appId']}};assert.throws(()=>throwWebdavSlugConflict(unrelated),e=>e===unrelated);
});

function settingsFixture(){
  const state={id:'p',webdavEnabled:true,webdavUsername:'backup',webdavPasswordHash:'hash',webdavSlug:'old123'};
  const calls=[];const db={project:{findFirst:async args=>args.where.id==='p'?{...state}:null,update:async args=>{calls.push(args.data);Object.assign(state,args.data);return {...state};}}};
  const account={mountUrl:(id,slug)=>'https://files.example.test/api/dav/'+(slug||id),hashPassword:async()=>assert.fail('password unchanged'),vaultPassword:()=>assert.fail('vault unchanged')};
  return {state,calls,service:new WebdavSettingsService(account,{write:async()=>{}},db),db};
}
test('DAV settings reads canonical URL, updates custom slug and preserves credentials',async()=>{
  const f=settingsFixture();const before=await f.service.get('p');assert.equal(before.slug,'old123');assert.match(before.baseUrl,/old123$/);
  const changed=await f.service.update('p',{slug:'12345'},'admin');assert.equal(changed.slug,'12345');assert.match(changed.baseUrl,/12345$/);assert.equal(f.state.webdavPasswordHash,'hash');
  const kept=await f.service.update('p',{enabled:true},'admin');assert.equal(kept.slug,'12345');
  const random=await f.service.update('p',{slug:''},'admin');assert.match(random.slug,/^[a-f0-9]{24}$/);
});
test('project credential write includes validated slug atomically and does not touch it on unrelated edits',async()=>{
  const service=new ProjectsService({}, {get:()=>undefined},{},{},freeDb());
  const existing={webdavEnabled:true,webdavUsername:'backup',webdavPasswordHash:'hash',webdavSlug:'old123',id:'p'};
  const fields=await service.buildWebdavFields({webdavEnabled:true,webdavSlug:'Alpha123'},existing,'p');assert.equal(fields.webdavSlug,'alpha123');assert.equal(fields.webdavUsername,'backup');
  assert.deepEqual(await service.buildWebdavFields({name:'renamed'},existing,'p'),{});
});
test('DAV account resolves alias and legacy ID but never disabled or recycled projects',async()=>{
  const queries=[];const db={project:{findFirst:async args=>{queries.push(args);return {id:'p',name:'Project',webdavUsername:'backup',webdavPasswordHash:'hash',webdavSlug:'alias123',activeCdnConfigId:null};}}};
  const service=new WebdavAccountService({get:()=>''},db,{localRoot:()=>null},{getActiveStorage:async id=>{assert.equal(id,'p');return {provider:'LOCAL'};}});
  const alias=await service.loadAccount('alias123'),legacy=await service.loadAccount('p');
  assert.equal(alias.projectId,'p');assert.equal(alias.mountId,'alias123');assert.equal(legacy.mountId,'p');
  for(const q of queries){assert.equal(q.where.deletedAt,null);assert.equal(q.where.enabled,true);assert.equal(q.where.webdavEnabled,true);assert.ok(q.where.OR);}
  assert.match(service.mountUrl('p','alias123'),/\/api\/dav\/alias123$/);
});
test('alias middleware keeps actual project scope and PROPFIND href uses the requested mount',async()=>{
  const account={projectId:'p',mountId:'alias123',username:'backup',passwordHash:'hash'};
  const row={id:'f',originalName:'test.txt',folderPath:'sub',size:3n,mimeType:'text/plain',updatedAt:new Date(0)};
  const tree=new WebdavTreeService({},{});const xml=tree.propfindBody(account,{path:'sub/test.txt',name:'test.txt',isCollection:false,size:3,mimeType:'text/plain',updatedAt:new Date(0),fileId:'f'});assert.match(xml,/\/api\/dav\/alias123\/sub\/test.txt/);assert.ok(!xml.includes('/api/dav/p/'));
  let observed;const middleware=new WebdavMiddleware({loadAccount:async mount=>{assert.equal(mount,'alias123');return account;},verifyPassword:async()=>true},{},{},{stat:async (a,davPath)=>{observed={a,davPath};return null;}});
  const request={originalUrl:'/api/dav/alias123/sub/test.txt',method:'PROPFIND',headers:{authorization:'Basic '+Buffer.from('backup:fixture').toString('base64')},get:()=>undefined};
  const response={status(code){this.code=code;return this;},end(){return this;},setHeader(){}};
  await middleware.handle(request,response,()=>assert.fail('DAV was not handled'));assert.equal(observed.a.projectId,'p');assert.equal(observed.davPath,'sub/test.txt');assert.equal(response.code,404);void row;
});
test('COPY/MOVE accept the exact alias mount but reject prefixes and other project mounts',async()=>{
  const transfers=[];const deps={treeService:{stat:async()=>({isCollection:false})},fileService:{transferEntry:async(...args)=>transfers.push(args)}};
  const account={projectId:'p',mountId:'alias123'};
  for(const [destination,expected] of [['https://files.example.test/api/dav/alias123/sub/b.txt',201],['/api/dav/alias123evil/sub/b.txt',400],['/api/dav/other/sub/b.txt',400],['/api/dav/p/sub/b.txt',400]]){
    const response={status(code){this.code=code;return this;},end(){return this;}};
    await dispatchDav(deps,'COPY',account,'sub/a.txt',{get:name=>name==='destination'?destination:undefined},response);assert.equal(response.code,expected);
  }
  assert.equal(transfers.length,1);assert.equal(transfers[0][2],'sub/b.txt');assert.equal(transfers[0][0].projectId,'p');
});

test('DAV unexpected storage/database failures do not expose internal Prisma details in the HTTP body',async()=>{
  const account={projectId:'p',mountId:'alias123',username:'backup',passwordHash:'hash'};
  const middleware=new WebdavMiddleware({loadAccount:async()=>account,verifyPassword:async()=>true},{},{},{stat:async()=>{throw new Error('Invalid prisma.managedFile.create invocation Foreign key uploadedById private-path');}});
  const request={originalUrl:'/api/dav/alias123/file',method:'PROPFIND',headers:{authorization:'Basic '+Buffer.from('backup:fixture').toString('base64')},get:()=>undefined};
  const response={status(code){this.code=code;return this;},end(){return this;},send(body){this.body=body;return this;},setHeader(){}};
  await middleware.handle(request,response,()=>assert.fail());assert.equal(response.code,500);assert.ok(!/prisma|uploadedById|private-path/i.test(response.body));
});

test('DAV unique-constraint races in settings become 409 and never write a successful audit',async()=>{
  const f=settingsFixture();f.db.project.update=async()=>{throw {code:'P2002',meta:{target:'Project_webdavSlug_key'}};};
  await assert.rejects(()=>f.service.update('p',{slug:'race123'},'admin'),e=>e.getStatus?.()===409);assert.equal(f.state.webdavSlug,'old123');
});

test('DAV DTO validators reject slash/dash/Unicode and accept numeric or blank address',async()=>{
  const {validate}=require('class-validator');const {UpdateWebdavSettingsDto}=require('../../apps/api/src/webdav/dto/webdav-settings.dto.ts');
  for(const value of ['123','Alpha123','']){const dto=Object.assign(new UpdateWebdavSettingsDto(),{slug:value});assert.deepEqual(await validate(dto),[]);}
  for(const value of ['bad/path','a-b','中文',123]){const dto=Object.assign(new UpdateWebdavSettingsDto(),{slug:value});assert.ok((await validate(dto)).length>0);}
});
