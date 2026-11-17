import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1';
import type { PluginContext } from '@ufm/storage-plugin-sdk';

export type Transport = typeof fetch;
export type AccountState = {
  accountId: string; userId: string; name: string; accessToken: string; refreshToken: string;
  expiresAt: number; deviceId: string; privateKey: string; drives: Array<{ id: string; name: string }>;
};
export class DriveError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(`阿里云盘请求失败（${/^[A-Za-z0-9_.-]{1,100}$/.test(code) ? code : status}）。`);
  }
  get missing() { return ['NotFound.File', 'NotFound.FileId', 'FileNotFound', 'NotFound'].includes(this.code); }
}
export const API = 'https://api.aliyundrive.com';
export const AUTH = 'https://auth.aliyundrive.com';
export const PASSPORT = 'https://passport.aliyundrive.com';
export const CLIENT_ID = '25dzX3vbYqktVxyX';
export const headers = {
  Referer: 'https://www.aliyundrive.com/', Origin: 'https://www.aliyundrive.com',
  'User-Agent': 'AliApp(AYSD/5.8.0) com.alicloud.databox/37029260 Channel/36176927979800@rimet_android_5.8.0 language/zh-CN /Android Mobile',
  'x-canary': 'client=Android,app=adrive,version=v5.8.0',
};
export function stateKey(accountId: string) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(accountId)) throw new Error('账号标识无效。');
  return `account-${accountId}`;
}
export function checkedDownloadUrl(value: unknown): string {
  const url = new URL(String(value));
  if (url.protocol !== 'https:' || url.username || url.password || !(
    ['aliyundrive.com', 'aliyundrive.cloud', 'aliyundrive.net', 'alipan.com', 'aliyuncs.com'].some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`))
  )) throw new Error('网盘返回的传输地址无效。');
  return url.toString();
}
export class DriveClient {
  constructor(readonly context: PluginContext, readonly transport: Transport = fetch) {}
  async json(url: string, init: RequestInit = {}): Promise<Record<string, any>> {
    let response: Response;
    try { response = await this.transport(url, { ...init, signal: AbortSignal.timeout(30_000), redirect: 'error' }); }
    catch { throw new Error('阿里云盘网络连接失败或请求超时。'); }
    if (response.ok && response.status === 204) { await response.body?.cancel(); return {}; }
    let data: Record<string, any>;
    try { data = await response.json() as Record<string, any>; }
    catch { throw new DriveError('InvalidResponse', response.status); }
    if (!response.ok || data.code) throw new DriveError(String(data.code || `HTTP_${response.status}`), response.status);
    return data;
  }
  async load(accountId: string): Promise<AccountState> {
    const state = await this.context.getState<AccountState>(stateKey(accountId));
    if (!state?.refreshToken) throw new Error('网盘未连接，请扫码登录。');
    return state;
  }
  async exchange(refreshToken: string, previous?: AccountState): Promise<AccountState> {
    const data = await this.json(`${API}/v2/account/token`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    });
    if (!data.access_token || !data.refresh_token || !data.user_id) throw new Error('网盘未返回有效的登录凭据。');
    if (previous && previous.userId !== data.user_id) throw new Error('请使用原来绑定的网盘账号扫码。');
    const state: AccountState = {
      accountId: previous?.accountId ?? randomUUID(), userId: String(data.user_id),
      name: String(data.nick_name || data.user_name || previous?.name || '阿里云盘账号'),
      accessToken: String(data.access_token), refreshToken: String(data.refresh_token),
      expiresAt: Date.now() + Math.max(60, Number(data.expires_in) || 7200) * 1000,
      deviceId: previous?.deviceId ?? randomUUID().replace(/-/g, ''),
      privateKey: previous?.privateKey ?? randomBytes(32).toString('hex'), drives: previous?.drives ?? [],
    };
    // Save rotated credentials before making any subsequent network request.
    await this.context.setState(stateKey(state.accountId), state);
    return state;
  }
  async fresh(accountId: string, rejectedToken?: string): Promise<AccountState> {
    return this.context.withLock(`token-${accountId}`, async () => {
      const current = await this.load(accountId);
      if (current.expiresAt > Date.now() + 60_000 && (!rejectedToken || current.accessToken !== rejectedToken)) return current;
      return this.exchange(current.refreshToken, current);
    });
  }
  signedHeaders(state: AccountState): Record<string, string> {
    const message = `5dde4e1bdf9e4966b387ba58f4b3fdc3:${state.deviceId}:${state.userId}:0`;
    const digest = createHash('sha256').update(message).digest();
    const signature = secp256k1.sign(digest, state.privateKey, { lowS: true });
    return { ...headers, 'content-type': 'application/json', Authorization: `Bearer ${state.accessToken}`,
      'x-device-id': state.deviceId, 'x-signature': signature.toCompactHex() + signature.recovery.toString(16).padStart(2, '0'),
      'x-request-id': randomUUID() };
  }
  async createDevice(state: AccountState) {
    await this.json(`${API}/users/v1/users/device/create_session`, { method: 'POST', headers: this.signedHeaders(state),
      body: JSON.stringify({ deviceName: 'UFM', modelName: 'Node.js', nonce: 0,
        pubKey: Buffer.from(secp256k1.getPublicKey(state.privateKey, false)).toString('hex'), refreshToken: state.refreshToken }) });
  }
  async request(accountId: string, path: string, body: Record<string, unknown> = {}): Promise<Record<string, any>> {
    let state = await this.fresh(accountId);
    for (let attempt = 0; attempt < 3; attempt++) {
      try { return await this.json(API + path, { method: 'POST', headers: this.signedHeaders(state), body: JSON.stringify(body) }); }
      catch (error) {
        if (!(error instanceof DriveError) || attempt === 2) throw error;
        if (['AccessTokenInvalid', 'AccessTokenExpired'].includes(error.code)) state = await this.fresh(accountId, state.accessToken);
        else if (['DeviceSessionSignatureInvalid', 'UserDeviceOffline', 'DeviceSessionNotFound'].includes(error.code)) {
          await this.context.withLock(`device-${accountId}`, () => this.createDevice(state));
        } else if ([429, 502, 503, 504].includes(error.status)) await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt));
        else throw error;
      }
    }
    throw new Error('网盘请求重试失败。');
  }
  async profile(accountId: string) {
    const user = await this.request(accountId, '/v2/user/get');
    const drives = new Map<string, string>();
    if (user.resource_drive_id) drives.set(String(user.resource_drive_id), '资源盘');
    if (user.backup_drive_id) drives.set(String(user.backup_drive_id), '备份盘');
    if (user.default_drive_id && !drives.has(String(user.default_drive_id))) drives.set(String(user.default_drive_id), '默认云盘');
    if (!drives.size) {
      const result = await this.request(accountId, '/v2/drive/list_my_drives');
      for (const drive of result.items || []) drives.set(String(drive.drive_id), String(drive.drive_name || '云盘'));
    }
    await this.context.withLock(`token-${accountId}`, async () => {
      const state = await this.load(accountId);
      state.name = String(user.nick_name || user.user_name || state.name);
      state.drives = [...drives].map(([id, name]) => ({ id, name }));
      await this.context.setState(stateKey(accountId), state);
    });
    return this.summary(await this.load(accountId));
  }
  summary(state: AccountState) {
    return { accountId: state.accountId, userId: state.userId, name: state.name, connected: true, drives: state.drives };
  }
}
