/* Read-only integrity verification of all retained acceptance projects. */
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..'), api = 'http://localhost:3000/api';
const env = Object.fromEntries(fs.readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/).filter(s => /^\w+=/.test(s)).map(s => { const i = s.indexOf('='); return [s.slice(0, i), s.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]; }));
const out = path.join(root, '.runtime/acceptance-20261113/all-retained-verification.json');
const report = { checkedAt: new Date().toISOString(), retained: true, projects: [], files: [], failures: [] };
let cookie;
const save = () => fs.writeFileSync(out, JSON.stringify(report, null, 2));
const json = async p => { const r = await fetch(api + p, { headers: { cookie }, signal: AbortSignal.timeout(20000) }); assert.ok(r.ok, p + ' HTTP ' + r.status); return r.json(); };
(async () => { try {
  const login = await fetch(api + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'UFM-All-Retained-Verification' }, body: JSON.stringify({ username: env.ADMIN_USERNAME, password: env.ADMIN_PASSWORD }) }); assert.ok(login.ok);
  cookie = login.headers.getSetCookie().map(s => s.split(';')[0]).join('; ');
  const projects = (await json('/projects')).filter(p => p.name.startsWith('验收-'));
  for (const p of projects) {
    const list = await json('/files?projectId=' + p.id + '&pageSize=100'); assert.equal(list.total, list.items.length);
    report.projects.push({ id: p.id, name: p.name, files: list.total, url: 'http://localhost:5175/files?projectId=' + p.id });
    for (const f of list.items) {
      const attempts = [];
      try {
        let bytes, status;
        for (let i = 0; i < 2; i++) {
          try { const r = await fetch(api + '/files/' + f.id + '/download', { headers: { cookie }, signal: AbortSignal.timeout(20000) }); status = r.status; bytes = Buffer.from(await r.arrayBuffer()); break; }
          catch (e) { attempts.push({ error: e.message, code: e.cause?.code }); if (i === 1) throw e; }
        }
        const hash = crypto.createHash('sha256').update(bytes).digest('hex');
        assert.equal(status, 200); assert.equal(f.status, 'ACTIVE'); assert.equal(bytes.length, f.size); assert.equal(hash, f.checksum);
        report.files.push({ id: f.id, projectId: p.id, name: f.originalName, provider: f.cdnProvider, bytes: bytes.length, sha256: hash, attempts });
      } catch (e) { report.failures.push({ id: f.id, name: f.originalName, error: e.message, attempts }); }
      save();
    }
    console.log(JSON.stringify({ project: p.name, files: list.total, failedSoFar: report.failures.length }));
  }
  report.health = await json('/healthz');
  report.counts = { projects: report.projects.length, passedFiles: report.files.length, failedFiles: report.failures.length }; save();
  console.log(JSON.stringify({ report: out, counts: report.counts })); process.exitCode = report.failures.length ? 1 : 0;
} catch (e) { report.error = e.message; save(); console.error('Verification failed: ' + e.message); process.exitCode = 2; }
finally { if (cookie) await fetch(api + '/auth/logout', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(10000) }).catch(() => {}); }
})();
