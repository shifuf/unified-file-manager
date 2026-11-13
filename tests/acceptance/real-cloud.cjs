/* Uses saved encrypted global accounts, uploads tiny retained fixtures, restores policy fields. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const env = Object.fromEntries(fs.readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/)
  .filter(s => /^\w+=/.test(s)).map(s => { const i = s.indexOf('='); return [s.slice(0, i), s.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]; }));
const api = process.env.ACCEPTANCE_API || 'http://localhost:3000/api';
const web = process.env.ACCEPTANCE_WEB || 'http://localhost:5175';
assert.ok(['localhost', '127.0.0.1'].includes(new URL(api).hostname));
const run = 'real-cloud-' + Date.now().toString(36);
const out = path.join(root, '.runtime/acceptance-20261113', run);
fs.mkdirSync(out, { recursive: true });
const report = { run, startedAt: new Date().toISOString(), retained: true, checks: [], files: [], tasks: [] };
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
let cookie, project, configs, originalPolicies, lastShare = 0;
const originalUrls = new Map();
const save = () => fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(report, null, 2));
function check(name, passed, evidence) { report.checks.push({ name, passed, evidence }); console.log(JSON.stringify({ name, passed })); save(); }
async function json(p, method = 'GET', body) {
  const r = await fetch(api + p, { method, headers: { cookie, 'user-agent': 'UFM-Real-Cloud-Acceptance', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(90000) });
  const data = await r.json();
  if (!r.ok) throw new Error(method + ' ' + p + ' HTTP ' + r.status);
  return data;
}
async function upload(name, expectedConfig) {
  const bytes = Buffer.from(name + '\n真实云保留验收 ' + run + '\n');
  fs.writeFileSync(path.join(out, name), bytes);
  const boundary = 'ufm-' + crypto.randomBytes(16).toString('hex');
  const body = Buffer.concat([Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="files"; filename="' + name + '"\r\nContent-Type: text/plain\r\n\r\n'), bytes, Buffer.from('\r\n--' + boundary + '--\r\n')]);
  const r = await fetch(api + '/projects/' + project.id + '/files?folderPath=' + encodeURIComponent('真实云验收'), { method: 'POST', headers: { cookie, 'content-type': 'multipart/form-data; boundary=' + boundary }, body, signal: AbortSignal.timeout(90000) });
  if (!r.ok) throw new Error('upload HTTP ' + r.status);
  const f = (await r.json())[0];
  const rec = { id: f.id, name: f.originalName, bytes: bytes.length, sha256: sha(bytes), originalConfigId: f.storageConfigId, provider: f.cdnProvider, fixturePath: path.join(out, name) };
  report.files.push(rec); check('上传 ' + name, f.storageConfigId === expectedConfig, { configId: f.storageConfigId, provider: f.cdnProvider });
  const redirect = await fetch(api + '/files/' + f.id + '/download', { headers: { cookie }, redirect: 'manual' });
  if (redirect.status === 302) originalUrls.set(f.id, redirect.headers.get('location'));
  return rec;
}
async function verify(f) {
  const expected = fs.readFileSync(f.fixturePath);
  const original = await fetch(originalUrls.get(f.id), { signal: AbortSignal.timeout(30000) });
  check('迁移后原云对象保留 ' + f.name, original.status === 200 && sha(Buffer.from(await original.arrayBuffer())) === f.sha256, { origin: new URL(originalUrls.get(f.id)).origin, status: original.status });
  const r = await fetch(api + '/files/' + f.id + '/download', { headers: { cookie }, signal: AbortSignal.timeout(30000) });
  const bytes = Buffer.from(await r.arrayBuffer());
  check('下载哈希 ' + f.name, r.status === 200 && sha(bytes) === f.sha256, { status: r.status, bytes: bytes.length, sha256: sha(bytes) });
  const ranged = await fetch(api + '/files/' + f.id + '/download', { headers: { cookie, Range: 'bytes=3-12' }, signal: AbortSignal.timeout(30000) });
  const partial = Buffer.from(await ranged.arrayBuffer());
  check('分段下载 ' + f.name, ranged.status === 206 && partial.equals(expected.subarray(3, 13)), { status: ranged.status, bytes: partial.length, range: ranged.headers.get('content-range') });
  const redirect = await fetch(api + '/files/' + f.id + '/download', { headers: { cookie }, redirect: 'manual' });
  const location = redirect.headers.get('location');
  const direct = await fetch(location, { signal: AbortSignal.timeout(30000) });
  const directBytes = Buffer.from(await direct.arrayBuffer());
  check('云域名直链 ' + f.name, direct.status === 200 && sha(directBytes) === f.sha256, { origin: new URL(location).origin, status: direct.status });
  await json('/files/' + f.id, 'PUT', { isPublic: true });
  f.publicUrl = web + '/api/public/files/' + f.id;
  const publicRead = await fetch(f.publicUrl, { signal: AbortSignal.timeout(30000) });
  check('公开直链 ' + f.name, publicRead.ok && sha(Buffer.from(await publicRead.arrayBuffer())) === f.sha256, { status: publicRead.status });
  const s = await json('/files/' + f.id + '/shares', 'POST', {});
  f.shareUrl = web + '/shares/' + s.token;
  const wait = lastShare + 17000 - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastShare = Date.now();
  const shared = await fetch(api + '/shares/' + s.token + '/download', { signal: AbortSignal.timeout(30000) });
  check('分享下载 ' + f.name, shared.status === 200 && sha(Buffer.from(await shared.arrayBuffer())) === f.sha256, { status: shared.status });
  const generated = await fetch(s.url, { redirect: 'manual' });
  check('生成的分享页地址 ' + f.name, generated.status === 200, { status: generated.status, generatedUrl: s.url, usableUrl: f.shareUrl });
}
async function waitMigrations() {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const tasks = (await json('/tasks?projectId=' + project.id + '&pageSize=100')).items.filter(t => t.type === 'STORAGE_MIGRATION');
    report.tasks = tasks.map(t => ({ id: t.id, status: t.status, progress: t.progress, detail: t.detail })); save();
    if (tasks.length && tasks.every(t => ['COMPLETED', 'FAILED', 'CANCELLED'].includes(t.status))) {
      check('后台迁移完成', tasks.every(t => t.status === 'COMPLETED' && !t.detail.failed), report.tasks); return;
    }
    await new Promise(r => setTimeout(r, 3000));
  }
  check('后台迁移完成', false, report.tasks);
}
(async () => {
  try {
    const login = await fetch(api + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'UFM-Real-Cloud-Acceptance' }, body: JSON.stringify({ username: env.ADMIN_USERNAME, password: env.ADMIN_PASSWORD }) });
    assert.ok(login.ok); cookie = login.headers.getSetCookie().map(s => s.split(';')[0]).join('; ');
    const global = await json('/storage-configs');
    configs = ['UPYUN', 'QINIU'].map(provider => global.find(c => c.id === process.env[provider + '_CONFIG_ID']) || global.find(c => c.provider === provider && c.name.includes('真实验收')));
    assert.ok(configs.every(Boolean), 'Save both approved real cloud configurations first');
    originalPolicies = configs.map(c => ({ id: c.id, autoFailover: c.autoFailover, priority: c.priority, failoverThresholdPercent: c.failoverThresholdPercent, ...Object.fromEntries(['storageQuotaBytes', 'manualStorageUsedBytes', 'trafficQuotaBytes', 'manualTrafficUsedBytes'].map(k => [k, c[k] === null ? null : Number(c[k])])) }));
    report.configs = configs.map(c => ({ id: c.id, provider: c.provider, domain: c.config.domain })); save();
    project = await json('/projects', 'POST', { name: '验收-双云全流程-' + run, description: '真实账户小文件，容量和流量以应用配额测试。数据保留。' });
    report.project = { id: project.id, name: project.name, url: web + '/files?projectId=' + project.id }; save();
    for (const c of configs) {
      const ids = (await json('/storage-configs/' + c.id + '/projects')).map(p => p.id);
      await json('/storage-configs/' + c.id + '/projects', 'PUT', { projectIds: [...ids, project.id] });
      await json('/storage-configs/' + c.id, 'PUT', { autoFailover: false, storageQuotaBytes: null, manualStorageUsedBytes: null, trafficQuotaBytes: null, manualTrafficUsedBytes: null });
    }
    await json('/projects/' + project.id + '/storage-configs/' + configs[0].id + '/select', 'POST', {});
    for (const c of global.filter(c => c.provider === 'LOCAL')) {
      const bindings = await json('/storage-configs/' + c.id + '/projects');
      if (bindings.some(p => p.id === project.id)) await json('/storage-configs/' + c.id + '/projects', 'PUT', { projectIds: bindings.filter(p => p.id !== project.id).map(p => p.id) });
    }
    const before = await upload('切换前-又拍云.txt', configs[0].id);
    await json('/storage-configs/' + configs[0].id, 'PUT', { autoFailover: true, storageQuotaBytes: 100, manualStorageUsedBytes: 95, failoverThresholdPercent: 90 });
    const space = await upload('空间切换-七牛.txt', configs[1].id); await waitMigrations();
    await verify(space);
    await json('/storage-configs/' + configs[0].id, 'PUT', { storageQuotaBytes: null, manualStorageUsedBytes: null });
    await json('/storage-configs/' + configs[1].id, 'PUT', { autoFailover: true, trafficQuotaBytes: 100, manualTrafficUsedBytes: 95, failoverThresholdPercent: 90 });
    const traffic = await upload('流量切换-又拍云.txt', configs[0].id); await waitMigrations();
    await verify(traffic); await verify(before);
  } catch (e) { report.error = e.message; check('流程执行', false, { message: e.message }); }
  finally {
    report.policyRestored = true;
    for (const policy of originalPolicies || []) {
      const { id, ...body } = policy;
      try { await json('/storage-configs/' + id, 'PUT', body); } catch { report.policyRestored = false; }
    }
    report.finishedAt = new Date().toISOString(); report.counts = { passed: report.checks.filter(c => c.passed).length, failed: report.checks.filter(c => !c.passed).length };
    save(); console.log(JSON.stringify({ report: path.join(out, 'results.json'), project: report.project, counts: report.counts, policyRestored: report.policyRestored }));
    process.exitCode = report.counts.failed || !report.policyRestored ? 1 : 0;
  }
})();
