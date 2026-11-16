const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const vue = require('vue');

function fixture(boundary) {
  const calls = [], module = { exports: {} };
  const http = Object.fromEntries(['get', 'post', 'put', 'delete'].map(method => [method, async (url, body, options) => {
    calls.push({ method, url, body, options });
    return boundary({ method, url, body, options });
  }]));
  const source = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../../apps/web/src/api/modules.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(source, { module, exports: module.exports, Blob, FormData, Set, Math, Promise,
    require(name) { if (name === './http') return { http }; if (name === 'vue') return vue; throw new Error(name); },
  });
  return { ...module.exports, calls };
}
const error = status => Object.assign(new Error(`HTTP ${status}`), { response: { status } });
const file = Object.assign(new Blob(['abcdef'], { type: 'text/plain' }), { name: 'fixture.txt' });

for (const status of [404, 410]) test(`expired upload plan ${status} renews once and uploads retained file content`, async () => {
  let plans = 0;
  const f = fixture(({ url, body }) => {
    if (url.endsWith('/init')) return { uploadId: `plan-${++plans}`, received: [], totalChunks: 3 };
    if (url.includes('/plan-1/chunks/1')) throw error(status);
    if (url.endsWith('/complete')) return { id: 'uploaded-file', projectId: 'A' };
    return {};
  });
  const result = await f.fileApi.uploadResumable('A', file, { folderPath: 'fixed-folder', chunkSize: 2 });
  assert.equal(result.id, 'uploaded-file');
  assert.equal(plans, 2);
  assert.equal(f.calls.filter(c => c.url.includes('/plan-1/chunks/1')).length, 1, 'expired plan is not repeatedly retried');
  assert.deepEqual(f.calls.filter(c => c.url.includes('/plan-2/chunks/')).map(c => c.url.split('/').pop()), ['0', '1', '2']);
  for (const call of f.calls.filter(c => c.url.endsWith('/init'))) assert.equal(call.body.folderPath, 'fixed-folder');
  const chunk = f.calls.find(c => c.url.endsWith('/plan-2/chunks/1')).body.get('files');
  assert.equal(await chunk.text(), 'cd');
});

test('paused upload never renews an expired plan until continued', async () => {
  let paused = false, release, plans = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture(({ url }) => {
    if (url.endsWith('/init')) return { uploadId: `plan-${++plans}`, received: [], totalChunks: 1 };
    if (url.includes('/plan-1/chunks/0')) { paused = true; throw error(410); }
    if (url.endsWith('/complete')) return { id: 'finished' };
    return {};
  });
  const pending = f.fileApi.uploadResumable('A', file, { beforeTransfer: async () => { if (paused) await gate; } });
  pending.catch(() => {});
  while (!paused) await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(plans, 1);
  release();
  assert.equal((await pending).id, 'finished');
  assert.equal(plans, 2);
});

test('expired login waits for explicit resume and keeps the existing upload plan', async () => {
  let failed = false, plans = 0, prompted = false, release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture(({ url }) => {
    if (url.endsWith('/init')) { plans++; return { uploadId: 'same-plan', received: [], totalChunks: 1 }; }
    if (url.includes('/chunks/') && !failed) { failed = true; throw error(401); }
    if (url.endsWith('/complete')) return { id: 'finished' };
    return {};
  });
  const pending = f.fileApi.uploadResumable('A', file, { onAuthExpired: async () => { prompted = true; await gate; } });
  pending.catch(() => {});
  while (!prompted && !failed) await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(prompted, true);
  assert.equal(f.calls.filter(c => c.url.includes('/chunks/')).length, 1);
  release();
  assert.equal((await pending).id, 'finished');
  assert.equal(plans, 1);
  assert.equal(f.calls.filter(c => c.url.includes('/chunks/')).length, 2);
});
