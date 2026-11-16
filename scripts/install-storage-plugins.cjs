#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { parseEnv } = require('node:util');
const { createHash } = require('node:crypto');

async function main() {
  const args = process.argv.slice(2);
  function option(name) { const at = args.indexOf(name); if (at < 0) return undefined; if (!args[at + 1] || args[at + 1].startsWith('--')) throw new Error(`${name} 缺少参数`); return args[at + 1]; }
  const root = path.resolve(option('--root') || path.join(__dirname, '..'));
  const envFile = path.join(root, '.env');
  const env = { ...(fs.existsSync(envFile) ? parseEnv(fs.readFileSync(envFile, 'utf8')) : {}), ...process.env };
  const base = new URL(option('--url') || env.UFM_PLUGIN_API_URL || `http://127.0.0.1:${env.APP_PORT || 60557}`);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error('API 地址无效');
  if (base.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]', 'api'].includes(base.hostname)) throw new Error('远程 API 请使用 HTTPS');
  const api = base.toString().replace(/\/$/, '').replace(/\/api$/, '') + '/api';
  const username = env.UFM_ADMIN_USERNAME || env.ADMIN_USERNAME;
  const password = env.UFM_ADMIN_PASSWORD || env.ADMIN_PASSWORD;
  if (!username || !password) throw new Error('请在 .env 配置 ADMIN_USERNAME / ADMIN_PASSWORD，或设置 UFM_ADMIN_USERNAME / UFM_ADMIN_PASSWORD');
  const archives = ['qiniu', 'upyun', 'aliyun', 's3', 'cloudflare-r2'].map(name => {
    const directory = path.join(root, 'plugins', name);
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'storage-plugin.json'), 'utf8'));
    const filename = `${manifest.id}-${manifest.version}.zip`;
    const bytes = fs.readFileSync(path.join(directory, filename));
    return { manifest, filename, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
  });
  let cookie = '';
  async function request(route, method = 'GET', body) {
    const response = await fetch(api + route, { method, redirect: 'error', signal: AbortSignal.timeout(120000),
      headers: { ...(cookie ? { cookie } : {}), ...(body instanceof FormData ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body) });
    if (route === '/auth/login') cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    if (!response.ok) throw new Error(`${route} 返回 HTTP ${response.status}，请检查登录信息、插件兼容性和服务日志`);
    return response.json();
  }
  try {
    const login = await request('/auth/login', 'POST', { username, password, ...(env.UFM_TOTP_CODE ? { totpCode: env.UFM_TOTP_CODE } : {}) });
    if (login.requiresTotp) throw new Error('已启用两步验证，请设置 UFM_TOTP_CODE 后重试');
    if (!cookie) throw new Error('登录未返回会话');
    const current = await request('/storage-plugins');
    for (const { manifest, filename, bytes, sha256 } of archives) {
      if (current.some(item => item.id === manifest.id && item.version === manifest.version && item.sha256 === sha256 && item.available)) {
        console.log(`已验证 ${manifest.id} ${manifest.version}，无需重复安装`);
        continue;
      }
      const form = new FormData(); form.append('file', new Blob([bytes], { type: 'application/zip' }), filename);
      await request('/storage-plugins', 'POST', form);
      console.log(`已安装 ${manifest.id} ${manifest.version}`);
    }
    const installed = await request('/storage-plugins');
    for (const { manifest, sha256 } of archives) if (!installed.some(item => item.id === manifest.id && item.version === manifest.version && item.sha256 === sha256 && item.available)) throw new Error(`${manifest.id} 安装后验证失败`);
    console.log('全部 5 个存储插件已安装并验证。请在存储配置中填写供应商参数并绑定项目。');
  } finally {
    if (cookie) await request('/auth/logout', 'POST', {}).catch(() => console.error('安装会话注销失败，请在控制台会话管理中撤销。'));
  }
}
main().catch(error => { console.error(error.message.replace(/https?:\/\/\S+/g, '[API 地址]')); process.exitCode = 1; });
