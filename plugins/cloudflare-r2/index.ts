import { S3Adapter, configText, type RuntimeCdnConfig } from '@ufm/storage-plugin-sdk';

export class CloudflareR2Adapter extends S3Adapter {
  constructor(transport: typeof fetch = fetch) { super('CLOUDFLARE_R2', transport); }
  protected normalizeConfig(config: RuntimeCdnConfig): RuntimeCdnConfig {
    const account = configText(config, 'accountId');
    if (!/^[a-f0-9]{32}$/i.test(account)) throw new Error('R2 accountId 必须是 32 位十六进制账号标识');
    const endpoint = configText(config, 'endpoint') || `https://${account}.r2.cloudflarestorage.com`;
    let url: URL;
    try { url = new URL(endpoint); } catch { throw new Error('R2 endpoint 无效'); }
    const allowedHosts = [ `${account}.r2.cloudflarestorage.com`, `${account}.eu.r2.cloudflarestorage.com`, `${account}.fedramp.r2.cloudflarestorage.com` ].map((host) => host.toLowerCase());
    if (url.protocol !== 'https:' || !allowedHosts.includes(url.hostname.toLowerCase()) || url.port || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('R2 endpoint 必须是当前账号的官方 HTTPS 地址');
    return { ...config, config: { ...config.config, endpoint: url.origin, region: 'auto', pathStyle: true } };
  }
}
export function createAdapter() { return new CloudflareR2Adapter(); }
