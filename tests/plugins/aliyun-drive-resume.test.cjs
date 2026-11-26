const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { buildSync } = require('esbuild');

const CHUNK = 10 * 1024 * 1024;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const sha1 = value => createHash('sha1').update(value).digest('hex').toUpperCase();
let createAdapter;
function adapterFactory() {
  if (!createAdapter) {
    const root = mkdtempSync(path.join(tmpdir(), 'ufm-drive-resume-code-'));
    try {
      const out = path.join(root, 'index.cjs');
      buildSync({ entryPoints: [path.resolve(__dirname, '../../plugins/aliyun-drive/index.ts')], outfile: out, platform: 'node', format: 'cjs', bundle: true });
      createAdapter = require(out).createAdapter;
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
  return createAdapter;
}
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
function fixture(t, { count = 2, uploaded = [1], list, lostAcknowledgement = false } = {}) {
  const bytes = Buffer.alloc((count - 1) * CHUNK + 7, 23), key = 'project/immutable.bin';
  const scope = sha256('account-fixture\0drive-fixture\0root'), object = 'object-' + sha256(scope + '\0' + key);
  const sourceState = { fileId: 'upload-file', uploadId: 'upload-session', ready: false, size: bytes.length, checksum: sha256(bytes), sha1: sha1(bytes) };
  const metadata = Buffer.from('metadata'), metadataState = { fileId: 'meta-file', ready: true, size: metadata.length, checksum: sha256(metadata), sha1: sha1(metadata) };
  const states = new Map([
    ['account-account-fixture', { accountId: 'account-fixture', userId: 'fixture', refreshToken: 'refresh-fixture', accessToken: 'access-fixture', expiresAt: Date.now() + 3_600_000,
      deviceId: 'fixture-device', privateKey: '1'.repeat(64), drives: [] }],
    [object, sourceState], [object + '-metadata', metadataState],
  ]);
  const context = { getState: async key => structuredClone(states.get(key) ?? null), setState: async (key, value) => value === null ? states.delete(key) : states.set(key, structuredClone(value)), withLock: async (_, action) => action() };
  const remote = new Map([
    ['folder', { file_id: 'folder', parent_file_id: 'root', name: `UFM-objects-${scope.slice(0, 16)}`, type: 'folder', status: 'available' }],
    ['upload-file', { file_id: 'upload-file', parent_file_id: 'folder', name: sha256(key), type: 'file', status: 'uploading', size: 0 }],
    ['meta-file', { file_id: 'meta-file', parent_file_id: 'folder', name: sha256(key) + '.ufm.json', type: 'file', status: 'available', size: metadata.length, content_hash: sha1(metadata) }],
  ]);
  const parts = new Map(uploaded.map(number => [number, bytes.subarray((number - 1) * CHUNK, Math.min(number * CHUNK, bytes.length))]));
  const calls = { puts: [], urls: [], list: [], complete: 0 };
  const transport = async (input, init) => {
    const url = new URL(input), body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    if (init?.method === 'PUT') {
      const number = Number(url.searchParams.get('partNumber'));
      calls.puts.push(number);
      const chunks = [];
      for await (const chunk of init.body) chunks.push(Buffer.from(chunk));
      if (parts.has(number)) return new Response('<Error><Code>PartAlreadyExist</Code></Error>', { status: 409 });
      parts.set(number, Buffer.concat(chunks));
      if (lostAcknowledgement) { lostAcknowledgement = false; throw new TypeError('fetch failed after server accepted bytes'); }
      return new Response(null, { status: 200 });
    }
    if (url.pathname === '/v2/file/get') return remote.has(body.file_id) ? json(remote.get(body.file_id)) : json({ code: 'NotFound.File' }, 404);
    if (url.pathname === '/v2/file/list_uploaded_parts') {
      calls.list.push(body);
      if (list) return list(body, calls.list.length, parts);
      return json({ file_id: 'upload-file', upload_id: 'upload-session', parallel_upload: false,
        uploaded_parts: [...parts].map(([part_number, bytes]) => ({ part_number, part_size: bytes.length, etag: 'confirmed' })), next_part_number_marker: 0 });
    }
    if (url.pathname === '/v2/file/get_upload_url') {
      calls.urls.push(body.part_info_list.map(part => part.part_number));
      return json({ part_info_list: body.part_info_list.map(part => ({ ...part, upload_url: `https://fixture-data.aliyundrive.net/upload?partNumber=${part.part_number}` })) });
    }
    if (url.pathname === '/v2/file/complete') {
      calls.complete++;
      assert.equal(parts.size, count);
      const uploaded = Buffer.concat(Array.from({ length: count }, (_, index) => parts.get(index + 1)));
      assert.deepEqual(uploaded, bytes);
      Object.assign(remote.get('upload-file'), { status: 'available', size: uploaded.length, content_hash: sha1(uploaded) });
      return json(remote.get('upload-file'));
    }
    throw new Error(`Unexpected fixture route ${url.pathname}`);
  };
  const root = mkdtempSync(path.join(tmpdir(), 'ufm-drive-resume-data-')), source = path.join(root, 'source');
  writeFileSync(source, bytes);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const adapter = adapterFactory()(context, transport), config = { id: 'target', provider: 'ALIYUN_DRIVE', name: 'target', config: { accountId: 'account-fixture', driveId: 'drive-fixture' } };
  const params = { key, path: source, size: bytes.length, checksum: sha256(bytes), mimeType: 'application/octet-stream', originalName: 'source.bin' };
  return { adapter, config, params, calls, parts, states, object, remote, bytes };
}

test('sequential multipart resume skips confirmed chunks and only uploads missing bytes', async t => {
  const f = fixture(t);
  await f.adapter.uploadFile(f.config, f.params);
  assert.deepEqual(f.calls.puts, [2]);
  assert.deepEqual(f.calls.urls, [[2]]);
  assert.equal(f.calls.complete, 1);
  assert.equal(f.states.get(f.object).ready, true);
  await f.adapter.verifyBackup(f.config, f.params);
});

test('fully uploaded session completes without retransmitting any sequential chunk', async t => {
  const f = fixture(t, { uploaded: [1, 2] });
  await f.adapter.uploadFile(f.config, f.params);
  assert.deepEqual(f.calls.puts, []);
  assert.deepEqual(f.calls.urls, []);
  assert.equal(f.calls.complete, 1);
});

test('pagination confirms every uploaded part before choosing the missing tail', async t => {
  const f = fixture(t, { count: 3, uploaded: [1, 2], list: body => json({ file_id: 'upload-file', upload_id: 'upload-session', parallel_upload: false,
    uploaded_parts: [{ part_number: body.part_number_marker ? 2 : 1, part_size: CHUNK }], next_part_number_marker: body.part_number_marker ? 0 : 1 }) });
  await f.adapter.uploadFile(f.config, f.params);
  assert.deepEqual(f.calls.puts, [3]);
  assert.equal(f.calls.list.length, 2);
});

test('invalid confirmed part size, number, duplicate or session identity prevents all writes', async t => {
  for (const patch of [
    { uploaded_parts: [{ part_number: 1, part_size: 5 }] },
    { uploaded_parts: [{ part_number: 0, part_size: CHUNK }] },
    { uploaded_parts: [{ part_number: 3, part_size: CHUNK }] },
    { uploaded_parts: [{ part_number: 1, part_size: CHUNK }, { part_number: 1, part_size: CHUNK }] },
    { file_id: 'other-file' }, { upload_id: 'other-session' },
  ]) {
    const f = fixture(t, { list: () => json({ file_id: 'upload-file', upload_id: 'upload-session', uploaded_parts: [], ...patch }) });
    await assert.rejects(f.adapter.uploadFile(f.config, f.params), /分片|会话/);
    assert.deepEqual(f.calls.puts, []);
    assert.equal(f.calls.complete, 0);
  }
});

test('unsupported or expired uploaded-part listing fails clearly without overwriting known chunks', async t => {
  for (const code of ['UnsupportedOperation', 'NoSuchUpload']) {
    const f = fixture(t, { list: () => json({ code }, 400) });
    await assert.rejects(f.adapter.uploadFile(f.config, f.params), /已上传分片|上传会话/);
    assert.deepEqual(f.calls.puts, []);
    assert.equal(f.calls.complete, 0);
  }
});

test('invalid pagination markers stop resume before any upload', async t => {
  const f = fixture(t, { list: () => json({ file_id: 'upload-file', upload_id: 'upload-session', uploaded_parts: [], next_part_number_marker: 1 }) });
  await assert.rejects(f.adapter.uploadFile(f.config, f.params), /分片|分页/);
  assert.deepEqual(f.calls.puts, []);
});

test('lost PUT acknowledgement rechecks remote parts before sending the same sequential part again', async t => {
  const f = fixture(t, { lostAcknowledgement: true });
  await f.adapter.uploadFile(f.config, f.params);
  assert.deepEqual(f.calls.puts, [2]);
  assert.equal(f.calls.list.length, 2);
  assert.equal(f.calls.complete, 1);
});

test('full backup verification still rejects mismatched final remote hash after a resumed upload', async t => {
  const f = fixture(t);
  await f.adapter.uploadFile(f.config, f.params);
  f.remote.get('upload-file').content_hash = '0'.repeat(40);
  await assert.rejects(f.adapter.verifyBackup(f.config, f.params), /元数据|校验/);
});
