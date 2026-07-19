import { HttpException, HttpStatus } from '@nestjs/common';

interface AttemptState {
  count: number;
  firstFailedAt: number;
  lastSeenAt: number;
  lockedUntil?: number;
}

export class InMemoryAttemptLimiter {
  private readonly attempts = new Map<string, AttemptState>();

  constructor(
    private readonly options: {
      maxAttempts: number;
      windowMs: number;
      lockMs: number;
      maxKeys?: number;
    },
  ) {}

  assertAllowed(key: string, message: string): void {
    const normalizedKey = this.normalizeKey(key);
    const state = this.attempts.get(normalizedKey);
    const now = Date.now();

    if (!state) {
      return;
    }

    if (this.isExpired(state, now)) {
      this.attempts.delete(normalizedKey);
      return;
    }

    state.lastSeenAt = now;
    if (state.lockedUntil && state.lockedUntil > now) {
      const retryMinutes = Math.max(1, Math.ceil((state.lockedUntil - now) / 60000));
      throw new HttpException(`${message}，请 ${retryMinutes} 分钟后再试。`, HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  recordFailure(key: string): void {
    this.recordAttempt(key);
  }

  /**
   * Count one attempt in the current window. Returns true when this call newly
   * engaged the lock (count crossed maxAttempts).
   */
  recordAttempt(key: string): boolean {
    const normalizedKey = this.normalizeKey(key);
    const now = Date.now();
    const existing = this.attempts.get(normalizedKey);
    const state =
      existing && !this.isExpired(existing, now)
        ? existing
        : { count: 0, firstFailedAt: now, lastSeenAt: now };

    const wasLocked = Boolean(state.lockedUntil && state.lockedUntil > now);
    state.count += 1;
    state.lastSeenAt = now;
    let newlyLocked = false;
    if (state.count >= this.options.maxAttempts) {
      if (!wasLocked) {
        newlyLocked = true;
      }
      state.lockedUntil = now + this.options.lockMs;
    }

    this.attempts.set(normalizedKey, state);
    this.trim(now);
    return newlyLocked;
  }

  reset(key: string): void {
    this.attempts.delete(this.normalizeKey(key));
  }

  private isExpired(state: AttemptState, now: number): boolean {
    return now - state.firstFailedAt > this.options.windowMs && (!state.lockedUntil || state.lockedUntil <= now);
  }

  private trim(now: number): void {
    for (const [key, state] of this.attempts) {
      if (this.isExpired(state, now)) {
        this.attempts.delete(key);
      }
    }

    const maxKeys = this.options.maxKeys ?? 5000;
    if (this.attempts.size <= maxKeys) {
      return;
    }

    const oldestKeys = [...this.attempts.entries()]
      .sort((left, right) => left[1].lastSeenAt - right[1].lastSeenAt)
      .slice(0, this.attempts.size - maxKeys)
      .map(([key]) => key);

    for (const key of oldestKeys) {
      this.attempts.delete(key);
    }
  }

  private normalizeKey(key: string): string {
    return key.trim().toLowerCase().slice(0, 256) || 'unknown';
  }
}
