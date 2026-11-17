const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { buildSync } = require('esbuild');
const root = path.resolve(__dirname, '../..');

test('plugin state survives restart encrypted, isolates plugins and serializes updates', async () => {
  const source = path.join(root, 'apps/api/src/storage/plugins/plugin-state-store.ts');
  assert.ok(require('node:fs').existsSync(source), 'encrypted plugin state store is implemented');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ufm-state-'));
  try {
    const out = path.join(dir, 'store.cjs');
    buildSync({ entryPoints: [source], outfile: out, bundle: true, platform: 'node', format: 'cjs' });
    const { PluginStateStore } = require(out);
    const store = new PluginStateStore(path.join(dir, 'data'), 'test-encryption-key');
    const a = store.context('DRIVE_A');
    await a.setState('account-one', { refreshToken: 'never-store-me-in-plaintext', counter: 0 });
    await Promise.all(Array.from({ length: 12 }, () => a.withLock('account-one', async () => {
      const value = await a.getState('account-one');
      await a.setState('account-one', { ...value, counter: value.counter + 1 });
    })));
    const restarted = new PluginStateStore(path.join(dir, 'data'), 'test-encryption-key');
    assert.equal((await restarted.context('DRIVE_A').getState('account-one')).counter, 12);
    assert.equal(await restarted.context('DRIVE_B').getState('account-one'), null);
    const files = await fs.readdir(path.join(dir, 'data', 'DRIVE_A'));
    const contents = await Promise.all(files.map(f => fs.readFile(path.join(dir, 'data', 'DRIVE_A', f), 'utf8')));
    assert.ok(contents.every(text => !text.includes('never-store-me-in-plaintext')));
    await assert.rejects(a.getState('../escape'));
    await a.setState('account-one', null);
    assert.equal(await a.getState('account-one'), null);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('interactive authentication requires complete adapter contract', () => {
  const sdk = require('../../packages/storage-plugin-sdk/dist');
  const manifest = { id: 'DRIVE', name: 'Drive', version: '1.0.0', apiVersion: 1, entry: 'index.cjs', fields: [], capabilities: { usage: false, directUpload: false, authentication: true } };
  const adapter = { provider: 'DRIVE', upload() {}, uploadFile() {}, remove() {}, objectExists() {}, getDownloadUrl() {} };
  assert.throws(() => sdk.validateAdapter(manifest, adapter), /startLogin|认证|authentication/);
  assert.throws(() => sdk.validateManifest({ ...manifest, capabilities: { ...manifest.capabilities, authentication: 'yes' } }));
});

test('login sessions reject other administrators, providers, canceled and expired sessions', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ufm-login-'));
  try {
    const out = path.join(dir, 'sessions.cjs');
    buildSync({ entryPoints: [path.join(root, 'apps/api/src/storage/plugins/plugin-login-sessions.ts')], outfile: out, bundle: true, platform: 'node' });
    const { PluginLoginSessions } = require(out);
    const sessions = new PluginLoginSessions();
    sessions.add('DRIVE', 'alice', { sessionId: 's1', qrCode: 'code', expiresAt: new Date(Date.now() + 60000).toISOString() });
    assert.equal(sessions.owns('DRIVE', 'alice', 's1'), true);
    assert.equal(sessions.owns('DRIVE', 'bob', 's1'), false);
    assert.equal(sessions.owns('OTHER', 'alice', 's1'), false);
    sessions.remove('s1');
    assert.equal(sessions.owns('DRIVE', 'alice', 's1'), false);
    assert.throws(() => sessions.add('DRIVE', 'alice', { sessionId: 'old', expiresAt: '2000-01-01' }));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
