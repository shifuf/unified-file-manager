import type { PluginLoginSession } from '@ufm/storage-plugin-sdk';

export class PluginLoginSessions {
  private readonly entries = new Map<string, { provider: string; owner: string; expires: number }>();
  private prune() { for (const [key, entry] of this.entries) if (entry.expires <= Date.now()) this.entries.delete(key); }
  assertCapacity(owner: string) {
    this.prune();
    if (this.entries.size >= 100 || [...this.entries.values()].filter(e => e.owner === owner).length >= 5) throw new Error('请先取消已有登录会话。');
  }
  add(provider: string, owner: string, session: PluginLoginSession) {
    this.assertCapacity(owner);
    const expires = Math.min(Date.parse(session.expiresAt) + 30_000, Date.now() + 10 * 60_000);
    if (!Number.isFinite(expires) || expires <= Date.now() || this.entries.has(session.sessionId)) throw new Error('登录会话无效。');
    this.entries.set(session.sessionId, { provider, owner, expires });
  }
  owns(provider: string, owner: string, sessionId: string) {
    this.prune();
    const entry = this.entries.get(sessionId);
    return entry?.provider === provider && entry.owner === owner;
  }
  remove(sessionId: string) { this.entries.delete(sessionId); }
}
