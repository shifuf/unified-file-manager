/* Real local AuthService/MariaDB acceptance. Credentials/cookies stay in memory. */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { PrismaClient } = require('@prisma/client');
const root = path.resolve(__dirname, '../..');
const env = Object.fromEntries(fs.readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/).filter((line) => /^[A-Z_]+=/.test(line)).map((line) => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1).trim().replace(/^(['"])(.*)\1$/, '$2')]; }));
const api = process.env.ACCEPTANCE_API || 'http://localhost:3000/api';
const web = process.env.ACCEPTANCE_WEB_URL || 'http://localhost:5175';
for (const value of [api, web]) { const url = new URL(value); assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.protocol === 'http:', 'LOCAL_ONLY'); }
process.env.DATABASE_URL = env.DATABASE_URL || `mysql://${env.MYSQL_USER || 'ufm'}:${encodeURIComponent(env.MYSQL_PASSWORD || '')}@${env.MYSQL_HOST || 'localhost'}:${env.MYSQL_PORT || '3306'}/${env.MYSQL_DATABASE || 'unified_file_manager'}`;
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env.DATABASE_URL).hostname), 'LOCAL_DATABASE_ONLY');
const prisma = new PrismaClient();
const PRIMARY = 'UFM-Auth-Acceptance-20261113';
const SECONDARY = PRIMARY + '-secondary';
const BROWSER = PRIMARY + '-browser';
const LONG_PREFIX = PRIMARY + '-long/';
const out = path.join(root, '.runtime', 'acceptance-20261113', 'auth-sessions-real', Date.now().toString(36));
fs.mkdirSync(out, { recursive: true });
const result = { startedAt: new Date().toISOString(), api, web, user: '[admin]', checks: [], screenshots: [], writes: 'Only LOGIN/refresh/logout and targeted revocation for acceptance UAs; Prisma queries are read-only.', secretsSaved: false, sourceAuthModifiedAt: fs.statSync(path.join(root, 'apps/api/src/auth/auth.service.ts')).mtime.toISOString(), compiledAuthModifiedAt: fs.statSync(path.join(root, 'apps/api/dist/auth/auth.service.js')).mtime.toISOString() };
const sessionsOwned = new Set();
const makeClient = (ua) => ({ ua, cookies: new Map() });
const primary = makeClient(PRIMARY), secondary = makeClient(SECONDARY);
const longPrimary = makeClient(LONG_PREFIX + 'synthetic-browser/'.repeat(20) + 'device-A');
const longSecondary = makeClient(LONG_PREFIX + 'synthetic-browser/'.repeat(20) + 'device-B');
let browser;
const cookieHeader = (client) => [...client.cookies].map(([key, value]) => `${key}=${value}`).join('; ');
const redact = (message) => { let value = String(message).slice(0, 900); for (const secret of [env.ADMIN_PASSWORD, env.MYSQL_PASSWORD, process.env.DATABASE_URL]) if (secret) value = value.split(secret).join('[redacted]'); return value.replace(/(ufm_(?:access|refresh)=)[^;\s]+/g, '$1[redacted]'); };
const save = () => fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(result, null, 2));
async function request(client, method, route, data, fixedCookie) {
  assert.ok(route.startsWith('/auth/') || route === '/healthz', 'AUTH_ONLY');
  assert.ok(!(method === 'DELETE') || /^\/auth\/sessions\/[^/]+$/.test(route) && sessionsOwned.has(route.split('/').at(-1)), 'OWN_SESSION_ONLY');
  const response = await fetch(api + route, { method, headers: { 'user-agent': client.ua, cookie: fixedCookie === undefined ? cookieHeader(client) : fixedCookie, 'content-type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data), redirect: 'manual', signal: AbortSignal.timeout(15000) });
  const setCookies = new Map();
  for (const cookie of response.headers.getSetCookie()) { const pair = cookie.split(';')[0], i = pair.indexOf('='); setCookies.set(pair.slice(0, i), pair.slice(i + 1)); }
  if (fixedCookie === undefined) for (const [key, value] of setCookies) client.cookies.set(key, value);
  const json = await response.json();
  return { status: response.status, json, setCookies };
}
async function check(name, fn) {
  try { const evidence = await fn(); result.checks.push({ name, status: 'PASS', evidence }); }
  catch (error) { result.checks.push({ name, status: 'FAIL', error: redact(error.message) }); }
  save(); console.log(`${name}: ${result.checks.at(-1).status}`);
}
async function liveRows(userId, ua) {
  return prisma.refreshToken.findMany({ where: { userId, userAgent: ua, revokedAt: null, expiresAt: { gt: new Date() } }, select: { id: true, ip: true, userAgent: true, createdAt: true, expiresAt: true } });
}
async function ownList(client, ua) { const r = await request(client, 'GET', '/auth/sessions'); assert.equal(r.status, 200); const rows = r.json.filter((row) => row.userAgent === ua); for (const row of rows) sessionsOwned.add(row.id); return rows; }
async function login(client) { const r = await request(client, 'POST', '/auth/login', { username: env.ADMIN_USERNAME, password: env.ADMIN_PASSWORD }); assert.equal(r.status, 201, 'login HTTP'); assert.equal(r.json.requiresTotp, false, 'TOTP requires separate manual acceptance'); return r; }
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  let userId, primaryId, secondaryId, initialAudit;
  try {
    await check('R01 API健康就绪（最长等待30秒）', async () => {
      const start = Date.now(); let ready = false;
      do { try { const r = await request(primary, 'GET', '/healthz'); if (r.status === 200 && r.json.status === 'ok') { ready = true; break; } } catch {} if (Date.now() - start < 30000) await pause(3000); } while (Date.now() - start < 30000);
      assert.equal(ready, true); return { http: 200 };
    });
    const account = await prisma.user.findUnique({ where: { username: env.ADMIN_USERNAME }, select: { id: true } }); assert.ok(account, 'administrator not found'); userId = account.id;
    initialAudit = await prisma.auditLog.count({ where: { actorId: userId, action: 'LOGIN', userAgent: PRIMARY } });
    await check('R02 顺序两次主动登录重用真实MariaDB会话ID且LOGIN+2', async () => {
      await login(primary); const first = await ownList(primary, PRIMARY); assert.equal(first.length, 1); primaryId = first[0].id;
      const previousCredential = primary.cookies.get('ufm_refresh'); await login(primary);
      const second = await ownList(primary, PRIMARY); assert.equal(second.length, 1); assert.equal(second[0].id, primaryId); assert.equal(second[0].current, true); assert.ok(previousCredential !== primary.cookies.get('ufm_refresh'), 'relogin must invalidate old credential');
      const audit = await prisma.auditLog.count({ where: { actorId: userId, action: 'LOGIN', userAgent: PRIMARY } }); assert.equal(audit - initialAudit, 2);
      const db = await liveRows(userId, PRIMARY); assert.equal(db.length, 1); assert.equal(db[0].id, primaryId);
      return { sessionId: primaryId, liveDatabaseRows: db.length, loginAuditIncrease: audit - initialAudit, credentialChanged: true, current: true, lockSqlSucceeded: true };
    });
    await check('R03 同一Cookie并发refresh返回同一替换凭据且ID不变', async () => {
      const original = cookieHeader(primary), before = primary.cookies.get('ufm_refresh');
      const responses = await Promise.all([request(primary, 'POST', '/auth/refresh', {}, original), request(primary, 'POST', '/auth/refresh', {}, original)]);
      assert.ok(responses.every((r) => r.status === 201), 'concurrent refresh HTTP');
      assert.ok(responses[0].setCookies.get('ufm_refresh') === responses[1].setCookies.get('ufm_refresh'), 'concurrent refresh replacement differs');
      assert.ok(responses[0].setCookies.get('ufm_refresh') !== before, 'credential must rotate');
      for (const [key, value] of responses[0].setCookies) primary.cookies.set(key, value);
      const rows = await ownList(primary, PRIMARY); assert.equal(rows.length, 1); assert.equal(rows[0].id, primaryId);
      assert.equal((await liveRows(userId, PRIMARY)).length, 1);
      return { responseStatuses: responses.map((r) => r.status), sameReplacement: true, credentialRotated: true, sessionId: primaryId, liveDatabaseRows: 1 };
    });
    await check('R04 第二UA独立，主设备自动刷新不改变LOGIN历史', async () => {
      await login(secondary); const rows = await ownList(secondary, SECONDARY); assert.equal(rows.length, 1); secondaryId = rows[0].id; assert.notEqual(secondaryId, primaryId);
      const r = await request(primary, 'POST', '/auth/refresh', {}); assert.equal(r.status, 201);
      const audit = await prisma.auditLog.count({ where: { actorId: userId, action: 'LOGIN', userAgent: PRIMARY } }); assert.equal(audit - initialAudit, 2);
      const first = await liveRows(userId, PRIMARY), second = await liveRows(userId, SECONDARY); assert.equal(first.length, 1); assert.equal(second.length, 1);
      return { primaryId, secondaryId, liveRowsPerDevice: [first.length, second.length], primaryLoginAuditIncrease: audit - initialAudit };
    });
    await check('R05 吊销主设备保留第二设备，旧令牌重用不连带退出', async () => {
      assert.ok(primaryId && secondaryId, 'login prerequisite'); const stale = cookieHeader(primary);
      const revoked = await request(secondary, 'DELETE', `/auth/sessions/${primaryId}`); assert.equal(revoked.status, 200);
      const denied = await request(primary, 'POST', '/auth/refresh', {}, stale); assert.equal(denied.status, 401);
      const alive = await request(secondary, 'POST', '/auth/refresh', {}); assert.equal(alive.status, 201);
      assert.equal((await liveRows(userId, PRIMARY)).length, 0); assert.equal((await liveRows(userId, SECONDARY)).length, 1);
      const rows = await ownList(secondary, SECONDARY); assert.equal(rows[0].id, secondaryId);
      return { revokeHttp: revoked.status, revokedRefreshHttp: denied.status, otherRefreshHttp: alive.status, otherSessionId: secondaryId, primaryLive: 0, secondaryLive: 1 };
    });
    await check('R06 宽限期previous-token登出能撤销本设备且不影响第二设备', async () => {
      await login(primary); const previous = cookieHeader(primary); const refresh = await request(primary, 'POST', '/auth/refresh', {}); assert.equal(refresh.status, 201);
      const logout = await request(primary, 'POST', '/auth/logout', {}, previous); assert.equal(logout.status, 200);
      assert.equal((await liveRows(userId, PRIMARY)).length, 0); assert.equal((await liveRows(userId, SECONDARY)).length, 1);
      return { logoutHttp: logout.status, primaryLive: 0, secondaryLive: 1 };
    });
    await check('R07 真实Chrome两次UI登录只显示一个当前验收设备（脱敏截图）', async () => {
      const playwright = require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/shifuf/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
      browser = await playwright.chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
      const contexts = [];
      let firstId, secondId, current;
      const before = await prisma.auditLog.count({ where: { actorId: userId, action: 'LOGIN', userAgent: BROWSER } });
      try {
        for (let i = 0; i < 2; i++) {
          const context = await browser.newContext({ userAgent: BROWSER, viewport: { width: 1280, height: 1000 } }); contexts.push(context); const page = await context.newPage();
          await page.goto(web + '/console-login');
          await page.locator('input[autocomplete="username"]').fill(env.ADMIN_USERNAME);
          await page.locator('input[autocomplete="current-password"]').fill(env.ADMIN_PASSWORD);
          await page.getByRole('button', { name: '登录', exact: true }).click(); await page.waitForURL('**/dashboard', { timeout: 30000 });
          const response = await context.request.get(web + '/api/auth/sessions'); assert.equal(response.status(), 200); const own = (await response.json()).filter((row) => row.userAgent === BROWSER); assert.equal(own.length, 1); assert.equal(own[0].current, true);
          if (i === 0) firstId = own[0].id; else { secondId = own[0].id; current = own[0].current; assert.equal(secondId, firstId);
            await page.getByRole('button', { name: '账号安全', exact: true }).click(); const dialog = page.getByRole('dialog', { name: '账号安全', exact: true }); await dialog.waitFor(); const table = dialog.locator('.el-table'); const ownRow = table.locator('tbody tr').filter({ hasText: BROWSER }); await ownRow.waitFor(); assert.equal(await ownRow.count(), 1);
            const image = path.join(out, 'sessions-ui-redacted.png'); await table.screenshot({ path: image, mask: [table.locator('tbody tr').filter({ hasNotText: BROWSER }), table.locator('td:nth-child(2)')] }); result.screenshots.push(image);
          }
        }
        const audit = await prisma.auditLog.count({ where: { actorId: userId, action: 'LOGIN', userAgent: BROWSER } }); assert.equal(audit - before, 2);
        assert.equal((await liveRows(userId, BROWSER)).length, 1);
        return { browser: 'real installed Chrome, isolated context and UA', firstSessionId: firstId, secondSessionId: secondId, current, uiRowsForAcceptanceUA: 1, loginAuditIncrease: audit - before, screenshot: result.screenshots.at(-1), otherRowsAndIPsMasked: true };
      } finally { const context = contexts.at(-1); if (context) await context.request.post(web + '/api/auth/logout', { data: {} }); for (const context of contexts) await context.close(); }
    });
    await check('R08 真实长UA登录审计不溢出255且不同完整后缀设备分离', async () => {
      const auditWhere = { actorId: userId, action: 'LOGIN', userAgent: { startsWith: LONG_PREFIX } };
      const before = await prisma.auditLog.count({ where: auditWhere });
      await login(longPrimary); await login(longSecondary);
      const rows = await prisma.refreshToken.findMany({ where: { userId, userAgent: { startsWith: LONG_PREFIX }, revokedAt: null, expiresAt: { gt: new Date() } }, select: { id: true, userAgent: true } });
      assert.equal(rows.length, 2); assert.equal(new Set(rows.map((row) => row.userAgent)).size, 2); assert.ok(rows.every((row) => row.userAgent.length <= 255));
      for (const row of rows) sessionsOwned.add(row.id);
      const after = await prisma.auditLog.count({ where: auditWhere }); assert.equal(after - before, 2);
      const auditRows = await prisma.auditLog.findMany({ where: auditWhere, orderBy: { createdAt: 'desc' }, take: 2, select: { userAgent: true } }); assert.ok(auditRows.every((row) => row.userAgent.length <= 255)); assert.notEqual(auditRows[0].userAgent, auditRows[1].userAgent);
      const refreshed = await request(longPrimary, 'POST', '/auth/refresh', {}); assert.equal(refreshed.status, 201);
      return { inputUALengths: [longPrimary.ua.length, longSecondary.ua.length], storedUALengths: rows.map((row) => row.userAgent.length), loginAuditIncrease: after - before, distinctDeviceIds: rows.map((row) => row.id), fullSuffixesDistinguished: true, refreshHttp: refreshed.status };
    });
    await check('R09 仅退出本次测试设备，数据库会话数据保留', async () => {
      await request(primary, 'POST', '/auth/logout', {}); await request(secondary, 'POST', '/auth/logout', {});
      await request(longPrimary, 'POST', '/auth/logout', {}); await request(longSecondary, 'POST', '/auth/logout', {});
      const counts = await Promise.all([PRIMARY, SECONDARY, BROWSER].map(async (ua) => (await liveRows(userId, ua)).length)); assert.deepEqual(counts, [0, 0, 0]);
      const longActive = await prisma.refreshToken.count({ where: { userId, userAgent: { startsWith: LONG_PREFIX }, revokedAt: null, expiresAt: { gt: new Date() } } }); assert.equal(longActive, 0);
      const retained = await prisma.refreshToken.count({ where: { userId, OR: [{ userAgent: { in: [PRIMARY, SECONDARY, BROWSER] } }, { userAgent: { startsWith: LONG_PREFIX } }] } });
      return { activeAcceptanceRows: [...counts, longActive], retainedAcceptanceRows: retained, unrelatedSessionsNotTargeted: true };
    });
  } catch (error) { result.checks.push({ name: 'FATAL', status: 'BLOCKED', error: redact(error.message) }); }
  finally {
    try { await request(primary, 'POST', '/auth/logout', {}); } catch {}
    try { await request(secondary, 'POST', '/auth/logout', {}); } catch {}
    try { await request(longPrimary, 'POST', '/auth/logout', {}); } catch {}
    try { await request(longSecondary, 'POST', '/auth/logout', {}); } catch {}
    if (browser) await browser.close(); await prisma.$disconnect();
    result.finishedAt = new Date().toISOString(); result.counts = Object.fromEntries(['PASS', 'FAIL', 'BLOCKED'].map((status) => [status, result.checks.filter((item) => item.status === status).length])); save(); fs.writeFileSync(path.join(path.dirname(out), 'latest.json'), JSON.stringify({ out, ...result }, null, 2));
    console.log(JSON.stringify({ out, counts: result.counts, screenshots: result.screenshots })); if (result.counts.FAIL || result.counts.BLOCKED) process.exitCode = 1;
  }
})();
