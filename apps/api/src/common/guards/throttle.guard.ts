import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';

import { getConfigBoolean } from '../utils/security-config.util';
import { SKIP_THROTTLE_KEY, THROTTLE_OPTIONS_KEY, type ThrottleOptions } from './throttle.decorator';

interface Counter {
  count: number;
  resetAt: number;
}

/**
 * Global HTTP rate limiter. Every endpoint gets a per-IP, per-handler fixed-window
 * budget so no route (2FA code checks, file enumeration, share-password attempts,
 * …) is left completely unmetered. Sensitive routes tighten the budget with
 * `@Throttle(...)`; health checks etc. can opt out with `@SkipThrottle()`.
 *
 * The store is in-memory, so under multiple API replicas the effective limit is
 * per-instance. For a hard cross-instance guarantee, back this with Redis
 * (see ufm-rate-limit notes) — the decorator/guard contract stays the same.
 */
@Injectable()
export class ThrottleGuard implements CanActivate {
  private readonly store = new Map<string, Counter>();
  private readonly defaults: ThrottleOptions;
  private readonly enabled: boolean;
  private readonly maxKeys = 50_000;
  private lastSweepAt = 0;

  constructor(
    private readonly reflector: Reflector,
    private readonly configService: ConfigService,
  ) {
    this.enabled = getConfigBoolean(configService, 'THROTTLE_ENABLED', true);
    const limit = Number(configService.get<number>('THROTTLE_LIMIT', 300));
    const windowMs = Number(configService.get<number>('THROTTLE_WINDOW_MS', 60_000));
    this.defaults = {
      limit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 300,
      windowMs: Number.isFinite(windowMs) && windowMs > 0 ? Math.floor(windowMs) : 60_000,
    };
  }

  canActivate(context: ExecutionContext): boolean {
    if (!this.enabled || context.getType() !== 'http') {
      return true;
    }

    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(SKIP_THROTTLE_KEY, targets)) {
      return true;
    }

    const options = this.reflector.getAllAndOverride<ThrottleOptions>(THROTTLE_OPTIONS_KEY, targets) ?? this.defaults;
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    const now = Date.now();

    this.sweep(now);

    const handlerKey = `${context.getClass().name}.${context.getHandler().name}`;
    const key = `${this.clientIp(request)}|${handlerKey}`;
    const counter = this.store.get(key);

    if (!counter || counter.resetAt <= now) {
      this.store.set(key, { count: 1, resetAt: now + options.windowMs });
      return true;
    }

    if (counter.count >= options.limit) {
      const retryAfter = Math.max(1, Math.ceil((counter.resetAt - now) / 1000));
      response.setHeader('Retry-After', String(retryAfter));
      throw new HttpException('请求过于频繁，请稍后再试。', HttpStatus.TOO_MANY_REQUESTS);
    }

    counter.count += 1;
    return true;
  }

  private clientIp(request: Request): string {
    return request.ip || request.socket?.remoteAddress || 'unknown';
  }

  private sweep(now: number): void {
    if (now - this.lastSweepAt < this.defaults.windowMs) {
      return;
    }

    this.lastSweepAt = now;
    for (const [key, counter] of this.store) {
      if (counter.resetAt <= now) {
        this.store.delete(key);
      }
    }

    if (this.store.size > this.maxKeys) {
      const overflow = this.store.size - this.maxKeys;
      let removed = 0;
      for (const key of this.store.keys()) {
        this.store.delete(key);
        removed += 1;
        if (removed >= overflow) {
          break;
        }
      }
    }
  }
}
