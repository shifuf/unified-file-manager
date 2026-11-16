const assert = require('node:assert/strict');
const { validateManifest, validateConfig, validateAdapter } = require('@ufm/storage-plugin-sdk');
const manifest = validateManifest(require('./storage-plugin.json'));
validateAdapter(manifest, require('./dist/index.cjs').createAdapter());
assert.throws(() => validateConfig(manifest, {}));
const config = validateConfig(manifest, { endpoint: 'https://s3.example.com', bucket: 'test', accessKeyId: 'test', secretAccessKey: 'test' });
assert.equal(config.region, 'us-east-1');
console.log('External plugin contract passed');
