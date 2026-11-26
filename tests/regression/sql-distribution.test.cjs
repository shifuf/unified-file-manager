const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');

const root = path.resolve(__dirname, '../..');
const cli = path.join(root, 'scripts/sql/generate-schema.cjs');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceHash = bytes => hash(bytes.toString('utf8').replace(/\r\n/g, '\n'));
const run = args => spawnSync(process.execPath, [cli, ...args], {
  cwd: root, encoding: 'utf8', windowsHide: true, timeout: 120000,
});

// Missing or unstable metadata would let a release ship stale SQL while
// claiming it matches the deployed migration lineage.
test('schema distribution is reproducible and check mode detects stale artifacts without rewriting', { timeout: 360000 }, async t => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'ufm-sql-'));
  t.after(() => fs.rm(output, { recursive: true, force: true }));
  const first = run(['--output-dir', output]);
  assert.equal(first.status, 0, first.stderr || first.error?.message);
  const sql = await fs.readFile(path.join(output, 'schema.sql'));
  const metadata = await fs.readFile(path.join(output, 'manifest.json'));
  const manifest = JSON.parse(metadata);
  assert.equal(manifest.sqlSha256, hash(sql));
  assert.equal(manifest.schemaSha256, sourceHash(await fs.readFile(path.join(root, 'apps/api/prisma/schema.prisma'))));
  assert.equal(manifest.applicationVersion, JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version);
  const migrationDirectories = (await fs.readdir(path.join(root, 'apps/api/prisma/migrations'), { withFileTypes: true }))
    .filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  assert.ok(manifest.migrations.length > 0);
  assert.deepEqual(manifest.migrations.map(entry => entry.name), migrationDirectories);
  for (const migration of manifest.migrations) {
    assert.equal(migration.sha256, sourceHash(await fs.readFile(path.join(root, 'apps/api/prisma/migrations', migration.name, 'migration.sql'))));
  }
  const second = run(['--output-dir', output]);
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(await fs.readFile(path.join(output, 'schema.sql')), sql);
  assert.deepEqual(await fs.readFile(path.join(output, 'manifest.json')), metadata);
  assert.equal(run(['--check', '--output-dir', output]).status, 0);
  await fs.writeFile(path.join(output, 'schema.sql'), sql.toString().replace(/\n/g, '\r\n'));
  await fs.writeFile(path.join(output, 'manifest.json'), metadata.toString().replace(/\n/g, '\r\n'));
  assert.equal(run(['--check', '--output-dir', output]).status, 0, 'Git Windows line-ending conversion must not make unchanged artifacts stale');
  await fs.writeFile(path.join(output, 'schema.sql'), sql);
  await fs.writeFile(path.join(output, 'manifest.json'), metadata);

  await fs.appendFile(path.join(output, 'schema.sql'), '-- stale fixture\n');
  const staleSql = await fs.readFile(path.join(output, 'schema.sql'));
  const stale = run(['--check', '--output-dir', output]);
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /out of date/i);
  assert.deepEqual(await fs.readFile(path.join(output, 'schema.sql')), staleSql);
  assert.deepEqual(await fs.readFile(path.join(output, 'manifest.json')), metadata);

  await fs.writeFile(path.join(output, 'schema.sql'), sql);
  const changed = { ...manifest, migrations: manifest.migrations.slice(1) };
  const changedMetadata = JSON.stringify(changed);
  await fs.writeFile(path.join(output, 'manifest.json'), changedMetadata);
  const staleManifest = run(['--check', '--output-dir', output]);
  assert.equal(staleManifest.status, 1);
  assert.deepEqual(await fs.readFile(path.join(output, 'manifest.json'), 'utf8'), changedMetadata);
});

test('invalid SQL generator arguments fail before writing output', async t => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'ufm-sql-args-'));
  t.after(() => fs.rm(output, { recursive: true, force: true }));
  const result = run(['--output-dir', output, '--unsafe-reset']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown argument/i);
  assert.deepEqual(await fs.readdir(output), []);
});

test('the shipped SQL distribution matches the current release sources', { timeout: 120000 }, () => {
  const result = run(['--check']);
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});
