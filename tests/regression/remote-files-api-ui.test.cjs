const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function apiFixture(http) {
  const filename = path.resolve(__dirname, '../../apps/web/src/api/remote-files.ts');
  const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports, require: name => {
    assert.equal(name, './http');
    return { http };
  }, setTimeout, clearTimeout, AbortController, DOMException }, { filename });
  return module.exports;
}
const result = { imported: 1, failed: 0, items: [{ id: 'file', name: '原始.txt', projectId: 'p1', status: 'IMPORTED' }] };
const job = (status, extra = {}) => ({ id: 'job-1', kind: 'IMPORT', status, ...extra });

test('remote import starts a short background request then polls until its result is complete', async () => {
  const calls = [];
  let polls = 0;
  const { remoteFilesApi } = apiFixture({
    post: async (url, body) => { calls.push({ method: 'POST', url, body }); return job('RUNNING'); },
    get: async url => { calls.push({ method: 'GET', url }); return ++polls === 1 ? job('RUNNING') : job('SUCCEEDED', { result }); },
  });
  const actual = await remoteFilesApi.import('cloud', { projectIds: ['p1'], fileIds: ['file'] });
  assert.deepEqual(actual, result);
  assert.equal(calls[0].url, '/storage-configs/cloud/remote-files/import-jobs');
  assert.deepEqual(calls.map(call => call.method), ['POST', 'GET', 'GET']);
  assert.ok(calls.slice(1).every(call => call.url === '/storage-configs/cloud/remote-files/jobs/job-1'));
});

test('poll disconnection retains the job id and resuming reads that job without a second import', async () => {
  let starts = 0, polls = 0;
  const api = apiFixture({ post: async () => { starts++; return job('RUNNING'); }, get: async () => {
    if (++polls === 1) throw { response: { status: 503, data: { message: '暂时不可用' } } };
    return job('SUCCEEDED', { result });
  } });
  const payload = { projectIds: ['p1'], fileIds: ['file'] };
  await assert.rejects(api.remoteFilesApi.import('cloud', payload), error => error.jobId === 'job-1' && /后台|继续查询/.test(error.message));
  assert.deepEqual(await api.remoteFilesApi.import('cloud', payload, { jobId: 'job-1' }), result);
  assert.equal(starts, 1);
});

test('failed and expired jobs surface safe errors and never restart themselves', async () => {
  for (const reason of ['FAILED', 'EXPIRED']) {
    let starts = 0;
    const { remoteFilesApi } = apiFixture({ post: async () => { starts++; return job('RUNNING'); }, get: async () => {
      if (reason === 'EXPIRED') throw { response: { status: 404, data: { message: '不存在' } } };
      return job('FAILED', { error: '云端内容校验失败。' });
    } });
    await assert.rejects(remoteFilesApi.import('cloud', { projectIds: ['p1'], fileIds: ['file'] }), reason === 'FAILED' ? /云端内容校验失败/ : /过期|重启/);
    assert.equal(starts, 1);
  }
});

test('aborting a running page stops polling without issuing another import or cancelling the background job', async () => {
  const controller = new AbortController();
  let starts = 0, polls = 0;
  const { remoteFilesApi } = apiFixture({ post: async () => { starts++; return job('RUNNING'); }, get: async () => { polls++; controller.abort(); return job('RUNNING'); } });
  await assert.rejects(remoteFilesApi.import('cloud', { projectIds: ['p1'], fileIds: ['file'] }, { signal: controller.signal }));
  assert.equal(starts, 1);
  assert.equal(polls, 1);
});

test('download preparation returns only the local verified job download URL after success', async () => {
  const calls = [];
  const { remoteFilesApi } = apiFixture({ post: async url => { calls.push(url); return { id: 'download-1', kind: 'DOWNLOAD', status: 'RUNNING' }; }, get: async url => {
    calls.push(url);
    return { id: 'download-1', kind: 'DOWNLOAD', status: 'SUCCEEDED', name: '原始.txt', size: 3 };
  } });
  const prepared = await remoteFilesApi.prepareDownload('cloud', 'file');
  assert.equal(prepared.name, '原始.txt');
  assert.equal(prepared.url, '/api/storage-configs/cloud/remote-files/jobs/download-1/download');
  assert.deepEqual(calls, ['/storage-configs/cloud/remote-files/file/download-jobs', '/storage-configs/cloud/remote-files/jobs/download-1']);
});
