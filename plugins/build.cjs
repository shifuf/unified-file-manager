const path = require('node:path');
const { packagePlugin } = require('../packages/storage-plugin-sdk/bin/cli.cjs');
(async () => {
  const ids = process.argv.slice(2);
  for (const name of ids.length ? ids : ['qiniu', 'upyun', 'aliyun', 's3', 'cloudflare-r2']) {
    if (!['qiniu', 'upyun', 'aliyun', 's3', 'cloudflare-r2'].includes(name)) throw new Error(`Unknown plugin: ${name}`);
    const result = await packagePlugin(path.join(__dirname, name), undefined, { buildOptions: { alias: { '@ufm/storage-plugin-sdk': path.resolve(__dirname, '../packages/storage-plugin-sdk/dist/index.js') } } });
    console.log(result.path);
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
