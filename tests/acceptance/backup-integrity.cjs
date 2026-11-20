const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { gunzipSync } = require('node:zlib');

// Creates and retains a local backup; never restores or deletes business data.
async function main() {
  const root = path.resolve(__dirname, '../..');
  const api = process.env.ACCEPTANCE_API || 'http://127.0.0.1:3000/api';
  const endpoint = new URL(api);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname) && endpoint.protocol === 'http:', 'Local API only');
  const env = require('dotenv').parse(await fs.readFile(path.join(root, '.env')));
  const cookies = new Map();
  async function request(route, options = {}) {
    assert.ok(!/restore/.test(route) && options.method !== 'DELETE', 'Retained backup only');
    const response = await fetch(api + route, { ...options, headers: { 'User-Agent': 'UFM Local Backup Acceptance', Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; '), ...(options.headers || {}) }, redirect: 'manual', signal: options.signal || AbortSignal.timeout(60_000) });
    for (const cookie of response.headers.getSetCookie()) { const pair = cookie.split(';')[0]; const index = pair.indexOf('='); cookies.set(pair.slice(0, index), pair.slice(index + 1)); }
    return response;
  }
  try {
  const login = await request('/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: env.ADMIN_USERNAME, password: env.ADMIN_PASSWORD }) });
  assert.equal(login.status, 201, 'Administrator login');
  const loginInfo = await login.json(); assert.equal(loginInfo.requiresTotp, false, 'TOTP must be completed interactively');
  const before = await request('/backups'); assert.equal(before.status, 200);
  const beforeRows = await before.json();
  const response = await request('/backups', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: `验收-副本备份-${new Date().toISOString()}`, includeObjects: false }) });
  assert.equal(response.status, 201, 'Create retained logical backup');
  const backup = await response.json(); assert.equal(backup.status, 'SUCCEEDED'); assert.ok(backup.fileAvailable);
  const download = await request(`/backups/${backup.id}/download`); assert.equal(download.status, 200);
  const bytes = Buffer.from(await download.arrayBuffer());
  const checksum = crypto.createHash('sha256').update(bytes).digest('hex');
  assert.equal(checksum, backup.checksum); assert.equal(bytes.length, backup.fileSize);
  const payload = JSON.parse(gunzipSync(bytes));
  assert.ok(Array.isArray(payload.tables.projectStorageBinding), 'Binding table is present');
  assert.ok(Array.isArray(payload.tables.storageReplica), 'Replica table is present');
  assert.ok(Array.isArray(payload.tables.openApiNonce), 'Current nonce table is present');
  for (const rows of Object.values(payload.tables)) for (const row of rows) assert.ok(Object.keys(row).length > 0, 'No empty exported rows');
  const directory = path.join(root, '.runtime', 'acceptance-20261113', 'backup-integrity', backup.id);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'archive.json.gz'), bytes);
  const result = { backupId: backup.id, status: backup.status, bytes: bytes.length, checksum, tableCounts: Object.fromEntries(Object.entries(payload.tables).map(([key, rows]) => [key, rows.length])), priorRunningCount: beforeRows.filter(row => row.status === 'RUNNING').length, retained: true, restoredOriginalDatabase: false };
  await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  } finally {
    if (cookies.get('ufm_refresh')) {
      try {
        const logout = await request('/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(10000) });
        assert.equal(logout.status, 200);
      } catch {
        console.error('验收脚本自己的会话注销失败，请在登录会话中退出该客户端。');
        process.exitCode = 1;
      }
    }
  }
}
main().catch(error => { console.error(`Backup acceptance failed: ${error.message}`); process.exitCode = 1; });
