import { randomUUID } from 'node:crypto';
import type { PluginLoginResult, PluginLoginSession } from '@ufm/storage-plugin-sdk';
import { AUTH, CLIENT_ID, DriveClient, headers, PASSPORT } from './client';

type Login = { expires: number; cookies: Map<string, string>; data: Record<string, unknown>; accountId?: string; result?: PluginLoginResult; canceled: boolean };
export class DriveAuth {
  private readonly sessions = new Map<string, Login>();
  constructor(private readonly client: DriveClient) {}
  private async loginRequest(url: string, login: Login, init: RequestInit = {}) {
    const response = await this.client.transport(url, { ...init, headers: { ...headers,
      cookie: [...login.cookies].map(([key, value]) => `${key}=${value}`).join('; '), ...init.headers },
      signal: AbortSignal.timeout(30_000), redirect: 'manual' });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';')[0], at = pair.indexOf('=');
      if (at > 0) login.cookies.set(pair.slice(0, at), pair.slice(at + 1));
    }
    return response;
  }
  async startLogin(accountId?: string): Promise<PluginLoginSession> {
    for (const [id, login] of this.sessions) if (login.expires <= Date.now()) this.sessions.delete(id);
    if (this.sessions.size >= 100) throw new Error('登录会话过多，请稍后重试。');
    if (accountId) await this.client.load(accountId);
    const login: Login = { expires: Date.now() + 180_000, cookies: new Map(), data: {}, accountId, canceled: false };
    const authorize = new URL('/v2/oauth/authorize', AUTH);
    authorize.search = new URLSearchParams({ login_type: 'custom', response_type: 'code', redirect_uri: 'https://www.aliyundrive.com/sign/callback', client_id: CLIENT_ID, state: '{"origin":"file://"}' }).toString();
    let next = authorize.toString();
    for (let redirect = 0; redirect < 5; redirect++) {
      const response = await this.loginRequest(next, login);
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location || response.status < 300 || response.status >= 400) break;
      const target = new URL(location, next);
      if (target.protocol !== 'https:' || !['aliyundrive.com', 'alipan.com'].some(domain => target.hostname === domain || target.hostname.endsWith(`.${domain}`))) throw new Error('认证跳转地址无效。');
      next = target.toString();
    }
    const response = await this.loginRequest(`${PASSPORT}/newlogin/qrcode/generate.do?appName=aliyun_drive`, login);
    if (!response.ok) { await response.body?.cancel(); throw new Error('获取二维码失败。'); }
    const result = await response.json() as { content?: { data?: Record<string, unknown> } };
    const data = result.content?.data;
    if (!data || typeof data.codeContent !== 'string') throw new Error('网盘未返回二维码，请稍后重试。');
    login.data = data;
    const sessionId = randomUUID(); this.sessions.set(sessionId, login);
    return { sessionId, qrCode: data.codeContent, expiresAt: new Date(login.expires).toISOString() };
  }
  async pollLogin(sessionId: string): Promise<PluginLoginResult> {
    return this.client.context.withLock(`login-${sessionId}`, async () => {
      const login = this.sessions.get(sessionId);
      if (!login || login.canceled || login.expires <= Date.now()) { this.sessions.delete(sessionId); return { status: 'EXPIRED' }; }
      if (login.result) return login.result;
      const response = await this.loginRequest(`${PASSPORT}/newlogin/qrcode/query.do?appName=aliyun_drive`, login, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(Object.entries(login.data).map(([key, value]) => [key, String(value)])).toString(),
      });
      if (!response.ok) { await response.body?.cancel(); throw new Error('查询扫码状态失败。'); }
      const result = await response.json() as { content?: { data?: { qrCodeStatus?: string; bizExt?: string } } };
      const data = result.content?.data;
      if (login.canceled) return { status: 'EXPIRED' };
      if (data?.qrCodeStatus === 'NEW') return { status: 'WAITING' };
      if (data?.qrCodeStatus === 'SCANED' || data?.qrCodeStatus === 'SCANNED') return { status: 'SCANNED' };
      if (data?.qrCodeStatus !== 'CONFIRMED' || !data.bizExt) { this.sessions.delete(sessionId); return { status: 'EXPIRED' }; }
      const decoded = new TextDecoder('gb18030').decode(Buffer.from(data.bizExt, 'base64'));
      const token = JSON.parse(decoded)?.pds_login_result?.refreshToken;
      if (typeof token !== 'string' || !token) throw new Error('扫码未返回有效的认证结果。');
      const account = await this.client.context.withLock(`relogin-${login.accountId || sessionId}`, async () => {
        const state = login.accountId
          ? await this.client.context.withLock(`token-${login.accountId}`, async () => {
            if (login.canceled) throw new Error('登录已取消。');
            const previous = await this.client.load(login.accountId!);
            return this.client.exchange(token, previous);
          })
          : await this.client.exchange(token);
        login.accountId = state.accountId;
        await this.client.createDevice(state);
        return this.client.profile(state.accountId);
      });
      if (login.canceled) return { status: 'EXPIRED' };
      login.result = { status: 'CONFIRMED', account };
      return login.result;
    });
  }
  async cancelLogin(sessionId: string) {
    const login = this.sessions.get(sessionId);
    if (login) login.canceled = true;
    this.sessions.delete(sessionId);
  }
}
