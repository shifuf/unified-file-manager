const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { buildSync } = require('esbuild');
const source = path.resolve(__dirname, '../../plugins/aliyun-drive/index.ts');
let moduleUnderTest;
function plugin() {
  assert.ok(fs.existsSync(source), 'Node drive adapter implemented');
  if (!moduleUnderTest) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ufm-drive-code-'));
    const out = path.join(directory, 'plugin.cjs');
    buildSync({ entryPoints: [source], outfile: out, platform: 'node', format: 'cjs', bundle: true });
    moduleUnderTest = require(out);
    fs.rmSync(directory, { force: true, recursive: true });
  }
  return moduleUnderTest;
}
function context() {
  const values = new Map(), locks = new Map();
  return { values, async getState(key) { return structuredClone(values.get(key) ?? null); }, async setState(key, value) { value === null ? values.delete(key) : values.set(key, structuredClone(value)); }, async withLock(key, fn) {
    const pending = (locks.get(key) || Promise.resolve()).catch(() => {}).then(fn); locks.set(key, pending);
    try { return await pending; } finally { if (locks.get(key) === pending) locks.delete(key); }
  } };
}
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
function fakeProvider(downloadDomain = 'download-fixture.aliyuncs.com', uploadDomain = 'upload-fixture.aliyuncs.com') {
  const remote = new Map(); let nextId = 0, refreshes = 0, creates = 0, forbidden = false, emptyDelete = false, status = 'CONFIRMED';
  const transport = async (input, init = {}) => {
    const url = new URL(input), body = typeof init.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) : {};
    if (url.pathname === '/v2/oauth/authorize') return new Response('', { headers: { 'set-cookie': 'SESSIONID=fixture; Path=/; Secure; HttpOnly' } });
    if (url.pathname.endsWith('/qrcode/generate.do')) {
      assert.match(new Headers(init.headers).get('cookie') || '', /SESSIONID=fixture/);
      return json({ content: { success: true, data: { codeContent: 'https://example.com/qr', t: 'time', ck: 'secret-cookie' } } });
    }
    if (url.pathname.endsWith('/qrcode/query.do')) return json({ content: { success: true, data: { qrCodeStatus: status, bizExt: Buffer.from(JSON.stringify({ pds_login_result: { refreshToken: 'initial-refresh' } })).toString('base64') } } });
    if (url.pathname === '/v2/account/token') { refreshes++; return json({ access_token: `access-${refreshes}`, refresh_token: `refresh-${refreshes}`, user_id: 'user-one', nick_name: '测试账号', default_drive_id: 'drive-one', resource_drive_id: 'drive-one', expires_in: 7200 }); }
    if (url.pathname.endsWith('/device/create_session')) {
      assert.equal(body.pubKey.length, 130);
      assert.equal(new Headers(init.headers).get('x-signature').length, 130);
      return json({ result: true });
    }
    if (url.pathname === '/v2/user/get') return json({ user_id: 'user-one', nick_name: '测试账号', resource_drive_id: 'drive-one', backup_drive_id: 'backup-one' });
    if (url.pathname === '/v2/drive/list_my_drives') return json({ items: [{ drive_id: 'drive-one', drive_name: 'resource' }, { drive_id: 'backup-one', drive_name: 'backup' }] });
    if (url.pathname === '/v2/databox/get_personal_info') return json({ personal_space_info: { used_size: 100, total_size: 10000 } });
    if (forbidden) return json({ code: 'Forbidden', message: 'do not log me' }, 403);
    if (url.hostname === uploadDomain) {
      const item = remote.get(url.pathname.slice(1)); const chunks = [];
      for await (const chunk of init.body) chunks.push(Buffer.from(chunk));
      item.bytes = Buffer.concat([item.bytes || Buffer.alloc(0), ...chunks]); return new Response('', { status: 200 });
    }
    if (url.hostname === downloadDomain) {
      const data = remote.get(url.pathname.slice(1)).bytes;
      const range = /bytes=(\d+)-(\d*)/.exec(new Headers(init.headers).get('range') || '');
      if (!range) return new Response(data, { headers: { 'content-length': String(data.length) } });
      const start = +range[1], end = range[2] ? +range[2] : data.length - 1;
      return new Response(data.subarray(start, end + 1), { status: 206, headers: { 'content-range': `bytes ${start}-${end}/${data.length}`, 'content-length': String(end - start + 1) } });
    }
    if (url.pathname === '/v2/file/list') return json({ items: [...remote.values()].filter(x => x.parent_file_id === body.parent_file_id), next_marker: '' });
    if (url.pathname.includes('createWithFolders')) {
      creates++;
      const file_id = `file-${++nextId}`;
      const item = { ...body, file_id, status: body.type === 'folder' ? 'available' : 'uploading' };
      remote.set(file_id, item);
      return json({ ...item, upload_id: `upload-${nextId}`, part_info_list: (body.part_info_list || []).map(x => ({ ...x, upload_url: `https://${uploadDomain}/${file_id}` })) }, 201);
    }
    const item = remote.get(body.file_id);
    if (url.pathname === '/v2/file/delete') { remote.delete(body.file_id); return emptyDelete ? new Response(null, { status: 204 }) : json({}); }
    if (!item) return json({ code: 'NotFound.File' }, 404);
    if (url.pathname === '/v2/file/get') return json(item);
    if (url.pathname === '/v2/file/complete') { item.status = 'available'; return json(item); }
    if (url.pathname === '/v2/file/get_download_url') return json({ url: `https://${downloadDomain}/${body.file_id}` });
    throw new Error(`unexpected route ${url.pathname}`);
  };
  return { transport, remote, get refreshes() { return refreshes; }, get creates() { return creates; }, setForbidden(value) { forbidden = value; }, setEmptyDelete(value) { emptyDelete = value; }, setStatus(value) { status = value; } };
}
async function login(adapter) {
  const session = await adapter.startLogin();
  const result = await adapter.pollLogin(session.sessionId);
  assert.equal(result.status, 'CONFIRMED');
  return { session, account: result.account };
}

test('QR login keeps credentials server-side, handles scanned/canceled/expired sessions and survives restart', async () => {
  const state = context(), remote = fakeProvider();
  const adapter = plugin().createAdapter(state, remote.transport);
  const session = await adapter.startLogin();
  assert.equal(session.qrCode, 'https://example.com/qr');
  remote.setStatus('SCANED');
  assert.deepEqual(await adapter.pollLogin(session.sessionId), { status: 'SCANNED' });
  remote.setStatus('CONFIRMED');
  const result = await adapter.pollLogin(session.sessionId);
  assert.equal(result.account.name, '测试账号');
  assert.ok(!JSON.stringify(result).includes('refresh-'));
  const restarted = plugin().createAdapter(state, remote.transport);
  assert.equal((await restarted.accountStatus(result.account.accountId)).connected, true);
  const canceled = await adapter.startLogin(); await adapter.cancelLogin(canceled.sessionId);
  assert.equal((await adapter.pollLogin(canceled.sessionId)).status, 'EXPIRED');
  const expired = await adapter.startLogin(); remote.setStatus('EXPIRED');
  assert.equal((await adapter.pollLogin(expired.sessionId)).status, 'EXPIRED');
});

test('backup lifecycle preserves immutable keys, reuses uploads and never treats forbidden as missing', async () => {
  const state = context(), remote = fakeProvider(), adapter = plugin().createAdapter(state, remote.transport);
  const { account } = await login(adapter);
  const config = { id: 'config1', name: 'test', provider: 'ALIYUN_DRIVE', config: { accountId: account.accountId, driveId: 'drive-one', rootFolderId: 'root' } };
  const bytes = Buffer.from('中文 hello immutable file'), key = '项目/目录/对象.txt';
  const result = await adapter.upload(config, { key, buffer: bytes, originalName: '对象.txt', mimeType: 'text/plain' });
  assert.equal(result.storageKey, key);
  const count = remote.creates;
  await adapter.upload(config, { key, buffer: bytes, originalName: '对象.txt', mimeType: 'text/plain' });
  assert.equal(remote.creates, count);
  await assert.rejects(adapter.upload(config, { key, buffer: Buffer.from('different'), originalName: '对象.txt', mimeType: 'text/plain' }));
  await adapter.verifyBackup(config, { key, size: bytes.length, checksum: crypto.createHash('sha256').update(bytes).digest('hex') });
  await assert.rejects(adapter.getDownloadTarget(config, key), /仅.*备份/);
  await assert.rejects(adapter.getDownloadUrl(config, key, 60), /仅.*备份/);
  remote.setForbidden(true);
  await assert.rejects(adapter.objectExists(config, key));
  remote.setForbidden(false);
  await adapter.remove(config, key); assert.equal(await adapter.objectExists(config, key), false);
  await adapter.remove(config, key);
  assert.equal((await adapter.getUsage(config)).storageQuotaBytes, 10000);
});

test('concurrent expired credentials refresh once and persist the rotated token', async () => {
  const state = context(), remote = fakeProvider(), adapter = plugin().createAdapter(state, remote.transport);
  const { account } = await login(adapter);
  const stateKey = `account-${account.accountId}`;
  const saved = await state.getState(stateKey); saved.expiresAt = 0; await state.setState(stateKey, saved);
  const before = remote.refreshes;
  await Promise.all(Array.from({ length: 8 }, () => adapter.accountStatus(account.accountId)));
  assert.equal(remote.refreshes, before + 1);
  assert.equal((await state.getState(stateKey)).refreshToken, `refresh-${remote.refreshes}`);
});

test('purge removes its mapped object even if moved to the remote recycle bin and accepts an empty 204', async () => {
  const state = context(), remote = fakeProvider(), adapter = plugin().createAdapter(state, remote.transport);
  const { account } = await login(adapter);
  const config = { id: 'purge', provider: 'ALIYUN_DRIVE', name: 'purge', config: { accountId: account.accountId, driveId: 'drive-one' } };
  await adapter.upload(config, { key: 'purge-key', buffer: Buffer.from('test bytes'), originalName: 'test', mimeType: 'text/plain' });
  const object = [...remote.remote.values()].find(item => item.type === 'file');
  object.trashed = true;
  assert.equal(await adapter.objectExists(config, 'purge-key'), false);
  remote.setEmptyDelete(true);
  await adapter.remove(config, 'purge-key');
  assert.equal(remote.remote.has(object.file_id), false);
});

test('reauthentication waits for a concurrent credential update before writing rotated tokens', async () => {
  const state = context(), remote = fakeProvider(), adapter = plugin().createAdapter(state, remote.transport);
  const { account } = await login(adapter);
  const session = await adapter.startLogin(account.accountId);
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const writer = state.withLock(`token-${account.accountId}`, async () => { entered(); await gate; });
  await ready;
  const before = await state.getState(`account-${account.accountId}`);
  const poll = adapter.pollLogin(session.sessionId);
  try {
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal((await state.getState(`account-${account.accountId}`)).refreshToken, before.refreshToken,
      'an active credential writer protects the saved refresh token');
  } finally { release(); await writer; await poll; }
});

test('disk uploads read all chunks across a part boundary and reject changed source checksums', async () => {
  const state = context(), remote = fakeProvider(), adapter = plugin().createAdapter(state, remote.transport);
  const { account } = await login(adapter);
  const config = { id: 'parts', provider: 'ALIYUN_DRIVE', name: 'parts', config: { accountId: account.accountId, driveId: 'drive-one' } };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ufm-drive-parts-'));
  try {
    const bytes = Buffer.alloc(10 * 1024 * 1024 + 17, 0x51); bytes[bytes.length - 1] = 0x39;
    const file = path.join(directory, 'source'); fs.writeFileSync(file, bytes);
    const params = { key: 'parts-key', path: file, size: bytes.length, checksum: crypto.createHash('sha256').update(bytes).digest('hex'), originalName: 'large.bin', mimeType: 'application/octet-stream' };
    await adapter.uploadFile(config, params);
    const object = [...remote.remote.values()].find(item => item.type === 'file');
    assert.deepEqual(object.bytes, bytes);
    assert.equal(object.part_info_list.length, 2);
    await assert.rejects(adapter.uploadFile(config, { ...params, key: 'bad-key', checksum: '0'.repeat(64) }), /SHA256/);
    assert.equal([...remote.remote.values()].filter(item => item.type === 'file').length, 1);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('backup confirmation checks available status, size and remote SHA1 without any content download', async () => {
  const state = context(), remote = fakeProvider(); let contentReads = 0;
  const transport = async (url, init) => {
    if (new URL(url).hostname.startsWith('download-') || new URL(url).pathname.includes('get_download_url')) {
      contentReads++; throw new Error('Content reads forbidden');
    }
    return remote.transport(url, init);
  };
  const adapter = plugin().createAdapter(state, transport), { account } = await login(adapter);
  const config = { id: 'metadata', provider: 'ALIYUN_DRIVE', name: 'backup', config: { accountId: account.accountId, driveId: 'drive-one' } };
  const bytes = Buffer.from('metadata confirmed backup');
  const params = { key: 'metadata-key', size: bytes.length, checksum: crypto.createHash('sha256').update(bytes).digest('hex') };
  await adapter.upload(config, { key: params.key, buffer: bytes, mimeType: 'text/plain', originalName: 'backup.txt' });
  await adapter.verifyBackup(config, params);
  const object = [...remote.remote.values()].find(item => item.type === 'file');
  for (const patch of [{ size: bytes.length + 1 }, { content_hash: '0'.repeat(40) }, { status: 'uploading' }, { trashed: true }]) {
    const before = { ...object }; Object.assign(object, patch);
    await assert.rejects(adapter.verifyBackup(config, params)); Object.assign(object, before);
  }
  await assert.rejects(adapter.verifyBackup(config, { ...params, checksum: '0'.repeat(64) }));
  await assert.rejects(adapter.getDownloadTarget(config, params.key), /仅.*备份/);
  await assert.rejects(adapter.getDownloadUrl(config, params.key, 60), /仅.*备份/);
  assert.equal(contentReads, 0);
});

test('resumes a persisted upload when remote metadata reports zero bytes until completion', async () => {
  const state = context(), remote = fakeProvider();
  let failPart = true;
  const transport = async (url, init) => {
    if (new URL(url).hostname === 'upload-fixture.aliyuncs.com' && failPart) return json({ code: 'PartRejected' }, 400);
    if (new URL(url).pathname === '/v2/file/get_upload_url') {
      const body = JSON.parse(init.body);
      return json({ part_info_list: body.part_info_list.map(part => ({ ...part, upload_url: `https://upload-fixture.aliyuncs.com/${body.file_id}` })) });
    }
    return remote.transport(url, init);
  };
  const adapter = plugin().createAdapter(state, transport), { account } = await login(adapter);
  const config = { id: 'resume', provider: 'ALIYUN_DRIVE', name: 'resume', config: { accountId: account.accountId, driveId: 'drive-one' } };
  const params = { key: 'resume-key', buffer: Buffer.from('resume exact immutable bytes'), mimeType: 'text/plain', originalName: 'resume.txt' };
  await assert.rejects(adapter.upload(config, params));
  const object = [...remote.remote.values()].find(item => item.type === 'file');
  object.size = 0;
  failPart = false;
  const creates = remote.creates;
  await adapter.upload(config, params);
  assert.equal(remote.creates, creates);
  assert.deepEqual(object.bytes, params.buffer);
  assert.equal(object.status, 'available');
});

test('multipart upload accepts actual aliyundrive.net data hosts and rejects lookalikes', async () => {
  for (const [domain, allowed] of [['cn-beijing-data.aliyundrive.net', true], ['aliyundrive.net.evil.example', false], ['fakealiyundrive.net', false]]) {
    const state = context(), remote = fakeProvider('download-fixture.aliyuncs.com', domain), adapter = plugin().createAdapter(state, remote.transport);
    const { account } = await login(adapter);
    const config = { id: 'data-host', provider: 'ALIYUN_DRIVE', name: 'data-host', config: { accountId: account.accountId, driveId: 'drive-one' } };
    const params = { key: 'data-host-key', buffer: Buffer.from('real multipart upload'), originalName: 'data.bin', mimeType: 'application/octet-stream' };
    if (allowed) {
      await adapter.upload(config, params);
      assert.deepEqual([...remote.remote.values()].find(item => item.type === 'file').bytes, params.buffer);
    } else await assert.rejects(adapter.upload(config, params), /传输地址无效/);
  }
});
