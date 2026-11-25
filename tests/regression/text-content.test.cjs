const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { Readable } = require('node:stream');
require('ts-node').register({ project: path.resolve(__dirname, '../../apps/api/tsconfig.json'), transpileOnly: true });
const { FilesService } = require('../../apps/api/src/files/files.service.ts');

function fixture(overrides = {}) {
  let file = { id: 'f', projectId: 'p', originalName: 'script.py', mimeType: 'application/octet-stream', status: 'ACTIVE', size: 3n, storageKey: 'old', checksum: 'old', currentVersion: 1, isPublic: true, folderPath: 'code', ...overrides };
  const versions = [], uploads = [], accesses = [];
  const service = Object.create(FilesService.prototype);
  Object.assign(service, {
    projectAccessService: { assertProjectAccess: async (...args) => { accesses.push(args); } },
    prisma: {
      $queryRaw: async () => [],
      storageReplica: { findFirst: async () => null },
      managedFile: {
        findUnique: async () => ({ ...file }),
        updateMany: async ({ where, data }) => {
          if (!Object.entries(where).every(([k,v]) => file[k] === v)) return { count: 0 };
          file = { ...file, ...data }; return { count: 1 };
        },
      },
      project: { findUniqueOrThrow: async () => ({ name: 'project' }) },
      fileVersion: { findFirst: async () => versions.at(-1), upsert: async ({ create }) => { if (!versions.some(v=>v.version===create.version)) versions.push(create); } },
      fileDerivative: { updateMany: async () => ({ count: 0 }) },
    },
    storageService: {
      pruneFileVersions: async () => {},
      getDownloadTarget: async () => ({ type: 'stream', stream: Readable.from([Buffer.from('old')]) }),
      upload: async (_p, data) => { uploads.push(data); return { storageKey: `new-${uploads.length}`, cdnConfigId: 'local', publicUrl: null }; },
    },
    auditService: { write: async () => {} }, eventBus: { emit: () => {} },
  });
  service.prisma.$transaction = fn => fn(service.prisma);
  service.assertProjectQuota = async () => {};
  service.toResponse = f => ({ ...f, accessUrl: `/api/public/files/${f.id}` });
  return { service, versions, uploads, accesses, mutate: data => Object.assign(file, data) };
}
const user = { id: 'u' };
test('text editor reads Python with binary MIME using authenticated project access', async () => {
  const f = fixture(); const result = await f.service.getTextContent('f', user);
  assert.equal(result.content, 'old'); assert.equal(result.version, 1); assert.equal(f.accesses.length, 1);
});
test('each text save retains identity, archives old bytes and advances version, including empty content', async () => {
  const f = fixture();
  for (const [expectedVersion, content] of [[1, 'new'], [2, 'new'], [3, '']]) {
    const result = await f.service.updateTextContent('f', { content, expectedVersion }, user);
    assert.equal(result.id, 'f'); assert.equal(result.currentVersion, expectedVersion + 1);
    assert.equal(result.accessUrl, '/api/public/files/f'); assert.equal(result.isPublic, true);
    assert.equal(result.folderPath, 'code'); assert.equal(result.size, BigInt(Buffer.byteLength(content)));
  }
  assert.deepEqual(f.versions.map(v=>[v.version,v.storageKey]), [[1,'old'],[2,'new-1'],[3,'new-2']]);
  assert.ok(f.accesses.every(a=>a[2]===true));
});
test('stale text saves and recycled files are rejected before upload', async () => {
  const f = fixture();
  await assert.rejects(f.service.updateTextContent('f', { content: 'stale', expectedVersion: 2 }, user), e=>e.getStatus()===409);
  f.mutate({ status: 'RECYCLED' });
  await assert.rejects(f.service.updateTextContent('f', { content: 'stale', expectedVersion: 1 }, user));
  assert.equal(f.uploads.length, 0);
});
test('a recycle racing with upload cannot resurrect the file', async () => {
  const f=fixture(); const upload=f.service.storageService.upload;
  f.service.storageService.upload=async(...args)=>{ const result=await upload(...args); f.mutate({status:'RECYCLED'}); return result; };
  await assert.rejects(f.service.updateTextContent('f',{content:'new',expectedVersion:1},user),e=>e.getStatus()===409);
});
test('denied project management and quota failures do not upload or archive', async () => {
  for (const stage of ['permission', 'quota']) {
    const f=fixture();
    if(stage==='permission') f.service.projectAccessService.assertProjectAccess=async()=>{throw new Error('denied');};
    else f.service.assertProjectQuota=async()=>{throw new Error('quota');};
    await assert.rejects(f.service.updateTextContent('f',{content:'new',expectedVersion:1},user));
    assert.equal(f.uploads.length,0);assert.equal(f.versions.length,0);
  }
});
test('two concurrent saves based on the same version cannot both commit', async () => {
  const f=fixture();let waiting=0,release;
  const ready=new Promise(resolve=>{release=resolve;});const upload=f.service.storageService.upload;
  f.service.storageService.upload=async(...args)=>{const result=await upload(...args);if(++waiting===2)release();await ready;return result;};
  const results=await Promise.allSettled(['one','two'].map(content=>f.service.updateTextContent('f',{content,expectedVersion:1},user)));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(results.find(r=>r.status==='rejected').reason.getStatus(),409);
});
test('editor rejects binary formats, oversized content, invalid UTF-8 and NUL bytes', async () => {
  const binary=fixture({originalName:'file.pdf',mimeType:'application/pdf'});
  await assert.rejects(binary.service.getTextContent('f',user));
  const f=fixture();
  await assert.rejects(f.service.updateTextContent('f',{content:'x'.repeat(2*1024*1024+1),expectedVersion:1},user));
  for (const bytes of [Buffer.from([0xff]),Buffer.from([0])]) {
    f.service.storageService.getDownloadTarget=async()=>({type:'stream',stream:Readable.from([bytes])});
    await assert.rejects(f.service.getTextContent('f',user));
  }
  assert.equal(f.uploads.length,0);
});
test('share preview treats a successful JSON response as content even with error-like fields', async () => {
  const source=fs.readFileSync(path.resolve(__dirname,'../../apps/web/src/views/ShareAccess.vue'),'utf8');
  const fn=source.slice(source.indexOf('async function previewShare()'),source.indexOf('/**',source.indexOf('async function previewShare()')));
  const extra=source.includes('async function looksLikeJsonError') ? source.slice(source.indexOf('async function looksLikeJsonError'),source.indexOf('function onMediaError')) : '';
  const content='{"statusCode":500,"message":"legitimate document"}';
  const context={canSubmit:{value:true},previewing:{value:false},previewError:{value:''},previewText:{value:null},shareInfo:{value:{fileName:'update.json',size:content.length}},shareToken:{value:'t'},password:{value:''},unlocked:{value:false},publicShareApi:{preview:async()=>new Blob([content],{type:'application/json'})},isTextShare:()=>true,revokePreviewUrl:()=>{},setPreviewBlob:()=>{},ElMessage:{error:()=>{}},Blob};
  vm.createContext(context); vm.runInContext(ts.transpile(fn+extra),context); await context.previewShare();
  assert.equal(context.previewError.value,''); assert.equal(context.previewText.value,content);
});
