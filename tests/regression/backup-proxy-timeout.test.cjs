const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const config = fs.readFileSync(path.resolve(__dirname, '../../infra/nginx/default.conf'), 'utf8');
const locations = [...config.matchAll(/^  location\s+(.+?)\s+\{\s*\n([\s\S]*?)^  \}/gm)]
  .map(([, selector, body]) => ({ selector, body }));

// Evaluate the prefix/ordered-regex locations used by this nginx template.
// Runtime nginx -t remains part of the deployment image check.
function proxyFor(url) {
  const uri = new URL(url, 'http://localhost').pathname;
  const prefix = locations.filter(location => location.selector.startsWith('/') && uri.startsWith(location.selector))
    .sort((a, b) => b.selector.length - a.selector.length)[0];
  const selected = locations.find(location => location.selector.startsWith('~ ') && new RegExp(location.selector.slice(2)).test(uri)) ?? prefix;
  assert.ok(selected, `No nginx location for ${uri}`);
  const directives = [...selected.body.matchAll(/^\s*([a-z_]+)\s+([^;\n]+);/gm)];
  return {
    value: name => directives.find(([, key]) => key === name)?.[2].trim(),
    headers: Object.fromEntries(directives.filter(([, key]) => key === 'proxy_set_header')
      .map(([, , value]) => value.trim().split(/\s+/, 2))),
  };
}

test('administrator backup creation and archive routes allow thirty minutes for upstream completion', () => {
  for (const route of ['/api/backups', '/api/backups?limit=10', '/api/backups/', '/api/backups/import', '/api/backups/fixture/download', '/api/backups/fixture/restore']) {
    const proxy = proxyFor(route);
    assert.equal(proxy.value('proxy_read_timeout'), '1800s', route);
    assert.equal(proxy.value('proxy_send_timeout'), '1800s', route);
    assert.equal(proxy.value('proxy_pass'), 'http://api:${APP_PORT}', 'regex proxy must preserve the complete request URI');
  }
});

test('backup proxy retains streamed uploads, archive Range downloads and forwarding headers', () => {
  const proxy = proxyFor('/api/backups/fixture/download');
  assert.equal(proxy.value('proxy_http_version'), '1.1');
  assert.equal(proxy.value('proxy_request_buffering'), 'off');
  assert.equal(proxy.value('proxy_buffering'), 'off');
  assert.equal(proxy.value('proxy_hide_header'), 'X-Powered-By');
  assert.deepEqual(proxy.headers, {
    Host: '$http_host', 'X-Forwarded-Host': '$http_host', 'X-Real-IP': '$remote_addr',
    'X-Forwarded-For': '$proxy_add_x_forwarded_for', 'X-Forwarded-Proto': '$proxy_x_forwarded_proto',
    Range: '$http_range', 'If-Range': '$http_if_range',
  });
});

test('backup timeout does not expand to similarly named or unrelated API routes', () => {
  const routes = [
    ['/api/backups-other', '300s'], ['/api/backupsExtra/id', '300s'], ['/api/files/fixture', '300s'],
    ['/api/public/files/fixture', '300s'], ['/api/dav/project/file', '3600s'],
    ['/api/storage-configs/cloud/remote-files/import-jobs', '36600s'],
  ];
  for (const [route, timeout] of routes) {
    const proxy = proxyFor(route);
    assert.equal(proxy.value('proxy_read_timeout'), timeout, route);
    assert.equal(proxy.value('proxy_send_timeout'), timeout, route);
  }
});
