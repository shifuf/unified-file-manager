const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createHash, createHmac } = require('node:crypto');
const fs = require('node:fs/promises');
require('ts-node').register({ project: path.resolve(__dirname, '../../apps/api/tsconfig.json'), transpileOnly: true });
require('reflect-metadata');
const { Module } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { ConfigService } = require('@nestjs/config');
const { OpenApiController } = require('../../apps/api/src/open-api/open-api.controller.ts');
const { OpenApiGuard } = require('../../apps/api/src/open-api/open-api.guard.ts');
const { PrismaService } = require('../../apps/api/src/prisma/prisma.service.ts');
const { FilesService } = require('../../apps/api/src/files/files.service.ts');
const { FolderManagerService } = require('../../apps/api/src/files/folder-manager.service.ts');
const { DownloadStatsService } = require('../../apps/api/src/files/download-stats.service.ts');
const { SettingsService } = require('../../apps/api/src/settings/settings.service.ts');
const { registerJsonBodyParsers } = require('../../apps/api/src/common/utils/json-body.util.ts');
const { encryptText } = require('../../apps/api/src/common/utils/crypto.util.ts');
const sdkModule = { exports: {} };
new Function('require', 'module', 'exports', require('typescript').transpileModule(require('node:fs').readFileSync(path.resolve(__dirname, '../../packages/sdk-js/src/index.ts'), 'utf8'), { compilerOptions: { module: require('typescript').ModuleKind.CommonJS, target: require('typescript').ScriptTarget.ES2022 } }).outputText)(require, sdkModule, sdkModule.exports);
const { UfmClient } = sdkModule.exports;
const { PublicFilesController } = require('../../apps/api/src/files/files.controller.ts');

async function fixture(t) {
  const secret = 'contract-test-secret', cryptoKey = 'contract-crypto-key';
  const project = { id: 'project', apiSecrets: [{ id: 'key', secretVault: encryptText(secret, cryptoKey) }], appSecretVault: '' };
  const seen = new Set(), files = new Map(); let counter = 0;
  const service = {
    withTemporaryPreviewUrls(file) { return file; },
    async uploadByCredential(projectId, uploads, options) {
      assert.equal(projectId, 'project');
      const result = [];
      for (const upload of uploads) {
        const bytes = await fs.readFile(upload.path); await fs.unlink(upload.path);
        const file = { id: `f${++counter}`, originalName: upload.originalname, size: bytes.length, isPublic: false, accessUrl: `/api/public/files/f${counter}`, folderPath: options.folderPath, duplicateStrategy: options.duplicateStrategy };
        files.set(file.id, file); result.push(file);
      }
      return result;
    },
    async updateForProject(id, projectId, dto) { assert.equal(projectId, 'project'); Object.assign(files.get(id), dto); return files.get(id); },
    async listByProject(query) { return { items: [...files.values()].filter(f => !query.keyword || f.originalName.includes(query.keyword)), total: files.size, page: query.page, pageSize: query.pageSize }; },
    async recycleForProject(id, projectId) { assert.equal(projectId, 'project'); files.get(id).status = 'RECYCLED'; return files.get(id); },
  };
  const prisma = { project: { findFirst: async () => project }, projectSecret: { update: async () => {} }, openApiNonce: { deleteMany: async () => {}, create: async ({ data }) => { assert(!seen.has(data.nonce)); seen.add(data.nonce); } } };
  class Fixture {}
  Module({ controllers: [OpenApiController], providers: [OpenApiGuard,
    { provide: ConfigService, useValue: { get: (key, fallback) => ({ NODE_ENV: 'test', APP_CRYPTO_KEY: cryptoKey }[key] ?? fallback) } },
    { provide: PrismaService, useValue: prisma }, { provide: FilesService, useValue: service },
    { provide: DownloadStatsService, useValue: {} }, { provide: FolderManagerService, useValue: {} },
    { provide: SettingsService, useValue: { getUploadLimits: async () => ({ maxFileSizeBytes: 1024, maxBatchUploadCount: 2 }) } },
  ] })(Fixture);
  const app = await NestFactory.create(Fixture, { logger: false, rawBody: true });
  app.setGlobalPrefix('api'); registerJsonBodyParsers(app); await app.listen(0, '127.0.0.1'); t.after(() => app.close());
  const base = await app.getUrl();
  return { base, files, client: new UfmClient({ baseUrl: base, appId: 'app', appSecret: secret }),
    async signed(method, route, body, signedBody = body) {
      const timestamp = String(Math.floor(Date.now()/1000)), nonce = require('node:crypto').randomUUID();
      const hash = createHash('sha256').update(signedBody ?? '').digest('hex');
      const signature = createHmac('sha256', secret).update([method, '/api/open/files'+route, timestamp, nonce, '', hash].join('\n')).digest('hex');
      return fetch(base+'/api/open/files'+route, { method, body, headers: { 'content-type':'application/json', 'x-app-id':'app', 'x-timestamp':timestamp, 'x-nonce':nonce, 'x-signature':signature } });
    } };
}

test('v2 authenticates exact JSON bytes for publication and rejects swapped bodies', async t => {
  const f = await fixture(t); f.files.set('f', { id: 'f', isPublic: false });
  let r = await f.signed('PUT', '/f', '{ "isPublic" : true }');
  assert.equal(r.status, 200, await r.text()); assert.equal(f.files.get('f').isPublic, true);
  r = await f.signed('PUT', '/f', '{"isPublic":false}', '{"isPublic":true}');
  assert.equal(r.status, 401); assert.equal(f.files.get('f').isPublic, true);
});

test('SDK uploads files field and signed query options, lists and recycles with v2', async t => {
  const f = await fixture(t);
  const [file] = await f.client.uploadFile(Buffer.from('hello'), { fileName:'blog.txt', mimeType:'text/plain', folderPath:'博客/附件 & images', duplicateStrategy:'reuse' });
  assert.equal(file.size, 5); assert.equal(file.isPublic, false); assert.equal(file.folderPath, '博客/附件 & images'); assert.equal(file.duplicateStrategy, 'reuse');
  await f.client.setPublic(file.id, true);
  const listed = await f.client.listFiles({ keyword:'blog', page:1, pageSize:10 }); assert.equal(listed.items[0].isPublic, true);
  await f.client.deleteFile(file.id); assert.equal(f.files.get(file.id).status, 'RECYCLED');
});

test('public gateway requires publication or a valid signature without a source header, including derivatives', async () => {
  const controller = new PublicFilesController({ get: () => undefined }, {}, { getPublicFileAllowedDomains: async () => [], isHttpsRequired: async () => false }, {}, {}, {});
  const request = { secure: true, hostname:'files.example', get: () => undefined };
  await assert.rejects(controller.enforcePublicAccessPolicy(request, { isOpenPublic:false, signatureValid:false, allowedDomains:[] }), error => error.getStatus() === 403);
  assert.equal(await controller.enforcePublicAccessPolicy(request, { isOpenPublic:true, signatureValid:false, allowedDomains:[] }), 'open');
  assert.equal(await controller.enforcePublicAccessPolicy(request, { isOpenPublic:false, signatureValid:true, allowedDomains:[] }), 'signed');
  let derivativeRead = false, status;
  controller.filesService = { getPublicDownloadTarget: async () => ({ target:{}, isOpenPublic:false, signatureValid:false, allowedDomains:[] }), getPublicDerivativeTarget: async () => { derivativeRead = true; } };
  const response = { headersSent:false, status(code) { status = code; return this; }, send() {} };
  await controller.accessDerivative('f', 'THUMB', { ...request, query:{}, params:{} }, response);
  assert.equal(status, 403); assert.equal(derivativeRead, false);
});
