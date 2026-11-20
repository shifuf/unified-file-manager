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
  const remote = new Map(), moves = [], deletes = []; let nextId = 0, refreshes = 0, creates = 0, forbidden = false, emptyDelete = false, status = 'CONFIRMED';
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
    if (url.pathname === '/v2/file/delete') { deletes.push(body.file_id); remote.delete(body.file_id); return emptyDelete ? new Response(null, { status: 204 }) : json({}); }
    if (!item) return json({ code: 'NotFound.File' }, 404);
    if (url.pathname === '/v3/file/move') {
      assert.equal(body.drive_id, 'drive-one');
      assert.equal(body.check_name_mode, 'refuse');
      assert.equal(remote.get(body.to_parent_file_id)?.type, 'folder');
      if ([...remote.values()].some(entry => entry.file_id !== item.file_id && entry.parent_file_id === body.to_parent_file_id && entry.name === item.name)) return json({ code: 'AlreadyExist.File' }, 409);
      moves.push({ ...body }); item.parent_file_id = body.to_parent_file_id; return json(item);
    }
    if (url.pathname === '/v2/file/get') return json(item);
    if (url.pathname === '/v2/file/complete') { item.status = 'available'; return json(item); }
    if (url.pathname === '/v2/file/get_download_url') return json({ url: `https://${downloadDomain}/${body.file_id}` });
    throw new Error(`unexpected route ${url.pathname}`);
  };
  return { transport, remote, moves, deletes, get refreshes() { return refreshes; }, get creates() { return creates; }, setForbidden(value) { forbidden = value; }, setEmptyDelete(value) { emptyDelete = value; }, setStatus(value) { status = value; } };
}
async function login(adapter) {
  const session = await adapter.startLogin();
  const result = await adapter.pollLogin(session.sessionId);
  assert.equal(result.status, 'CONFIRMED');
  return { session, account: result.account };
}

test('remote files can be listed across deployments without local object mappings and read with integrity checks', async () => {
  const state = context(), remote = fakeProvider();
  const adapter = plugin().createAdapter(state, remote.transport);
  const { account } = await login(adapter);
  const config = { id: 'cloud', provider: 'ALIYUN_DRIVE', name: 'cloud', config: { accountId: account.accountId, driveId: 'drive-one', rootFolderId: 'root' } };
  const bytes = Buffer.from('existing remote content');
  remote.remote.set('folder', { file_id: 'folder', parent_file_id: 'root', name: '来自另一台服务器', type: 'folder', status: 'available' });
  remote.remote.set('legacy', { file_id: 'legacy', parent_file_id: 'folder', name: '原有文件.txt', type: 'file', status: 'available', size: bytes.length, content_hash: crypto.createHash('sha1').update(bytes).digest('hex'), bytes });
  const root = await adapter.listRemoteFiles(config, {});
  assert.equal(root.items[0].name, '来自另一台服务器');
  const page = await adapter.listRemoteFiles(config, { parentId: 'folder' });
  assert.equal(page.items[0].name, '原有文件.txt');
  const read = await adapter.readRemoteFile(config, 'legacy');
  const chunks = [];
  for await (const chunk of read.stream) chunks.push(Buffer.from(chunk));
  assert.deepEqual(Buffer.concat(chunks), bytes);
  assert.equal(read.name, '原有文件.txt');
  remote.remote.get('legacy').bytes = Buffer.from('changed');
  const damaged = await adapter.readRemoteFile(config, 'legacy');
  await assert.rejects(async () => { for await (const _ of damaged.stream) { /* consume */ } }, /校验|大小/);
});

test('remote reads cannot escape configured folder, accept malformed IDs or expose provider URLs', async () => {
  const state = context(), remote = fakeProvider(), adapter = plugin().createAdapter(state, remote.transport);
  const { account } = await login(adapter);
  const config = { id: 'cloud', provider: 'ALIYUN_DRIVE', name: 'cloud', config: { accountId: account.accountId, driveId: 'drive-one', rootFolderId: 'allowed' } };
  remote.remote.set('allowed', { file_id: 'allowed', parent_file_id: 'root', name: 'allowed', type: 'folder', status: 'available' });
  remote.remote.set('outside', { file_id: 'outside', parent_file_id: 'root', name: 'outside', type: 'folder', status: 'available' });
  remote.remote.set('other', { file_id: 'other', parent_file_id: 'outside', name: 'private', type: 'file', status: 'available', size: 1 });
  await assert.rejects(adapter.listRemoteFiles(config, { parentId: 'outside' }), /目录|范围/);
  await assert.rejects(adapter.readRemoteFile(config, 'other'), /目录|范围/);
  await assert.rejects(adapter.listRemoteFiles(config, { parentId: '../outside' }), /标识/);
  assert.equal((await adapter.listRemoteFiles(config, {})).parentId, 'allowed');
});

test('new uploads keep portable names readable on a fresh deployment and remove their description with the object', async () => {
  const state = context(), remote = fakeProvider(), adapter = plugin().createAdapter(state, remote.transport);
  const { account } = await login(adapter);
  const config = { id: 'cloud', provider: 'ALIYUN_DRIVE', name: 'cloud', config: { accountId: account.accountId, driveId: 'drive-one', rootFolderId: 'root' } };
  const bytes = Buffer.from('portable content'), key = 'project/original/version.txt';
  await adapter.upload(config, { key, buffer: bytes, originalName: '完整名称.txt', mimeType: 'text/plain' });
  const folder = [...remote.remote.values()].find(item => item.type === 'folder');
  const metadata = [...remote.remote.values()].find(item => item.name.endsWith('.ufm.json'));
  assert.ok(metadata, 'portable metadata is uploaded beside the immutable object');
  for (const stateKey of [...state.values.keys()]) if (stateKey.startsWith('object-') || stateKey.startsWith('folder-')) state.values.delete(stateKey);
  const other = plugin().createAdapter(state, remote.transport);
  const page = await other.listRemoteFiles(config, { parentId: folder.file_id });
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].originalName, '完整名称.txt');
  assert.equal(page.items[0].storageKey, key);
  assert.equal((await other.readRemoteFile(config, page.items[0].id)).name, '完整名称.txt');
  await adapter.remove(config, key);
  assert.equal([...remote.remote.values()].filter(item => item.type === 'file').length, 0);
});

test('remote downloads reject oversized objects before fetching their content', async () => {
  const state = context(), remote = fakeProvider(), adapter = plugin().createAdapter(state, remote.transport);
  const { account } = await login(adapter);
  const config = { id: 'cloud', provider: 'ALIYUN_DRIVE', name: 'cloud', config: { accountId: account.accountId, driveId: 'drive-one' } };
  remote.remote.set('huge', { file_id: 'huge', parent_file_id: 'root', name: 'huge', type: 'file', status: 'available', size: 4096, content_hash: 'f'.repeat(40) });
  await assert.rejects(adapter.readRemoteFile(config, 'huge', { maxBytes: 100 }), /大小上限/);
});

test('remote reads honor the host transfer deadline instead of a fixed two-minute timeout', async () => {
  const state = context(), remote = fakeProvider();
  const adapter = plugin().createAdapter(state, remote.transport), { account } = await login(adapter);
  const config = { id: 'deadline', provider: 'ALIYUN_DRIVE', name: 'deadline', config: { accountId: account.accountId, driveId: 'drive-one' } };
  const bytes = Buffer.from('slow transport');
  remote.remote.set('slow', { file_id: 'slow', parent_file_id: 'root', type: 'file', name: 'slow.txt', status: 'available', size: bytes.length, content_hash: crypto.createHash('sha1').update(bytes).digest('hex'), bytes });
  const timeout = AbortSignal.timeout, deadlines = [];
  AbortSignal.timeout = milliseconds => { deadlines.push(milliseconds); return timeout(milliseconds); };
  try {
    const read = await adapter.readRemoteFile(config, 'slow', { timeoutMs: 123456 });
    for await (const _ of read.stream) { /* consume */ }
    assert.equal(deadlines.at(-1), 123456);
  } finally { AbortSignal.timeout = timeout; }
});

test('retrying identical immutable bytes with a changed display name keeps its first portable description', async () => {
  const state = context(), remote = fakeProvider(), adapter = plugin().createAdapter(state, remote.transport);
  const { account } = await login(adapter);
  const config = { id: 'rename', provider: 'ALIYUN_DRIVE', name: 'rename', config: { accountId: account.accountId, driveId: 'drive-one' } };
  const params = { key: 'immutable-version', buffer: Buffer.from('same bytes'), originalName: '原始名称.txt', mimeType: 'text/plain' };
  await adapter.upload(config, params);
  const count = remote.creates;
  await adapter.upload(config, { ...params, originalName: '后来显示的名称.txt', mimeType: 'application/octet-stream' });
  assert.equal(remote.creates, count);
  for (const key of [...state.values.keys()]) if (key.startsWith('object-') || key.startsWith('folder-')) state.values.delete(key);
  await plugin().createAdapter(state, remote.transport).upload(config, { ...params, originalName: '另一部署使用的名称.txt' });
  assert.equal(remote.creates, count, 'fresh mappings verify and preserve the existing description');
  const folder = [...remote.remote.values()].find(item => item.type === 'folder');
  const page = await adapter.listRemoteFiles(config, { parentId: folder.file_id });
  assert.equal(page.items[0].originalName, '原始名称.txt');
});

test('portable descriptions work across a page boundary and invalid names never replace object names', async () => {
  const state = context(), remote = fakeProvider();
  let paged = false, denyDescription = false;
  const transport = async (url, init = {}) => {
    const parsed = new URL(url);
    const body = typeof init.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) : {};
    const description = [...remote.remote.values()].find(item => item.name.endsWith('.ufm.json'));
    if (denyDescription && parsed.pathname === '/v2/file/get_download_url' && body.file_id === description?.file_id) return json({ code: 'Forbidden' }, 403);
    if (paged && parsed.pathname === '/v2/file/list') {
      const entries = [...remote.remote.values()].filter(item => item.parent_file_id === body.parent_file_id).sort((a, b) => a.name.localeCompare(b.name));
      return json({ items: entries.slice(body.marker ? 1 : 0, body.marker ? 2 : 1), next_marker: !body.marker && entries.length > 1 ? 'page-2' : '' });
    }
    return remote.transport(url, init);
  };
  const adapter = plugin().createAdapter(state, transport), { account } = await login(adapter);
  const config = { id: 'paged', provider: 'ALIYUN_DRIVE', name: 'paged', config: { accountId: account.accountId, driveId: 'drive-one' } };
  await adapter.upload(config, { key: 'paged-key', buffer: Buffer.from('bounded description'), originalName: '跨页名称.txt', mimeType: 'text/plain' });
  const folder = [...remote.remote.values()].find(item => item.type === 'folder');
  paged = true;
  const first = await adapter.listRemoteFiles(config, { parentId: folder.file_id });
  assert.equal(first.items[0].originalName, '跨页名称.txt');
  assert.equal(first.nextCursor, 'page-2');
  assert.deepEqual((await adapter.listRemoteFiles(config, { parentId: folder.file_id, cursor: first.nextCursor })).items, []);
  denyDescription = true;
  await assert.rejects(adapter.listRemoteFiles(config, { parentId: folder.file_id }), /Forbidden|403|权限/);
  denyDescription = false;
  const description = [...remote.remote.values()].find(item => item.name.endsWith('.ufm.json'));
  const metadata = JSON.parse(description.bytes.toString()); metadata.originalName = '../../other.txt';
  description.bytes = Buffer.from(JSON.stringify(metadata)); description.size = description.bytes.length;
  description.content_hash = crypto.createHash('sha1').update(description.bytes).digest('hex');
  const safe = await adapter.listRemoteFiles(config, { parentId: folder.file_id });
  assert.equal(safe.items[0].originalName, undefined);
  assert.equal((await adapter.readRemoteFile(config, safe.items[0].id)).name, safe.items[0].name);
});

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
    assert.equal([...remote.remote.values()].filter(item => item.type === 'file' && !item.name.endsWith('.ufm.json')).length, 1);
    assert.equal([...remote.remote.values()].some(item => item.name === crypto.createHash('sha256').update('bad-key').digest('hex')), false);
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
  assert.equal(remote.creates, creates + 1, 'only the portable description is created after the upload resumes');
  assert.equal([...remote.remote.values()].filter(item => item.type === 'file' && !item.name.endsWith('.ufm.json')).length, 1);
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

function forgetObjectMappings(state) {
  for (const key of [...state.values.keys()]) if (!key.startsWith('account-')) state.values.delete(key);
}
const checksumOf = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

test('project uploads use readable isolated root directories and hide validated project markers', async () => {
  const state = context(), remote = fakeProvider(), adapter = plugin().createAdapter(state, remote.transport);
  const { account } = await login(adapter);
  const config = { id: 'projects', provider: 'ALIYUN_DRIVE', name: 'projects', config: { accountId: account.accountId, driveId: 'drive-one' } };
  const first = { id: 'project-one', name: '设计/方案\\测试:*?"<>| .', refreshToken: 'marker-must-never-store-this' }, second = { id: 'project-two', name: first.name };
  await adapter.upload(config, { key: 'first-project-key', buffer: Buffer.from('first'), originalName: '原图.txt', mimeType: 'text/plain', project: first, folderPath: '素材/草案' });
  await adapter.upload(config, { key: 'second-project-key', buffer: Buffer.from('second'), originalName: '原图.txt', mimeType: 'text/plain', project: second, folderPath: '' });
  const folders = [...remote.remote.values()].filter(item => item.type === 'folder');
  assert.equal(folders.length, 2);
  assert.equal(new Set(folders.map(item => item.name)).size, 2, 'same display names must not merge projects');
  for (const folder of folders) {
    assert.equal(folder.parent_file_id, 'root');
    assert.match(folder.name, /^设计_方案_测试/);
    assert.ok(!/[\\/:*?"<>|\x00-\x1f]/.test(folder.name));
    const marker = [...remote.remote.values()].find(item => item.parent_file_id === folder.file_id && item.name === '.ufm-project.json');
    assert.ok(marker, 'a portable project identity is stored in the folder');
    assert.ok(marker.bytes.length <= 16 * 1024);
    assert.ok(!/accessToken|refreshToken|privateKey/.test(marker.bytes.toString()));
    const entries = await adapter.listRemoteFiles(config, { parentId: folder.file_id });
    assert.equal(entries.items.length, 1);
    assert.equal(entries.items[0].originalName, '原图.txt');
    assert.equal(entries.items[0].project.id, JSON.parse(marker.bytes).project.id);
    assert.ok(entries.items[0].folderPath === '素材/草案' || entries.items[0].folderPath === '');
  }
});

test('project renames reuse their original folder after mapping loss without uploading another object', async () => {
  const state = context(), remote = fakeProvider(), adapter = plugin().createAdapter(state, remote.transport);
  const { account } = await login(adapter);
  const config = { id: 'rename-project', provider: 'ALIYUN_DRIVE', name: 'rename', config: { accountId: account.accountId, driveId: 'drive-one' } };
  const params = { key: 'rename-project-key', buffer: Buffer.from('keep immutable bytes'), originalName: '首次名称.txt', mimeType: 'text/plain', project: { id: 'stable-id', name: '原项目名称' }, folderPath: '文档' };
  await adapter.upload(config, params);
  const folder = [...remote.remote.values()].find(item => item.type === 'folder'), creates = remote.creates;
  forgetObjectMappings(state);
  await plugin().createAdapter(state, remote.transport).upload(config, { ...params, originalName: '后来的名称.txt', project: { id: 'stable-id', name: '新项目名称' } });
  assert.equal(remote.creates, creates, 'renaming a project must not create folders, content, or a second description');
  assert.equal([...remote.remote.values()].filter(item => item.type === 'folder').length, 1);
  const page = await adapter.listRemoteFiles(config, { parentId: folder.file_id });
  assert.equal(page.items.length, 1);
  assert.ok(page.items[0].project, 'the portable listing exposes project identity');
  assert.equal(page.items[0].project.id, 'stable-id');
  assert.equal(page.items[0].originalName, '首次名称.txt');
});

test('a verified legacy retry moves content and its description to a project with the same immutable identity', async () => {
  const state = context(), remote = fakeProvider(), adapter = plugin().createAdapter(state, remote.transport);
  const { account } = await login(adapter);
  const config = { id: 'organize', provider: 'ALIYUN_DRIVE', name: 'organize', config: { accountId: account.accountId, driveId: 'drive-one' } };
  const bytes = Buffer.from('legacy to organize'), params = { key: 'legacy-organize', buffer: bytes, originalName: '旧对象.txt', mimeType: 'text/plain' };
  await adapter.upload(config, params);
  const files = [...remote.remote.values()].filter(item => item.type === 'file'), ids = files.map(item => item.file_id);
  forgetObjectMappings(state);
  await plugin().createAdapter(state, remote.transport).upload(config, { ...params, project: { id: 'organize-project', name: '待归档项目' }, folderPath: '历史' });
  const project = [...remote.remote.values()].find(item => item.type === 'folder' && item.name.startsWith('待归档项目'));
  assert.ok(project);
  assert.deepEqual(remote.moves.map(item => item.file_id).sort(), ids.sort());
  assert.equal(remote.deletes.length, 0, 'organization must not delete cloud objects');
  for (const file of files) assert.equal(file.parent_file_id, project.file_id);
  assert.deepEqual(files.find(item => !item.name.endsWith('.ufm.json')).bytes, bytes);
  const page = await adapter.listRemoteFiles(config, { parentId: project.file_id });
  assert.equal(page.items[0].storageKey, params.key);
  assert.equal(page.items[0].project.id, 'organize-project');
  forgetObjectMappings(state);
  const fresh = plugin().createAdapter(state, remote.transport);
  assert.equal(await fresh.objectExists(config, params.key), true);
  await fresh.verifyBackup(config, { key: params.key, size: bytes.length, checksum: checksumOf(bytes) });
  await fresh.remove(config, params.key);
  assert.ok(ids.every(id => !remote.remote.has(id)));
  assert.equal(remote.remote.has(project.file_id), true);
});

test('failed project moves are visible and a later retry completes a partially moved legacy pair', async () => {
  const state = context(), remote = fakeProvider(); let failDescriptionMove = true;
  const transport = async (url, init = {}) => {
    if (new URL(url).pathname === '/v3/file/move') {
      const body = JSON.parse(init.body);
      if (remote.remote.get(body.file_id)?.name.endsWith('.ufm.json') && failDescriptionMove) return json({ code: 'Forbidden' }, 403);
    }
    return remote.transport(url, init);
  };
  const adapter = plugin().createAdapter(state, transport), { account } = await login(adapter);
  const config = { id: 'failed-move', provider: 'ALIYUN_DRIVE', name: 'move', config: { accountId: account.accountId, driveId: 'drive-one' } };
  const params = { key: 'failed-move-key', buffer: Buffer.from('retry migration'), originalName: '旧文件.txt', mimeType: 'text/plain' };
  await adapter.upload(config, params);
  const organized = { ...params, project: { id: 'retry-project', name: '重试项目' } };
  await assert.rejects(adapter.upload(config, organized), /Forbidden|403|权限/);
  assert.equal(remote.deletes.length, 0);
  failDescriptionMove = false; forgetObjectMappings(state);
  await plugin().createAdapter(state, transport).upload(config, organized);
  const project = [...remote.remote.values()].find(item => item.type === 'folder' && item.name.startsWith('重试项目'));
  assert.equal([...remote.remote.values()].filter(item => item.parent_file_id === project.file_id && item.type === 'file').length, 3);
  assert.equal(remote.moves.length, 2);
});

test('fresh lookup rejects duplicate immutable names across managed project and legacy directories', async () => {
  const state = context(), remote = fakeProvider(), adapter = plugin().createAdapter(state, remote.transport);
  const { account } = await login(adapter);
  const config = { id: 'duplicate', provider: 'ALIYUN_DRIVE', name: 'duplicate', config: { accountId: account.accountId, driveId: 'drive-one' } };
  const params = { key: 'duplicate-key', buffer: Buffer.from('ambiguous'), originalName: 'same.txt', mimeType: 'text/plain' };
  await adapter.upload(config, params);
  await adapter.upload(config, { key: 'separate', buffer: Buffer.from('other'), originalName: 'other.txt', mimeType: 'text/plain', project: { id: 'separate-project', name: '独立项目' } });
  const object = [...remote.remote.values()].find(item => item.name === checksumOf(params.key));
  const project = [...remote.remote.values()].find(item => item.type === 'folder' && item.name.startsWith('独立项目'));
  assert.ok(project, 'project-scoped writes must create an isolated directory');
  remote.remote.set('duplicate-object', { ...object, file_id: 'duplicate-object', parent_file_id: project.file_id });
  forgetObjectMappings(state);
  await assert.rejects(adapter.objectExists(config, params.key), /重复|歧义/);
  await assert.rejects(adapter.remove(config, params.key), /重复|歧义/);
  assert.equal(remote.deletes.length, 0);
});

test('unsafe project metadata and forged folders cannot redirect uploads or remote display paths', async () => {
  const state = context(), remote = fakeProvider(), adapter = plugin().createAdapter(state, remote.transport);
  const { account } = await login(adapter);
  const config = { id: 'safe-path', provider: 'ALIYUN_DRIVE', name: 'safe', config: { accountId: account.accountId, driveId: 'drive-one' } };
  const params = { key: 'safe-key', buffer: Buffer.from('safe content'), originalName: 'safe.txt', mimeType: 'text/plain', project: { id: 'safe-project', name: '../项目' } };
  for (const folderPath of ['../outside', '/absolute', 'a/../b', 'a\\b', 'a\0b']) await assert.rejects(adapter.upload(config, { ...params, folderPath }), /路径|目录/);
  await assert.rejects(adapter.upload(config, { ...params, project: { id: '', name: '项目' } }), /项目/);
  assert.equal(remote.creates, 0, 'reject unsafe upload context before any cloud write');
  await adapter.upload(config, { ...params, folderPath: 'safe/child' });
  const project = [...remote.remote.values()].find(item => item.type === 'folder');
  const description = [...remote.remote.values()].find(item => item.name.endsWith('.ufm.json'));
  const value = JSON.parse(description.bytes); value.folderPath = '../../escape';
  description.bytes = Buffer.from(JSON.stringify(value)); description.size = description.bytes.length; description.content_hash = crypto.createHash('sha1').update(description.bytes).digest('hex');
  const page = await adapter.listRemoteFiles(config, { parentId: project.file_id });
  assert.equal(page.items[0].originalName, undefined);
  assert.equal(page.items[0].folderPath, undefined);
  const marker = [...remote.remote.values()].find(item => item.name === '.ufm-project.json');
  marker.bytes = Buffer.from(JSON.stringify({ version: 1, kind: 'ufm-project', project: { id: 'other', name: 'forged' } }));
  marker.size = marker.bytes.length; marker.content_hash = crypto.createHash('sha1').update(marker.bytes).digest('hex');
  forgetObjectMappings(state);
  const before = remote.creates;
  await assert.rejects(adapter.upload(config, params), /目录|标记|项目/);
  assert.equal(remote.creates, before, 'a conflicting folder is not adopted or overwritten');
});

test('project descriptions remain readable with a different local account identity on the same cloud root', async () => {
  const state = context(), remote = fakeProvider(), adapter = plugin().createAdapter(state, remote.transport);
  const { account } = await login(adapter);
  const config = { id: 'portable-project', provider: 'ALIYUN_DRIVE', name: 'portable', config: { accountId: account.accountId, driveId: 'drive-one' } };
  const params = { key: 'portable-project-key', buffer: Buffer.from('portable project'), originalName: '跨部署名称.txt', mimeType: 'text/plain', project: { id: 'portable-project', name: '跨部署项目' }, folderPath: '共享资料' };
  await adapter.upload(config, params);
  const folder = [...remote.remote.values()].find(item => item.type === 'folder');
  const freshState = context(), fresh = plugin().createAdapter(freshState, remote.transport), other = await login(fresh);
  assert.notEqual(other.account.accountId, account.accountId);
  const otherConfig = { ...config, config: { ...config.config, accountId: other.account.accountId } };
  const page = await fresh.listRemoteFiles(otherConfig, { parentId: folder.file_id });
  assert.equal(page.items[0].originalName, '跨部署名称.txt');
  assert.equal(page.items[0].folderPath, '共享资料');
  await fresh.verifyBackup(otherConfig, { key: params.key, size: params.buffer.length, checksum: checksumOf(params.buffer) });
  await fresh.upload(otherConfig, params);
  assert.equal([...remote.remote.values()].filter(item => item.type === 'folder').length, 1);
});

test('verified project backups use metadata only with warm state', async () => {
  const state = context(), remote = fakeProvider(); let forbidContent = false;
  const transport = (url, init) => {
    if (forbidContent && (new URL(url).hostname.startsWith('download-') || new URL(url).pathname.includes('get_download_url'))) throw new Error('Unexpected content download');
    return remote.transport(url, init);
  };
  const adapter = plugin().createAdapter(state, transport), { account } = await login(adapter);
  const config = { id: 'warm-project', provider: 'ALIYUN_DRIVE', name: 'warm', config: { accountId: account.accountId, driveId: 'drive-one' } };
  const params = { key: 'warm-project-key', buffer: Buffer.from('warm project'), originalName: 'warm.txt', mimeType: 'text/plain', project: { id: 'warm-project', name: '已验证项目' } };
  await adapter.upload(config, params);
  forbidContent = true;
  await adapter.verifyBackup(config, { key: params.key, size: params.buffer.length, checksum: checksumOf(params.buffer) });
});

test('project uploads can retry without project context after state loss while keeping the original description', async () => {
  const state = context(), remote = fakeProvider(), adapter = plugin().createAdapter(state, remote.transport), { account } = await login(adapter);
  const config = { id: 'without-project', provider: 'ALIYUN_DRIVE', name: 'without', config: { accountId: account.accountId, driveId: 'drive-one' } };
  const params = { key: 'without-project-key', buffer: Buffer.from('keep original context'), originalName: 'original.txt', mimeType: 'text/plain', project: { id: 'without-project', name: '保留项目' } };
  await adapter.upload(config, params);
  forgetObjectMappings(state);
  const creates = remote.creates;
  await adapter.upload(config, { ...params, project: undefined, originalName: 'later.txt' });
  assert.equal(remote.creates, creates);
});

test('a partially uploaded legacy object is organized when resumed with verified project context', async () => {
  const state = context(), remote = fakeProvider(); let failPart = true;
  const transport = (url, init) => {
    if (new URL(url).hostname === 'upload-fixture.aliyuncs.com' && failPart) return json({ code: 'PartRejected' }, 400);
    if (new URL(url).pathname === '/v2/file/get_upload_url') {
      const body = JSON.parse(init.body);
      return json({ part_info_list: body.part_info_list.map(part => ({ ...part, upload_url: `https://upload-fixture.aliyuncs.com/${body.file_id}` })) });
    }
    return remote.transport(url, init);
  };
  const adapter = plugin().createAdapter(state, transport), { account } = await login(adapter);
  const config = { id: 'resume-project', provider: 'ALIYUN_DRIVE', name: 'resume', config: { accountId: account.accountId, driveId: 'drive-one' } };
  const params = { key: 'resume-project-key', buffer: Buffer.from('resuming to project'), originalName: 'resume.txt', mimeType: 'text/plain' };
  await assert.rejects(adapter.upload(config, params));
  failPart = false;
  await adapter.upload(config, { ...params, project: { id: 'resume-project', name: '继续上传项目' } });
  const project = [...remote.remote.values()].find(item => item.type === 'folder' && item.name.startsWith('继续上传项目'));
  const object = [...remote.remote.values()].find(item => item.name === checksumOf(params.key));
  assert.equal(object.parent_file_id, project.file_id);
  assert.equal(remote.moves.length, 1);
});

test('fresh lookup rejects repeated cursors and bound violations instead of deleting outside the configured root', async () => {
  const state = context(), remote = fakeProvider(); let loop = false;
  const transport = (url, init) => {
    if (loop && new URL(url).pathname === '/v2/file/list') return json({ items: [], next_marker: 'repeated' });
    return remote.transport(url, init);
  };
  const adapter = plugin().createAdapter(state, transport), { account } = await login(adapter);
  const config = { id: 'ancestry', provider: 'ALIYUN_DRIVE', name: 'ancestry', config: { accountId: account.accountId, driveId: 'drive-one', rootFolderId: 'allowed' } };
  remote.remote.set('allowed', { file_id: 'allowed', name: 'allowed', type: 'folder', status: 'available', parent_file_id: 'root' });
  await adapter.upload(config, { key: 'ancestry-key', buffer: Buffer.from('inside only'), originalName: 'inside.txt', mimeType: 'text/plain', project: { id: 'ancestry-project', name: '范围项目' } });
  const project = [...remote.remote.values()].find(item => item.type === 'folder' && item.name.startsWith('范围项目'));
  project.parent_file_id = 'root';
  await assert.rejects(adapter.remove(config, 'ancestry-key'), /范围|目录/);
  assert.equal(remote.deletes.length, 0);
  project.parent_file_id = 'allowed'; forgetObjectMappings(state); loop = true;
  await assert.rejects(adapter.objectExists(config, 'ancestry-key'), /分页|游标/);
});

test('a fresh login can verify and remove legacy objects by key without the former local account identity', async () => {
  const state = context(), remote = fakeProvider(), adapter = plugin().createAdapter(state, remote.transport), { account } = await login(adapter);
  const config = { id: 'portable-legacy', provider: 'ALIYUN_DRIVE', name: 'legacy', config: { accountId: account.accountId, driveId: 'drive-one' } };
  const params = { key: 'portable-legacy-key', buffer: Buffer.from('legacy portable object'), originalName: 'legacy.txt', mimeType: 'text/plain' };
  await adapter.upload(config, params);
  const fresh = plugin().createAdapter(context(), remote.transport), other = await login(fresh);
  const otherConfig = { ...config, config: { ...config.config, accountId: other.account.accountId } };
  assert.equal(await fresh.objectExists(otherConfig, params.key), true);
  await fresh.verifyBackup(otherConfig, { key: params.key, size: params.buffer.length, checksum: checksumOf(params.buffer) });
  await fresh.remove(otherConfig, params.key);
  assert.equal([...remote.remote.values()].filter(item => item.type === 'file').length, 0);
});
