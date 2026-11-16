const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { CloudflareR2Adapter } = require('../../plugins/cloudflare-r2/dist/index.cjs');
const { presignS3 } = require('../../packages/storage-plugin-sdk/dist/s3.js');
const accountId = '0123456789abcdef0123456789abcdef';
const config = { id: 'r2', provider: 'CLOUDFLARE_R2', name: 'R2 test', config: { accountId, bucket: 'private-bucket', accessKeyId: 'test-access', secretAccessKey: 'test-secret', domain: 'https://public.example.com' } };
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const mac = (key, value) => crypto.createHmac('sha256', key).update(value).digest();
const encode = value => encodeURIComponent(value).replace(/[!'()*]/g, ch => '%' + ch.charCodeAt(0).toString(16).toUpperCase());

// Independent wire-level verifier: does not use SDK signing functions.
function signatureValid(url, method, headers, bytes) {
  const auth = headers.authorization;
  const querySigned = url.searchParams.has('X-Amz-Signature');
  const credential = querySigned ? url.searchParams.get('X-Amz-Credential') : /Credential=([^, ]+)/.exec(auth || '')?.[1];
  const signedNames = querySigned ? url.searchParams.get('X-Amz-SignedHeaders') : /SignedHeaders=([^, ]+)/.exec(auth || '')?.[1];
  const signature = querySigned ? url.searchParams.get('X-Amz-Signature') : /Signature=(\w+)/.exec(auth || '')?.[1];
  const date = querySigned ? url.searchParams.get('X-Amz-Date') : headers['x-amz-date'];
  if (!credential || !signedNames || !date || !signature) return false;
  const [access, day, region, service, terminal] = credential.split('/');
  if (access !== 'test-access' || region !== 'auto' || service !== 's3' || terminal !== 'aws4_request') return false;
  const issued = Date.parse(date.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z'));
  if (querySigned && (Date.now() - issued > Number(url.searchParams.get('X-Amz-Expires')) * 1000 || issued > Date.now() + 60_000)) return false;
  const query = [...url.searchParams].filter(([k]) => k !== 'X-Amz-Signature').sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${encode(k)}=${encode(v)}`).join('&');
  const canonicalHeaders = signedNames.split(';').map(name => `${name}:${name === 'host' ? url.host : String(headers[name]).trim().replace(/\s+/g, ' ')}\n`).join('');
  const payloadHash = querySigned ? 'UNSIGNED-PAYLOAD' : headers['x-amz-content-sha256'];
  if (!querySigned && payloadHash !== sha(bytes)) return false;
  const canonical = [method, url.pathname, query, canonicalHeaders, signedNames, payloadHash].join('\n');
  const scope = `${day}/${region}/${service}/${terminal}`;
  const signing = mac(mac(mac(mac('AWS4test-secret', day), region), service), terminal);
  const expected = mac(signing, ['AWS4-HMAC-SHA256', date, scope, sha(canonical)].join('\n')).toString('hex');
  return signature === expected;
}

test('R2 rejects alternate hosts, credentials in URLs, non-HTTPS and account mismatch', async () => {
  const adapter = new CloudflareR2Adapter();
  for (const endpoint of ['http://example.com', 'https://example.com', `https://evil@${accountId}.r2.cloudflarestorage.com`, `https://${accountId}.r2.cloudflarestorage.com/other`, 'https://ffffffffffffffffffffffffffffffff.r2.cloudflarestorage.com']) {
    await assert.rejects(() => adapter.getDownloadUrl({ ...config, config: { ...config.config, endpoint } }, 'key', 60));
  }
  const url = new URL(await adapter.getDownloadUrl({ ...config, config: { ...config.config, endpoint: `https://${accountId}.eu.r2.cloudflarestorage.com` } }, 'key', 60));
  assert.equal(url.hostname, `${accountId}.eu.r2.cloudflarestorage.com`);
  assert.match(url.searchParams.get('X-Amz-Credential'), /\/auto\/s3\/aws4_request$/);
});

test('R2 protocol lifecycle verifies SigV4, streaming, range, private GET/PUT, expiry and failures', async () => {
  const objects = new Map();
  const service = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    const url = new URL(req.headers['x-test-original-url']);
    if (!signatureValid(url, req.method, req.headers, bytes)) { res.writeHead(403).end('signature rejected'); return; }
    if (url.pathname.endsWith('/service-error')) { res.writeHead(503).end(); return; }
    if (req.method === 'PUT') { objects.set(url.pathname, bytes); res.writeHead(200).end(); return; }
    if (req.method === 'DELETE') { objects.delete(url.pathname); res.writeHead(204).end(); return; }
    const data = objects.get(url.pathname);
    if (!data) { res.writeHead(404).end(); return; }
    if (req.method === 'HEAD') { res.writeHead(200, { 'Content-Length': data.length }).end(); return; }
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    const output = range ? data.subarray(Number(range[1]), range[2] ? Number(range[2]) + 1 : undefined) : data;
    res.writeHead(range ? 206 : 200, { 'Content-Length': output.length }).end(output);
  });
  service.listen(0, '127.0.0.1'); await once(service, 'listening');
  const address = `http://127.0.0.1:${service.address().port}`;
  const transport = (url, init = {}) => fetch(address + new URL(url).pathname + new URL(url).search, { ...init, headers: { ...init.headers, 'x-test-original-url': String(url) } });
  const adapter = new CloudflareR2Adapter(transport);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ufm-r2-protocol-'));
  try {
    const key = '中文/space & plus+ percent% #?.bin';
    const bytes = Buffer.from('private bytes 中文');
    await adapter.upload(config, { key, buffer: bytes, mimeType: 'application/octet-stream', originalName: 'test.bin' });
    assert.equal(await adapter.objectExists(config, key), true);
    const signed = await adapter.getDownloadUrl(config, key, 60);
    assert.equal(new URL(signed).hostname, `${accountId}.r2.cloudflarestorage.com`);
    assert.match(new URL(signed).pathname, /^\/private-bucket\//);
    assert.deepEqual(Buffer.from(await (await transport(signed)).arrayBuffer()), bytes);
    assert.equal((await transport(signed, { headers: { Range: 'bytes=0-6' } })).status, 206);
    assert.equal(await (await transport(signed, { headers: { Range: 'bytes=0-6' } })).text(), 'private');
    const big = crypto.randomBytes(8 * 1024 * 1024 + 17);
    const file = path.join(temp, 'large.bin'); fs.writeFileSync(file, big);
    await adapter.uploadFile(config, { key: 'large.bin', path: file, size: big.length, checksum: sha(big), mimeType: 'application/octet-stream', originalName: 'large.bin' });
    const downloaded = Buffer.from(await (await transport(await adapter.getDownloadUrl(config, 'large.bin', 60))).arrayBuffer());
    assert.equal(sha(downloaded), sha(big));
    const direct = await adapter.createDirectUpload(config, { key: 'direct.bin', mimeType: 'application/octet-stream', fileName: 'direct.bin', size: bytes.length }, 9999999);
    assert.equal(new URL(direct.uploadUrl).searchParams.get('X-Amz-Expires'), '604800');
    assert.ok(Math.abs(Date.parse(direct.expiresAt) - Date.now() - 604800000) < 2000);
    assert.equal((await transport(direct.uploadUrl, { method: direct.method, headers: direct.headers, body: bytes })).status, 200);
    assert.equal(await adapter.objectExists(config, 'direct.bin'), true);
    const badConfig = { ...config, config: { ...config.config, secretAccessKey: 'wrong' } };
    await assert.rejects(() => adapter.objectExists(badConfig, key), /403/);
    assert.equal(await adapter.objectExists(config, 'missing'), false);
    await assert.rejects(() => adapter.objectExists(config, 'service-error'), /503/);
    await assert.rejects(() => adapter.upload(config, { key: 'service-error', buffer: bytes, mimeType: 'text/plain' }), /503/);
    const target = { origin: `https://${accountId}.r2.cloudflarestorage.com`, host: `${accountId}.r2.cloudflarestorage.com`, canonicalUri: '/private-bucket/direct.bin' };
    const expired = target.origin + target.canonicalUri + '?' + presignS3({ accessKeyId: 'test-access', secretAccessKey: 'test-secret', region: 'auto' }, 'GET', target, 1, new Date(Date.now() - 10000));
    assert.equal((await transport(expired)).status, 403);
    await adapter.remove(config, key); await adapter.remove(config, key);
    assert.equal(await adapter.objectExists(config, key), false);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
    service.closeAllConnections(); await new Promise(resolve => service.close(resolve));
  }
});
