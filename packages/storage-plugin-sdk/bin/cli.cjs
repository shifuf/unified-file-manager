#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { validateManifest, validateAdapter } = require('../dist');

async function packagePlugin(directory, output, options = {}) {
  const root = path.resolve(directory);
  const manifest = validateManifest(JSON.parse(fs.readFileSync(path.join(root, 'storage-plugin.json'), 'utf8')));
  const entry = path.resolve(root, options.source || 'index.ts');
  if (!entry.startsWith(`${root}${path.sep}`) || !fs.statSync(entry).isFile()) throw new Error('Source entry must be inside the plugin directory');
  const buildDir = path.join(root, 'dist');
  fs.mkdirSync(buildDir, { recursive: true });
  const outfile = path.join(buildDir, manifest.entry);
  const packageFile = path.join(root, 'package.json');
  const metadata = fs.existsSync(packageFile) ? JSON.parse(fs.readFileSync(packageFile, 'utf8')) : {};
  const unsupported = metadata.ufmStoragePlugin?.unsupportedOptionalModules || [];
  if (!Array.isArray(unsupported) || unsupported.some(name => typeof name !== 'string' || !/^[a-z@][a-z0-9@/_.-]*$/.test(name))) throw new Error('Invalid unsupportedOptionalModules');
  const optionalPlugin = { name: 'explicit-unsupported-optional-modules', setup(build) {
    build.onResolve({ filter: /.*/ }, args => unsupported.includes(args.path) ? { path: args.path, namespace: 'unsupported-optional' } : undefined);
    build.onLoad({ filter: /.*/, namespace: 'unsupported-optional' }, args => ({ contents: `throw new Error(${JSON.stringify(`Optional module ${args.path} is not supported by this storage plugin`)});`, loader: 'js' }));
  } };
  const result = await require('esbuild').build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', target: 'node22', format: 'cjs', metafile: true, sourcemap: false, legalComments: 'eof', ...options.buildOptions, plugins: [optionalPlugin, ...(options.buildOptions?.plugins || [])] });
  for (const item of Object.values(result.metafile.outputs)) {
    for (const dependency of item.imports) {
      if (dependency.external && !require('node:module').isBuiltin(dependency.path)) throw new Error(`Unbundled dependency: ${dependency.path}`);
    }
  }
  const load = createRequire(outfile);
  delete load.cache[outfile];
  const plugin = load(outfile);
  if (typeof plugin.createAdapter !== 'function') throw new Error('Plugin must export createAdapter()');
  validateAdapter(manifest, plugin.createAdapter());
  const destination = path.resolve(output || path.join(root, `${manifest.id}-${manifest.version}.zip`));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  await new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(destination);
    const archive = require('archiver')('zip', { zlib: { level: 9 } });
    stream.on('close', resolve).on('error', reject);
    archive.on('error', reject).on('warning', reject);
    archive.pipe(stream);
    archive.append(JSON.stringify(manifest, null, 2), { name: 'storage-plugin.json' });
    archive.file(outfile, { name: manifest.entry });
    for (const name of ['LICENSE', 'NOTICE', 'README.md']) if (fs.existsSync(path.join(root, name))) archive.file(path.join(root, name), { name });
    void archive.finalize();
  });
  return { manifest, path: destination };
}

async function main() {
  const [command, directory = '.', output] = process.argv.slice(2);
  if (command === 'pack') console.log((await packagePlugin(directory, output)).path);
  else if (command === 'validate') {
    const root = path.resolve(directory);
    const manifest = validateManifest(JSON.parse(fs.readFileSync(path.join(root, 'storage-plugin.json'), 'utf8')));
    const adapter = require(path.join(root, manifest.entry)).createAdapter();
    validateAdapter(manifest, adapter);
    console.log(`${manifest.id}@${manifest.version} OK`);
  } else throw new Error('Usage: ufm-storage-plugin pack <source-directory> [output.zip] | validate <unpacked-directory>');
}
module.exports = { packagePlugin };
if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
