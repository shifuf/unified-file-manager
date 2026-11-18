const assert = require('node:assert/strict');
const path = require('node:path');
const { once } = require('node:events');
const { test } = require('node:test');
const express = require('express');

require('ts-node').register({ project: path.resolve(__dirname, '../../apps/api/tsconfig.json'), transpileOnly: true });
const { registerJsonBodyParsers } = require('../../apps/api/src/common/utils/json-body.util.ts');

test('WebDAV PUT receives the original JSON bytes and ordinary API JSON still has rawBody', async () => {
  const app = express();
  registerJsonBodyParsers(app);
  app.put('/api/dav/project/snapshot.json', async (request, response, next) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      response.send(Buffer.concat(chunks));
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/dav/settings', (request, response) => {
    response.json({ body: request.body, raw: request.rawBody.toString() });
  });
  app.post('/api/other', (request, response) => {
    response.json({ body: request.body, raw: request.rawBody.toString() });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const headers = { 'Content-Type': 'application/json' };
    const large = JSON.stringify({ snapshot: 'a'.repeat(130_000) });
    const upload = await fetch(`${origin}/api/dav/project/snapshot.json`, { method: 'PUT', headers, body: large });
    assert.equal(upload.status, 200);
    assert.equal(await upload.text(), large);

    const small = '{ "value": 1 }';
    for (const url of ['/api/dav/settings', '/api/other']) {
      const regular = await fetch(origin + url, { method: 'POST', headers, body: small });
      assert.deepEqual(await regular.json(), { body: { value: 1 }, raw: small });
    }
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
