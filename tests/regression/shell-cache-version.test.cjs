const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture() {
  const origin = 'https://ufm.test';
  const absolute = input => new URL(typeof input === 'string' ? input : input.url, origin).href;
  const stores = new Map([['ufm-shell-v2', new Map([[`${origin}/favicon.svg`, new Response('old icon')]])]]);
  const handlers = {}, fetched = [], deleted = [];
  let skipped = false, claimed = false;
  const fetchAsset = async input => { const url = absolute(input); fetched.push(url); return new Response(url.endsWith('/favicon.svg') ? 'new v0.3.0 icon' : 'new shell', { status: 200 }); };
  const caches = {
    open: async name => {
      if (!stores.has(name)) stores.set(name, new Map());
      const entries = stores.get(name);
      return {
        addAll: async paths => { for (const input of paths) entries.set(absolute(input), await fetchAsset(input)); },
        put: async (request, response) => { entries.set(absolute(request), response.clone()); },
      };
    },
    keys: async () => [...stores.keys()],
    delete: async name => { deleted.push(name); return stores.delete(name); },
    match: async request => { for (const entries of stores.values()) { const found = entries.get(absolute(request)); if (found) return found.clone(); } },
  };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../apps/web/public/sw.js'), 'utf8'), {
    URL, Promise, caches, fetch: fetchAsset,
    self: {
      location: { origin },
      skipWaiting: () => { skipped = true; },
      clients: { claim: async () => { claimed = true; } },
      addEventListener: (name, handler) => { handlers[name] = handler; },
    },
  });
  return {
    stores, fetched, deleted, skipped: () => skipped, claimed: () => claimed,
    lifecycle: async name => { const work = []; handlers[name]({ waitUntil: promise => work.push(promise) }); await Promise.all(work); },
    request: async (pathname, method = 'GET') => {
      let response;
      handlers.fetch({ request: new Request(origin + pathname, { method }), respondWith: result => { response = result; } });
      return response ? await response : null;
    },
  };
}

test('v0.3.0 activation discards the old shell cache and serves the newly fetched favicon', async () => {
  const f = fixture();
  assert.equal(await (await f.request('/favicon.svg')).text(), 'old icon');
  await f.lifecycle('install');
  await f.lifecycle('activate');
  assert.deepEqual([...f.stores.keys()], ['ufm-shell-v0.3.0']);
  assert.deepEqual(f.deleted, ['ufm-shell-v2']);
  assert.equal(f.skipped(), true);
  assert.equal(f.claimed(), true);
  assert.equal(await (await f.request('/favicon.svg')).text(), 'new v0.3.0 icon');
  assert.equal(f.fetched.filter(url => url.endsWith('/favicon.svg')).length, 1, 'install refreshes the icon once, then the new cache serves it');
});

test('the release cache update keeps API requests and writes outside the shell cache', async () => {
  const f = fixture();
  await f.lifecycle('install'); await f.lifecycle('activate');
  const fetched = f.fetched.length;
  assert.equal(await f.request('/api/shares/token'), null);
  assert.equal(await f.request('/files', 'POST'), null);
  assert.equal(f.fetched.length, fetched);
});
