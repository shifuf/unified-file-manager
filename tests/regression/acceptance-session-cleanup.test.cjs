const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const acceptanceDirectory = path.resolve(__dirname, '../acceptance');
const ownCookie = 'ufm_access=synthetic-script-access; ufm_refresh=synthetic-script-refresh';
const credentials = { ADMIN_USERNAME: 'synthetic-script-user', ADMIN_PASSWORD: 'SyntheticOnly' };

// Execute the real acceptance entrypoints. Only their external filesystem, HTTP and
// browser boundaries are replaced so a post-login failure cannot touch live data.
async function runScript(name, { logoutFails = false } = {}) {
  const requests = [], events = [];
  const scriptProcess = { env: { ACCEPTANCE_API: 'http://127.0.0.1:3001/api' }, exitCode: 0 };
  const environmentText = Object.entries(credentials).map(([key, value]) => `${key}=${value}`).join('\n');
  const metadata = JSON.stringify({ project: { id: 'synthetic-project', name: 'Synthetic', url: 'http://localhost:5175/projects/synthetic-project' }, out: 'synthetic-output' });
  const readFile = (filename) => String(filename).endsWith('.env') ? environmentText : metadata;
  const fileBoundary = { readFileSync: readFile, writeFileSync() {}, mkdirSync() {} };
  const filePromisesBoundary = { readFile: async (filename) => Buffer.from(readFile(filename)), writeFile: async () => {}, mkdir: async () => {} };
  let loggedIn = false;
  const browserContext = {
    cookies: async () => loggedIn ? [{ name: 'ufm_refresh', value: 'synthetic-script-refresh' }] : [],
    request: {
      post: async (url) => {
        requests.push({ url, method: 'POST', cookie: loggedIn ? ownCookie : '' });
        events.push('logout');
        if (logoutFails) throw new Error('Synthetic logout failure');
        return { status: () => 200, ok: () => true, json: async () => ({ success: true }) };
      },
    },
    close: async () => { events.push('context closed'); },
  };
  const input = { fill: async () => {} };
  browserContext.newPage = async () => ({
    on() {},
    goto: async () => {},
    locator: () => input,
    getByRole: () => ({ click: async () => { loggedIn = true; } }),
    waitForURL: async () => { throw new Error('Synthetic acceptance stopped after login'); },
  });
  const browserBoundary = { chromium: { launch: async () => ({ newContext: async () => browserContext, close: async () => { events.push('browser closed'); } }) } };
  const networkBoundary = async (url, options = {}) => {
    const route = new URL(url).pathname;
    requests.push({ url, method: options.method || 'GET', cookie: options.headers?.cookie || options.headers?.Cookie || '' });
    if (route.endsWith('/auth/login')) {
      return new Response(JSON.stringify({ requiresTotp: false }), {
        status: 201,
        headers: [['Set-Cookie', 'ufm_access=synthetic-script-access; HttpOnly'], ['Set-Cookie', 'ufm_refresh=synthetic-script-refresh; HttpOnly']],
      });
    }
    if (route.endsWith('/auth/logout')) {
      events.push('logout');
      if (logoutFails) throw new Error('Synthetic logout failure');
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    return new Response(JSON.stringify({ message: 'Synthetic post-login failure' }), { status: 500 });
  };
  const filename = path.join(acceptanceDirectory, name);
  const result = vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    __dirname: acceptanceDirectory,
    __filename: filename,
    process: scriptProcess,
    Buffer,
    URL,
    AbortSignal,
    fetch: networkBoundary,
    console: { log() {}, error() {} },
    require(moduleName) {
      if (moduleName === 'node:fs') return fileBoundary;
      if (moduleName === 'node:fs/promises') return filePromisesBoundary;
      if (moduleName === 'dotenv') return { parse: () => credentials };
      if (moduleName.includes('playwright')) return browserBoundary;
      if (moduleName.startsWith('node:')) return require(moduleName);
      throw new Error(`Unexpected acceptance dependency: ${moduleName}`);
    },
  }, { filename });
  await result;
  return { requests, events, scriptProcess };
}

for (const name of ['download-storage-layout.cjs', 'storage-visibility-browser.cjs', 'replica-browser-real.cjs', 'backup-integrity.cjs', 'real-cloud.cjs']) {
  test(`${name} logs out only its own cookie after a post-login failure`, {
    skip: fs.existsSync(path.join(acceptanceDirectory, name)) ? false : 'Optional local legacy acceptance script is absent from this checkout',
  }, async () => {
    const result = await runScript(name);
    const logout = result.requests.filter((request) => new URL(request.url).pathname.endsWith('/auth/logout'));
    assert.equal(logout.length, 1, 'failed acceptance must not leave a live script session');
    assert.equal(logout[0].method, 'POST');
    assert.equal(logout[0].cookie, ownCookie);
    assert.ok(result.requests.every((request) => !new URL(request.url).pathname.includes('/auth/sessions')), 'cleanup cannot revoke another client');
    if (result.events.includes('browser closed')) {
      assert.ok(result.events.indexOf('logout') < result.events.indexOf('browser closed'), 'logout must use the live isolated cookie context');
    }
    assert.equal(result.scriptProcess.exitCode, 1, 'original acceptance failure must remain visible');
  });
}

for (const name of ['download-storage-layout.cjs', 'storage-visibility-browser.cjs', 'replica-browser-real.cjs']) {
  test(`${name} closes its browser even when its own logout fails`, {
    skip: fs.existsSync(path.join(acceptanceDirectory, name)) ? false : 'Optional local legacy acceptance script is absent from this checkout',
  }, async () => {
    const result = await runScript(name, { logoutFails: true });
    assert.equal(result.requests.filter((request) => new URL(request.url).pathname.endsWith('/auth/logout')).length, 1);
    assert.ok(result.events.includes('browser closed'));
    assert.equal(result.scriptProcess.exitCode, 1);
  });
}
