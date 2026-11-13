/* Real saved providers; fixtures and cloud objects are deliberately retained. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const base = process.env.UFM_TEST_BASE || 'http://localhost:5175';
const api = base + '/api';
const run = 'storage-ui-' + Date.now().toString(36);
const out = path.join(root, '.runtime/acceptance-20261114-storage-ui', run);
fs.mkdirSync(out, { recursive: true });
const report = { run, base, retained: true, startedAt: new Date().toISOString(), checks: [], files: [] };
let cookie, project;
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const save = () => fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(report, null, 2));
function check(name, evidence) { report.checks.push({ name, pass: true, evidence }); save(); console.log(JSON.stringify({ name, pass: true })); }
async function credentials() {
  if (process.env.UFM_TEST_AUTH_STDIN === '1') {
    let input = ''; for await (const chunk of process.stdin) input += chunk;
    return JSON.parse(input);
  }
  const env = Object.fromEntries(fs.readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/).filter(s => /^\w+=/.test(s)).map(s => { const i = s.indexOf('='); return [s.slice(0, i), s.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]; }));
  return { username: env.ADMIN_USERNAME, password: env.ADMIN_PASSWORD };
}
async function req(p, method = 'GET', body, headers = {}) {
  return fetch(api + p, { method, headers: { cookie, 'user-agent': 'UFM-Storage-Visibility-Acceptance', 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(90000), redirect: 'manual' });
}
async function json(p, method = 'GET', body) { const r = await req(p, method, body); assert.ok(r.ok, method + ' ' + p + ' HTTP ' + r.status); return r.json(); }
async function bind(configId) {
  const before = await json('/storage-configs/' + configId + '/projects');
  await json('/storage-configs/' + configId + '/projects', 'PUT', { projectIds: [...new Set([...before.map(p => p.id), project.id])] });
  const after = await json('/storage-configs/' + configId + '/projects');
  assert.ok(before.every(p => after.some(a => a.id === p.id)), 'existing bindings retained');
}
async function upload(index) {
  const name = '分页与副本-' + String(index).padStart(2, '0') + '-' + run + '.txt';
  const bytes = Buffer.from('真实存储可见性验收\n0123456789abcdefghijklmnopqrstuvwxyz\n' + name);
  const fixturePath = path.join(out, name); fs.writeFileSync(fixturePath, bytes);
  const form = new FormData(); form.append('files', new Blob([bytes], { type: 'text/plain' }), name);
  const r = await fetch(api + '/projects/' + project.id + '/files?folderPath=', { method: 'POST', headers: { cookie }, body: form, signal: AbortSignal.timeout(90000) });
  assert.ok(r.ok, 'upload HTTP ' + r.status); const f = (await r.json())[0];
  assert.equal(f.cdnProvider, 'LOCAL'); assert.equal(f.checksum, sha(bytes));
  report.files.push({ id: f.id, name, sha256: sha(bytes), fixturePath, storageKey: f.storageKey, currentVersion: f.currentVersion }); save(); return f;
}
async function waitTargets(ids, count) {
  const deadline = Date.now() + 240000; let result;
  while (Date.now() < deadline) {
    result = await json('/files/storage-replicas?fileIds=' + ids.join(','));
    if (result.items.length === ids.length && result.items.every(f => f.items.filter(s => s.desired).length === count && f.items.filter(s => s.desired).every(s => s.status === 'READY' && s.verifiedAt))) return result;
    await new Promise(r => setTimeout(r, 2000));
  }
  report.lastReplicaStates = result; save(); throw new Error('replicas did not reach verified READY');
}
async function pages(prefix, key = 'id', total) {
  const a = await json(prefix + 'page=1&pageSize=20'), b = await json(prefix + 'page=2&pageSize=20');
  assert.equal(a.total, total); assert.equal(b.total, total); assert.equal(a.items.length, 20);
  assert.ok(b.items.length >= 1); assert.equal(new Set([...a.items, ...b.items].map(x => x[key])).size, a.items.length + b.items.length);
  const end = await json(prefix + 'page=999&pageSize=20'); assert.equal(end.page, Math.ceil(total / 20));
  return { total, first: a.items.length, second: b.items.length, last: end.page };
}
(async () => {
  try {
    const auth = await credentials();
    const login = await fetch(api + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'UFM-Storage-Visibility-Acceptance' }, body: JSON.stringify(auth) });
    assert.ok(login.ok, 'login HTTP ' + login.status); assert.ok(!(await login.json()).requiresTotp, 'interactive TOTP required');
    cookie = login.headers.getSetCookie().map(s => s.split(';')[0]).join('; ');
    check('本轮真实应用登录', { base });
    const configs = await json('/storage-configs');
    const qiniu = configs.find(c => c.provider === 'QINIU' && c.enabled), upyun = configs.find(c => c.provider === 'UPYUN' && c.enabled);
    assert.ok(qiniu && upyun, 'saved enabled real providers required');
    project = await json('/projects', 'POST', { name: '验收-多存储与分页-' + run });
    report.project = { id: project.id, name: project.name, url: base + '/projects/' + project.id }; save();
    await bind(qiniu.id);
    const files = []; for (let i = 1; i <= 22; i++) files.push(await upload(i));
    const initialReplicas = await waitTargets(files.map(f => f.id), 2);
    for (const record of report.files) { const snapshot = initialReplicas.items.find(f => f.fileId === record.id); record.storageKey = snapshot.storageKey; record.currentVersion = snapshot.currentVersion; }
    save();
    check('22 文件先保存本地并实际同步首个云', { count: files.length });
    const before = await json('/files/' + files[0].id);
    const beforeStorage = await json('/files/' + files[0].id + '/storage-replicas');
    const share = await json('/files/' + files[0].id + '/shares', 'POST', { maxDownloads: 1 }); report.share = { id: share.id, url: share.url }; save();
    await bind(upyun.id);
    const queued = await json('/files/' + files[0].id + '/storage-replicas/sync', 'POST', { configIds: [upyun.id] });
    assert.equal(queued.fileId, files[0].id);
    await waitTargets(files.map(f => f.id), 3);
    const after = await json('/files/' + files[0].id);
    for (const key of ['id', 'currentVersion', 'storageConfigId', 'checksum']) assert.equal(after[key], before[key], 'head immutable: ' + key);
    const afterStorage = await json('/files/' + files[0].id + '/storage-replicas');
    assert.equal(afterStorage.storageKey, beforeStorage.storageKey); assert.equal(afterStorage.currentVersion, beforeStorage.currentVersion);
    assert.ok((await json('/files/' + files[0].id + '/shares')).some(s => s.id === share.id));
    assert.equal((await json('/files/' + files[0].id + '/storage-replicas/sync', 'POST', { configIds: [upyun.id] })).queued, 0);
    check('新增云自动补齐，单文件同步幂等且原引用及分享不变', { targets: 3, files: 22 });
    const p = await json('/projects/' + project.id); assert.equal(p.storages.filter(s => s.enabled).length, 3);
    check('项目摘要展示本地及两个云', { storages: p.storages.map(s => ({ id: s.id, provider: s.provider })) });
    const detail = await json('/files/' + files[0].id + '/storage-replicas'); assert.equal(detail.fileId, files[0].id);
    const denied = configs.find(c => c.enabled && !detail.items.some(s => s.configId === c.id && s.desired));
    if (denied) assert.equal((await req('/files/' + files[0].id + '/storage-replicas/sync', 'POST', { configIds: [denied.id] })).status, 400);
    assert.equal((await req('/files/storage-replicas?fileIds=' + Array.from({ length: 101 }, (_, i) => 'fake' + i).join(','))).status, 400);
    assert.equal((await req('/projects/' + project.id + '/storage/replicas?page=true&pageSize=20')).status, 400);
    check('批量元数据路由、未绑定目标和分页输入边界', { maxBatch: 100 });
    for (const record of report.files) {
      const r = await req('/files/' + record.id + '/download'); assert.equal(r.status, 200); assert.equal(r.headers.get('location'), null);
      assert.equal(sha(Buffer.from(await r.arrayBuffer())), record.sha256);
    }
    // Download statistics are written after stream completion.
    await new Promise(r => setTimeout(r, 1200));
    const downloadTotal = (await json('/projects/' + project.id + '/download-stats?days=7&page=1&pageSize=20')).total;
    assert.ok(downloadTotal >= 22);
    check('22 个真实云优先代理下载摘要一致，无云域名跳转', { count: 22 });
    check('最近文件两页、末页纠正', await pages('/files?projectId=' + project.id + '&', 'id', 22));
    check('存储副本两页、末页纠正', await pages('/projects/' + project.id + '/storage/replicas?', 'id', 66));
    check('下载明细两页、末页纠正', await pages('/projects/' + project.id + '/download-stats?days=7&', 'id', downloadTotal));
    const session = await json('/shares/' + share.token + '/download-session', 'POST', {});
    const url = new URL(session.url, base), ticket = url.pathname.replace(/^\/api/, '') + url.search;
    assert.equal(url.origin, base); assert.equal((await req(ticket, 'HEAD')).status, 200);
    assert.equal((await json('/files/' + files[0].id + '/shares')).find(s => s.id === share.id).downloadCount, 0);
    const bytes = fs.readFileSync(report.files[0].fixturePath);
    for (const [range, start, end] of [['bytes=0-9', 0, 10], ['bytes=10-19', 10, 20]]) { const r = await req(ticket, 'GET', undefined, { Range: range }); assert.equal(r.status, 206); assert.deepEqual(Buffer.from(await r.arrayBuffer()), bytes.subarray(start, end)); }
    assert.equal((await json('/files/' + files[0].id + '/shares')).find(s => s.id === share.id).downloadCount, 1);
    check('统一域名分享 HEAD 零计次，两个 Range 只计一次', { url: share.url });
    const [summary, trend7, trend30, storage, activity, allProjects, allFiles] = await Promise.all([
      json('/dashboard/summary'), json('/dashboard/trends?days=7'), json('/dashboard/trends?days=30'), json('/dashboard/storage?page=1&pageSize=20'), json('/dashboard/activity?page=1&pageSize=20'), json('/projects'), json('/files?page=1&pageSize=1'),
    ]);
    assert.equal(summary.projects.total, allProjects.length); assert.equal(summary.files.active, allFiles.total);
    assert.equal(trend7.items.length, 7); assert.equal(trend30.items.length, 30); assert.equal(trend7.timezone, 'Asia/Shanghai');
    assert.ok(storage.items.length <= 20 && activity.recentFiles.length <= 10 && activity.topProjects.length <= 5);
    assert.ok(storage.items.every(s => ['HEALTHY', 'FAILED', 'UNKNOWN'].includes(s.health.status)));
    assert.equal((await req('/dashboard/trends?days=90')).status, 400);
    check('概览统计与实际列表一致、7/30 天上海趋势和查询数量上限', { summary, storageCount: storage.total, recent: activity.recentFiles.length });
    report.configs = { qiniuId: qiniu.id, upyunId: upyun.id }; report.finishedAt = new Date().toISOString();
    report.counts = { passed: report.checks.length, failed: 0 }; save();
    fs.writeFileSync(path.join(root, '.runtime/acceptance-20261114-storage-ui', base.startsWith('https:') ? 'public-latest.json' : 'local-latest.json'), JSON.stringify({ out, project: report.project }, null, 2));
    console.log(JSON.stringify({ out, project: report.project, counts: report.counts }));
  } catch (e) { report.error = e.message; report.counts = { passed: report.checks.length, failed: 1 }; save(); console.error(e.message); process.exitCode = 1; }
  finally { if (cookie) await req('/auth/logout', 'POST', {}).catch(() => {}); }
})();
