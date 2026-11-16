const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Readable } = require('node:stream');
require('ts-node').register({ project: path.resolve(__dirname, '../../apps/api/tsconfig.json'), transpileOnly: true });
const { WebdavFileService } = require('../../apps/api/src/webdav/webdav-file.service.ts');
const { dispatchDav } = require('../../apps/api/src/webdav/webdav-verbs.ts');

function fixture() {
  const rows = [], events = [], quotas = [], folders = [];
  const account = { projectId: 'project-a', projectName: '备份', username: 'backup1' };
  const prisma = { managedFile: {
    findFirst: async () => null,
    create: async ({ data }) => {
      if (data.uploadedById != null && data.uploadedById !== 'real-user-id') {
        throw new Error('Foreign key constraint violated on the fields: (uploadedById)');
      }
      rows.push(data); return { id: 'file-created' };
    },
  } };
  const storage = { upload: async (_project, input) => ({ cdnConfigId: 'local', storageKey: input.key, publicUrl: 'https://files.example.test/file' }) };
  const service = new WebdavFileService(prisma, storage, { ensure: async (...args) => folders.push(args) }, { assertProjectQuota: async (...args) => quotas.push(args) }, { emit: (...args) => events.push(args) });
  return { account, service, rows, events, quotas, folders };
}

test('DAV PUT stores no synthetic DAV principal in the User foreign key and retains actor attribution', async () => {
  const f = fixture(), body = Buffer.from('中文备份 123');
  await f.service.writeFile(f.account, 'sub/test.txt', body, 'text/plain', 'webdav:backup1');
  assert.equal(f.rows.length, 1);
  assert.equal(f.rows[0].uploadedById ?? null, null);
  assert.equal(f.rows[0].projectId, 'project-a');
  assert.equal(f.rows[0].folderPath, 'sub');
  assert.equal(f.rows[0].size, BigInt(body.length));
  assert.equal(f.rows[0].checksum, require('node:crypto').createHash('sha256').update(body).digest('hex'));
  assert.equal(f.events[0][1].actorId, 'webdav:backup1');
  assert.equal(f.quotas[0][2], 'webdav:backup1');
  assert.equal(f.folders[0][2], 'webdav:backup1');
});

test('DAV PUT verb returns 201 after registering a file for a project account without a User row', async () => {
  const f = fixture(), request = Readable.from([Buffer.from('backup bytes')]);
  request.get = name => name === 'content-type' ? 'text/plain; charset=utf-8' : undefined;
  const response = { code: null, ended: false, status(code) { this.code=code; return this; }, end() { this.ended=true; return this; } };
  await dispatchDav({ fileService:f.service, treeService:{stat:async (_account,davPath) => davPath === 'sub' ? {isCollection:true}:null} }, 'PUT', f.account, 'sub/test.txt', request, response);
  assert.equal(response.code,201); assert.equal(response.ended,true); assert.equal(f.rows.length,1);
});
