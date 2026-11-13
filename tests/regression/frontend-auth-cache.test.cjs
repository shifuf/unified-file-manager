const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const vue = require('vue');
const pinia = require('pinia');
const profile = { id: 'synthetic-user', username: 'fixture-admin', displayName: 'Fixture', role: 'SUPER_ADMIN', mustChangePassword: false };
function fixture(raw) {
  const cache = new Map(raw === undefined ? [] : [['ufm_user_profile', raw]]);
  const module = { exports: {} };
  pinia.setActivePinia(pinia.createPinia());
  const source = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../../apps/web/src/stores/auth.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(source, { module, exports: module.exports, JSON, String,
    localStorage: { getItem: key => cache.get(key) ?? null, setItem: (key, value) => cache.set(key, value), removeItem: key => cache.delete(key) },
    require(name) { if (name === 'vue') return vue; if (name === 'pinia') return pinia; if (name === '@/api/modules') return { authApi: { profile: async () => profile, login: async () => ({ requiresTotp: false, user: profile }) } }; throw new Error(name); },
  });
  return { store: module.exports.useAuthStore(), cache };
}
for (const raw of ['{broken', 'null', '[]', '"user"', '{}', '{"id":"u","username":"x","role":"SUPER_ADMIN","mustChangePassword":"false"}']) {
  test(`invalid cached profile ${raw} clears without breaking initialization`, () => {
    const f = fixture(raw);
    assert.equal(f.store.currentUser, null);
    assert.equal(f.store.loggedIn, false);
    assert.equal(f.cache.has('ufm_user_profile'), false);
  });
}
test('valid cached profile keeps the authenticated session', () => {
  const f = fixture(JSON.stringify(profile));
  assert.equal(f.store.currentUser.id, 'synthetic-user');
  assert.equal(f.store.loggedIn, true);
  assert.equal(f.cache.has('ufm_user_profile'), true);
});
test('cookie profile and a fresh login recover after invalid cache is cleared', async () => {
  const f = fixture('{broken');
  await f.store.loadProfile();
  assert.equal(f.store.loggedIn, true);
  assert.equal(JSON.parse(f.cache.get('ufm_user_profile')).id, 'synthetic-user');
  f.store.logoutLocal();
  await f.store.login({ username: 'fixture-admin', password: 'SyntheticOnly' });
  assert.equal(f.store.currentUser.id, 'synthetic-user');
  assert.equal(f.store.loggedIn, true);
});
