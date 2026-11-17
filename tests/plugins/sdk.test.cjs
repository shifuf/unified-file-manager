const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const sdkPath = path.join(root, 'packages/storage-plugin-sdk/dist/index.js');
const manifest = () => ({ id: 'TEST_STORE', name: 'Test', version: '1.0.0', apiVersion: 1, entry: 'index.cjs', fields: [{ key: 'token', label: 'Token', type: 'string', secret: true, required: true }, { key: 'secure', label: 'Secure', type: 'boolean', default: true }], capabilities: { directUpload: false, usage: false } });
const sdk = () => { assert.ok(fs.existsSync(sdkPath), 'SDK must provide a buildable standalone runtime'); return require(sdkPath); };

test('legacy boolean strings normalize without losing false', () => {
  const m=manifest();
  assert.equal(sdk().validateConfig(m,{token:'ok',secure:'false'}).secure,false);
  assert.equal(sdk().validateConfig(m,{token:'ok',secure:'true'}).secure,true);
});

test('manifest validator rejects unsupported protocol, unsafe paths, duplicate fields and reserved IDs', () => {
  const { validateManifest } = sdk();
  assert.equal(validateManifest(manifest()).id, 'TEST_STORE');
  for (const patch of [{ id: 'LOCAL' }, { id: '../bad' }, { apiVersion: 2 }, { version: 'latest' }, { entry: '../index.cjs' }, { fields: [manifest().fields[0], manifest().fields[0]] }, { fields: [{ key: '__proto__', label: 'Bad', type: 'string' }] }]) assert.throws(() => validateManifest({ ...manifest(), ...patch }));
});

test('config validator preserves unknown legacy keys, applies defaults and rejects type and option errors', () => {
  const { validateConfig } = sdk();
  assert.deepEqual(validateConfig(manifest(), { token: 'secret', legacy: 1 }), { token: 'secret', legacy: 1, secure: true });
  assert.throws(() => validateConfig(manifest(), {}));
  assert.throws(() => validateConfig(manifest(), { token: 'secret', secure: 'invalid-boolean' }));
  const m = { ...manifest(), fields: [{ key: 'mode', label: 'Mode', type: 'select', options: [{ label: 'One', value: 'one' }] }, { key: 'endpoint', label: 'Endpoint', type: 'string', url: true }] };
  assert.throws(() => validateConfig(m, { mode: 'two' }));
  assert.throws(() => validateConfig(m, { endpoint: 'file:///tmp/file' }));
});

test('adapter contract catches missing streaming and mismatched advertised capabilities', () => {
  const { validateAdapter } = sdk();
  const adapter = { provider: 'TEST_STORE', upload() {}, uploadFile() {}, remove() {}, getDownloadUrl() {}, objectExists() {} };
  assert.equal(validateAdapter(manifest(), adapter), adapter);
  assert.throws(() => validateAdapter(manifest(), { ...adapter, uploadFile: undefined }));
  assert.throws(() => validateAdapter({ ...manifest(), capabilities: { directUpload: true, usage: false } }, adapter));
  assert.throws(() => validateAdapter(manifest(), { ...adapter, provider: 'OTHER' }));
});

test('backup-only plugins require metadata confirmation and a boolean capability', () => {
  const { validateManifest, validateAdapter } = sdk();
  const m = { ...manifest(), capabilities: { directUpload: false, usage: false, backupOnly: true } };
  const adapter = { provider: m.id, upload() {}, uploadFile() {}, remove() {}, getDownloadUrl() {}, objectExists() {} };
  assert.throws(() => validateManifest({ ...m, capabilities: { ...m.capabilities, backupOnly: 'true' } }));
  assert.throws(() => validateAdapter(m, adapter), /verifyBackup/);
  assert.equal(validateAdapter(m, { ...adapter, verifyBackup() {} }).provider, m.id);
});

test('all remote bundles load outside the repository with their declared contract', () => {
  const { validateManifest, validateAdapter } = sdk();
  for (const id of ['qiniu', 'upyun', 'aliyun', 's3', 'cloudflare-r2']) {
    const dir = path.join(root, 'plugins', id, 'dist');
    assert.ok(fs.existsSync(path.join(dir, 'index.cjs')), `${id} must build independently`);
    const temp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'ufm-plugin-contract-'));
    try {
      fs.copyFileSync(path.join(dir, 'index.cjs'), path.join(temp, 'index.cjs'));
      const m = validateManifest(JSON.parse(fs.readFileSync(path.join(root, 'plugins', id, 'storage-plugin.json'))));
      validateAdapter(m, require(path.join(temp, 'index.cjs')).createAdapter());
      execFileSync(process.execPath, ['-e', "require('./index.cjs').createAdapter()"], { cwd: temp });
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  }
});
