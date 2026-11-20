const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { ConfigService } = require('@nestjs/config');
const { JwtService } = require('@nestjs/jwt');
const root = path.resolve(__dirname, '../..');
require('ts-node').register({ project: path.join(root, 'apps/api/tsconfig.json'), transpileOnly: true });
const { AuthService } = require('../../apps/api/src/auth/auth.service.ts');

const device = { ip: '127.0.0.8', userAgent: 'AcceptanceBrowser/1.0 desktop' };
const credentials = { username: 'isolated-regression-admin', password: 'SyntheticRegression@9281' };
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
const copy = (value) => structuredClone(value);

// External DB boundary only: run the real AuthService, bcrypt and JWT signer.
// Equality, updateMany CAS, ordering and transaction serialization mirror Prisma.
function matches(row, where = {}) {
  return Object.entries(where).every(([key, wanted]) => {
    if (wanted === undefined) return true;
    if (key === 'AND') return wanted.every((part) => matches(row, part));
    if (key === 'OR') return wanted.some((part) => matches(row, part));
    if (key === 'NOT') return !matches(row, wanted);
    const actual = row[key];
    if (wanted && typeof wanted === 'object' && !(wanted instanceof Date)) {
      return Object.entries(wanted).every(([operator, value]) => {
        if (operator === 'not') return actual !== value;
        if (operator === 'gt') return actual > value;
        if (operator === 'gte') return actual >= value;
        if (operator === 'lt') return actual < value;
        if (operator === 'in') return value.includes(actual);
        if (operator === 'startsWith') return typeof actual === 'string' && actual.startsWith(value);
        if (operator === 'endsWith') return typeof actual === 'string' && actual.endsWith(value);
        if (operator === 'equals') return actual === value;
        throw new Error(`Unimplemented DB filter ${operator}`);
      });
    }
    return actual === wanted;
  });
}

async function fixture() {
  const user = { id: 'regression-user', username: credentials.username, passwordHash: await bcrypt.hash(credentials.password, 4), displayName: 'Synthetic admin', role: 'SUPER_ADMIN', enabled: true, totpEnabled: false, totpSecret: null, mustChangePassword: false };
  const rows = [], audits = [];
  let id = 0, transactionTail = Promise.resolve();
  const list = ({ where, orderBy, take } = {}) => {
    let found = rows.filter((row) => matches(row, where));
    for (const order of (Array.isArray(orderBy) ? orderBy : [orderBy]).reverse()) {
      if (!order) continue;
      const [field, direction] = Object.entries(order)[0];
      found = found.slice().sort((a, b) => (a[field] < b[field] ? -1 : a[field] > b[field] ? 1 : 0) * (direction === 'desc' ? -1 : 1));
    }
    return copy(take === undefined ? found : found.slice(0, take));
  };
  const tokens = {
    findUnique: async ({ where }) => copy(rows.find((row) => matches(row, where)) || null),
    findFirst: async (query) => list(query)[0] || null,
    findMany: async (query) => list(query),
    create: async ({ data }) => {
      if (rows.some((row) => row.tokenHash === data.tokenHash)) throw new Error('Unique tokenHash');
      const row = { id: `session-${++id}`, createdAt: new Date(), revokedAt: null, replacedById: null, userAgent: null, ip: null, ...copy(data) };
      rows.push(row); return copy(row);
    },
    update: async ({ where, data }) => {
      const row = rows.find((entry) => matches(entry, where));
      if (!row) throw new Error('Record to update not found');
      Object.assign(row, copy(data)); return copy(row);
    },
    updateMany: async ({ where, data }) => {
      const selected = rows.filter((row) => matches(row, where));
      for (const row of selected) Object.assign(row, copy(data));
      return { count: selected.length };
    },
  };
  const prisma = {
    user: { findUnique: async ({ where }) => matches(user, where) ? copy(user) : null },
    refreshToken: tokens,
    $queryRaw: async () => [{ id: user.id }],
    $transaction: async (fn) => {
      const before = transactionTail; let release;
      transactionTail = new Promise((resolve) => { release = resolve; });
      await before;
      const snapshot = copy(rows);
      try { return await fn(prisma); } catch (error) { rows.splice(0, rows.length, ...snapshot); throw error; } finally { release(); }
    },
  };
  const config = new ConfigService({ NODE_ENV: 'test', JWT_SECRET: crypto.randomBytes(32).toString('hex'), JWT_REFRESH_EXPIRES_DAYS: 30 });
  const jwt = new JwtService({ secret: crypto.randomBytes(32).toString('hex') });
  const makeService = () => new AuthService({ write: async (entry) => { audits.push(copy(entry)); } }, config, jwt, prisma);
  const service = makeService();
  const login = (meta = device, target = service) => target.login(credentials, meta);
  const active = () => rows.filter((row) => !row.revokedAt && row.expiresAt.getTime() > Date.now());
  return { user, rows, audits, service, makeService, login, active, jwt, tokens };
}

test('sequential explicit logins reuse one device row but append each LOGIN audit', async () => {
  const f = await fixture();
  const first = await f.login(), firstId = f.active()[0].id;
  const second = await f.login(), third = await f.login();
  assert.equal(f.audits.filter((entry) => entry.action === 'LOGIN').length, 3);
  assert.equal(f.active().length, 1);
  assert.equal(f.rows.length, 1);
  assert.equal(f.active()[0].id, firstId);
  assert.notEqual(first.refreshToken, second.refreshToken);
  assert.notEqual(second.refreshToken, third.refreshToken);
  await assert.rejects(f.service.refresh(first.refreshToken, device), (error) => error.getStatus() === 401);
  assert.equal(f.jwt.verify(third.accessToken).sub, f.user.id);
});

test('automatic refresh rotates credentials and expiry on the same row without LOGIN audit', async () => {
  const f = await fixture();
  let session = await f.login();
  const id = f.active()[0].id, createdAt = f.active()[0].createdAt, expiry = f.active()[0].expiresAt;
  for (let i = 0; i < 3; i++) session = await f.service.refresh(session.refreshToken, device);
  assert.equal(f.active().length, 1);
  assert.equal(f.rows.length, 1);
  assert.equal(f.active()[0].id, id);
  assert.deepEqual(f.active()[0].createdAt, createdAt);
  assert.ok(f.active()[0].expiresAt >= expiry);
  assert.equal(f.active()[0].tokenHash, digest(session.refreshToken));
  assert.equal(f.audits.filter((entry) => entry.action === 'LOGIN').length, 1);
});

test('concurrent logins across service instances cannot create duplicate device rows', async () => {
  const f = await fixture();
  await Promise.all([f.login(device), f.login(device, f.makeService()), f.login(device), f.login(device, f.makeService())]);
  assert.equal(f.active().length, 1);
  assert.equal(f.rows.length, 1);
  assert.equal(f.audits.filter((entry) => entry.action === 'LOGIN').length, 4);
});

test('concurrent refresh across instances returns one replacement and preserves the session ID', async () => {
  const f = await fixture();
  const first = await f.login(), id = f.active()[0].id;
  const refreshed = await Promise.all([f.service.refresh(first.refreshToken, device), f.makeService().refresh(first.refreshToken, device)]);
  assert.equal(refreshed[0].refreshToken, refreshed[1].refreshToken);
  assert.notEqual(first.refreshToken, refreshed[0].refreshToken);
  assert.equal(f.active().length, 1);
  assert.equal(f.rows.length, 1);
  assert.equal(f.active()[0].id, id);
  assert.equal(f.active()[0].tokenHash, digest(refreshed[0].refreshToken));
});

test('refresh grace is bounded and old tokens never become current again', async (t) => {
  const f = await fixture();
  const now = Date.now(); t.mock.method(Date, 'now', () => now);
  const initial = await f.login();
  const next = await f.service.refresh(initial.refreshToken, device);
  const grace = await f.makeService().refresh(initial.refreshToken, device);
  assert.equal(grace.refreshToken, next.refreshToken);
  assert.equal(f.active()[0].tokenHash, digest(next.refreshToken));
  t.mock.method(Date, 'now', () => now + 6001);
  await assert.rejects(f.service.refresh(initial.refreshToken, device), (error) => error.getStatus() === 401);
  const current = await f.service.refresh(next.refreshToken, device);
  assert.equal(f.active().length, 1);
  assert.equal(f.active()[0].tokenHash, digest(current.refreshToken));
});

test('relogin clears the rotation grace and does not revoke another device', async () => {
  const f = await fixture();
  const first = await f.login();
  const rotated = await f.service.refresh(first.refreshToken, device);
  const other = await f.login({ ...device, ip: '127.0.0.9' });
  const relogin = await f.login();
  for (const old of [first.refreshToken, rotated.refreshToken]) await assert.rejects(f.service.refresh(old, device), (error) => error.getStatus() === 401);
  assert.equal(f.active().length, 2);
  assert.ok(f.active().some((row) => row.tokenHash === digest(other.refreshToken)));
  assert.ok(f.active().some((row) => row.tokenHash === digest(relogin.refreshToken)));
});

test('revoked legacy refresh reuse rejects without issuing a session or revoking other devices', async () => {
  const f = await fixture();
  const other = await f.login({ ...device, ip: '127.0.0.9' });
  f.rows.push({ id: 'legacy-revoked', userId: f.user.id, tokenHash: digest('legacy-old'), revokedAt: new Date(), replacedById: digest(other.refreshToken), expiresAt: new Date(Date.now() + 86400000), createdAt: new Date(), ...device });
  await assert.rejects(f.service.refresh('legacy-old', device), (error) => error.getStatus() === 401);
  assert.equal(f.active().length, 1);
  assert.equal(f.active()[0].tokenHash, digest(other.refreshToken));
  await assert.rejects(f.service.refresh('unknown-token', device), (error) => error.getStatus() === 401);
  assert.equal(f.active().length, 1);
});

test('full UA suffix and IP separate devices while repeated long-UA login is consolidated', async () => {
  const f = await fixture();
  const prefix = 'LongBrowser/'.repeat(30);
  await f.login({ ...device, userAgent: prefix + 'device-A' });
  await f.login({ ...device, userAgent: prefix + 'device-B' });
  await f.login({ ...device, userAgent: prefix + 'device-A' });
  await f.login({ ...device, ip: '127.0.0.9', userAgent: prefix + 'device-A' });
  assert.equal(f.active().length, 3);
  assert.equal(new Set(f.active().map((row) => `${row.ip}|${row.userAgent}`)).size, 3);
  assert.ok(f.active().every((row) => row.userAgent.length <= 255));
});

test('session list merges legacy duplicates with current row preferred even beyond 50 rows', async () => {
  const f = await fixture();
  const current = await f.login();
  const currentId = f.active()[0].id;
  f.active()[0].createdAt = new Date('2020-01-01');
  for (let i = 0; i < 60; i++) f.rows.push({ id: `legacy-${i}`, userId: f.user.id, tokenHash: digest(`legacy-${i}`), revokedAt: null, replacedById: null, expiresAt: new Date(Date.now() + 86400000), createdAt: new Date(Date.now() + i), ...device });
  await f.login({ ...device, ip: '127.0.0.9' });
  const sessions = await f.service.listSessions(f.user, current.refreshToken);
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].id, currentId);
  assert.equal(sessions[0].current, true);
  assert.equal(sessions[1].ip, '127.0.0.9');
  assert.equal(f.rows.filter((row) => row.revokedAt === null).length, 62, 'listing must not alter other stored sessions');
});

test('same-device login consolidates legacy live rows without touching another device', async () => {
  const f = await fixture();
  const old = await f.login();
  f.rows.push({ ...copy(f.active()[0]), id: 'legacy-duplicate', tokenHash: digest('legacy-duplicate'), createdAt: new Date(Date.now() + 1) });
  const other = await f.login({ ...device, ip: '127.0.0.9' });
  await f.login();
  assert.equal(f.active().length, 2);
  assert.ok(f.active().some((row) => row.tokenHash === digest(other.refreshToken)));
  await assert.rejects(f.service.refresh(old.refreshToken, device), (error) => error.getStatus() === 401);
});

test('logout invalidates only the selected device and prevents grace reuse', async () => {
  const f = await fixture();
  const first = await f.login(), rotated = await f.service.refresh(first.refreshToken, device);
  const other = await f.login({ ...device, ip: '127.0.0.9' });
  await f.service.revokeRefreshToken(rotated.refreshToken);
  for (const token of [first.refreshToken, rotated.refreshToken]) await assert.rejects(f.service.refresh(token, device), (error) => error.getStatus() === 401);
  assert.equal(f.active().length, 1);
  assert.equal(f.active()[0].tokenHash, digest(other.refreshToken));
});

test('a token presented with a different device identity cannot rotate its session', async () => {
  const f = await fixture(), first = await f.login();
  await assert.rejects(f.service.refresh(first.refreshToken, { ...device, userAgent: 'AnotherBrowser' }), (error) => error.getStatus() === 401);
  assert.equal(f.active()[0].tokenHash, digest(first.refreshToken));
  assert.equal(f.active().length, 1);
});

test('a short UA imitating a stored long-UA fingerprint remains a distinct device', async () => {
  const f = await fixture();
  await f.login({ ...device, userAgent: 'Browser/'.repeat(40) + 'full-original-UA' });
  const storedRepresentation = f.active()[0].userAgent;
  await f.login({ ...device, userAgent: storedRepresentation });
  assert.equal(f.active().length, 2);
});

test('failed token CAS rejects refresh without issuing or modifying another device', async () => {
  const f = await fixture(), first = await f.login();
  const other = await f.login({ ...device, ip: '127.0.0.9' });
  const updateMany = f.tokens.updateMany;
  f.tokens.updateMany = async (query) => query.where.tokenHash === digest(first.refreshToken) ? { count: 0 } : updateMany(query);
  await assert.rejects(f.service.refresh(first.refreshToken, device), (error) => error.getStatus() === 401);
  assert.equal(f.active().length, 2);
  assert.ok(f.active().some((row) => row.tokenHash === digest(first.refreshToken)));
  assert.ok(f.active().some((row) => row.tokenHash === digest(other.refreshToken)));
});

test('expired device token cannot revoke a different active device', async () => {
  const f = await fixture(), first = await f.login();
  const other = await f.login({ ...device, ip: '127.0.0.9' });
  f.rows.find((row) => row.tokenHash === digest(first.refreshToken)).expiresAt = new Date(Date.now() - 1);
  await assert.rejects(f.service.refresh(first.refreshToken, device), (error) => error.getStatus() === 401);
  assert.equal(f.active().length, 1);
  assert.equal(f.active()[0].tokenHash, digest(other.refreshToken));
});

test('revoking one displayed legacy device removes its hidden duplicates only', async () => {
  const f = await fixture();
  const current = await f.login(), selectedId = f.active()[0].id;
  f.rows.push({ ...copy(f.active()[0]), id: 'hidden-legacy', tokenHash: digest('hidden-legacy') });
  const other = await f.login({ ...device, ip: '127.0.0.9' });
  await f.service.revokeSession(f.user, selectedId);
  assert.equal(f.active().length, 1);
  assert.equal(f.active()[0].tokenHash, digest(other.refreshToken));
  for (const token of [current.refreshToken, 'hidden-legacy']) await assert.rejects(f.service.refresh(token, device), (error) => error.getStatus() === 401);
});

test('logout with the previous token during grace revokes that device and not another', async () => {
  const f = await fixture(), initial = await f.login();
  const replacement = await f.service.refresh(initial.refreshToken, device);
  const other = await f.login({ ...device, ip: '127.0.0.9' });
  await f.makeService().revokeRefreshToken(initial.refreshToken);
  assert.equal(f.active().length, 1);
  assert.equal(f.active()[0].tokenHash, digest(other.refreshToken));
  await assert.rejects(f.service.refresh(replacement.refreshToken, device), (error) => error.getStatus() === 401);
});

test('previous logout after grace cannot invalidate the current replacement', async (t) => {
  const f = await fixture(), now = Date.now(); t.mock.method(Date, 'now', () => now);
  const initial = await f.login(), replacement = await f.service.refresh(initial.refreshToken, device);
  t.mock.method(Date, 'now', () => now + 6001);
  await f.service.revokeRefreshToken(initial.refreshToken);
  assert.equal(f.active().length, 1);
  assert.equal(f.active()[0].tokenHash, digest(replacement.refreshToken));
});

test('an old logout cannot invalidate a newer explicit login on the same row', async () => {
  const f = await fixture(), initial = await f.login();
  const replacement = await f.service.refresh(initial.refreshToken, device);
  const relogin = await f.login();
  await f.service.revokeRefreshToken(initial.refreshToken);
  await f.service.revokeRefreshToken(replacement.refreshToken);
  assert.equal(f.active().length, 1);
  assert.equal(f.active()[0].tokenHash, digest(relogin.refreshToken));
});

test('LOGIN audit fits varchar255 and retains distinct identities from the full long UA suffix', async () => {
  const f = await fixture(), prefix = 'AuditBrowser/'.repeat(30);
  await f.login({ ...device, userAgent: prefix + 'device-A' });
  await f.login({ ...device, userAgent: prefix + 'device-B' });
  const logins = f.audits.filter((entry) => entry.action === 'LOGIN');
  assert.equal(logins.length, 2);
  assert.ok(logins.every((entry) => entry.userAgent.length <= 255), 'LOGIN must fit the database UA column');
  assert.notEqual(logins[0].userAgent, logins[1].userAgent);
  assert.equal(f.active().length, 2);
});

test('a previous refresh cookie in the concurrency grace window still identifies the current session', async () => {
  const f = await fixture(), initial = await f.login();
  const currentId = f.active()[0].id;
  await f.service.refresh(initial.refreshToken, device);
  await f.login({ ...device, userAgent: 'Another browser on the same network' });
  const sessions = await f.service.listSessions(f.user, initial.refreshToken);
  assert.equal(sessions[0].id, currentId);
  assert.equal(sessions[0].current, true);
  assert.equal(sessions.filter((row) => row.current).length, 1);
});

test('exit other sessions with a concurrent previous cookie preserves the current replacement', async () => {
  const f = await fixture(), initial = await f.login();
  const currentId = f.active()[0].id;
  const replacement = await f.service.refresh(initial.refreshToken, device);
  const otherDevice = { ...device, userAgent: 'Another browser on the same network' };
  const other = await f.login(otherDevice);
  const result = await f.service.revokeOtherSessions(f.user, initial.refreshToken);
  assert.equal(result.success, true);
  assert.equal(result.revoked, 1);
  assert.deepEqual(f.active().map((row) => row.id), [currentId]);
  await f.service.refresh(replacement.refreshToken, device);
  await assert.rejects(f.service.refresh(other.refreshToken, otherDevice), (error) => error.getStatus() === 401);
});

for (const token of [undefined, 'unknown-refresh-cookie']) {
  test(`exit other sessions refuses an ${token ? 'unknown' : 'absent'} current cookie without changing any session`, async () => {
    const f = await fixture();
    await f.login();
    await f.login({ ...device, userAgent: 'Another browser on the same network' });
    const before = copy(f.rows);
    await assert.rejects(f.service.revokeOtherSessions(f.user, token), (error) => error.getStatus() === 400);
    assert.deepEqual(f.rows, before);
    assert.equal(f.audits.filter((entry) => entry.action === 'SESSION_REVOKE').length, 0);
  });
}

test('another account refresh cookie cannot authorize exit other sessions', async () => {
  const f = await fixture(), current = await f.login();
  const foreign = { ...copy(f.active()[0]), id: 'foreign-session', userId: 'another-account', tokenHash: digest('foreign-refresh-cookie') };
  f.rows.push(foreign);
  const before = copy(f.rows);
  await assert.rejects(f.service.revokeOtherSessions(f.user, 'foreign-refresh-cookie'), (error) => error.getStatus() === 400);
  assert.deepEqual(f.rows, before);
  await f.service.refresh(current.refreshToken, device);
});

test('an expired grace cookie cannot mark a current session or exit other sessions', async (t) => {
  const f = await fixture(), now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const initial = await f.login();
  const replacement = await f.service.refresh(initial.refreshToken, device);
  await f.login({ ...device, userAgent: 'Another browser on the same network' });
  t.mock.method(Date, 'now', () => now + 6001);
  const before = copy(f.rows);
  assert.ok((await f.service.listSessions(f.user, initial.refreshToken)).every((row) => !row.current));
  await assert.rejects(f.service.revokeOtherSessions(f.user, initial.refreshToken), (error) => error.getStatus() === 400);
  assert.deepEqual(f.rows, before);
  await f.service.refresh(replacement.refreshToken, device);
});

test('only active sessions appear and distinct client names at one IP remain visible', async () => {
  const f = await fixture(), current = await f.login();
  const historical = await f.login({ ...device, userAgent: 'UFM-Historical-Script' });
  const sample = copy(f.active()[0]);
  f.rows.push({ ...sample, id: 'expired-session', tokenHash: digest('expired'), userAgent: 'Expired browser', expiresAt: new Date(0) });
  f.rows.push({ ...sample, id: 'revoked-session', tokenHash: digest('revoked'), userAgent: 'Revoked browser', revokedAt: new Date() });
  const sessions = await f.service.listSessions(f.user, current.refreshToken);
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].current, true);
  assert.equal(sessions[1].userAgent, 'UFM-Historical-Script');
  assert.equal(sessions[1].current, false);
  assert.ok(f.active().some((row) => row.tokenHash === digest(historical.refreshToken)));
});
