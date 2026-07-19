import { readdir, rm, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { LifecycleService } from '../lifecycle/lifecycle.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Periodic background maintenance. The OpenAPI guard cleans nonces lazily on each
 * request, but a quiet API would never run it; this service guarantees expired
 * nonces and refresh tokens are reaped, and optionally ages out old audit logs.
 *
 * Uses a plain interval (the project intentionally avoids extra scheduler deps);
 * timers are unref'd so they never hold the process open.
 */
@Injectable()
export class MaintenanceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MaintenanceService.name);
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly lifecycleService: LifecycleService,
  ) {}

  onModuleInit(): void {
    const minutes = Math.max(5, Number(this.configService.get<number>('MAINTENANCE_INTERVAL_MINUTES', 30)) || 30);
    const startupTimer = setTimeout(() => void this.runCleanup(), 60 * 1000);
    startupTimer.unref?.();
    this.timer = setInterval(() => void this.runCleanup(), minutes * 60 * 1000);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  async runCleanup(): Promise<{ nonces: number; refreshTokens: number; auditLogs: number; staleUploads: number }> {
    const now = new Date();
    const summary = { nonces: 0, refreshTokens: 0, auditLogs: 0, staleUploads: 0 };

    try {
      const nonces = await this.prisma.openApiNonce.deleteMany({ where: { expiresAt: { lte: now } } });
      summary.nonces = nonces.count;

      // Drop expired tokens, and tokens revoked more than 7 days ago (kept briefly for
      // theft-detection audit trails).
      const revokedCutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const tokens = await this.prisma.refreshToken.deleteMany({
        where: { OR: [{ expiresAt: { lte: now } }, { revokedAt: { lte: revokedCutoff } }] },
      });
      summary.refreshTokens = tokens.count;

      summary.auditLogs = await this.cleanupAuditLogs(now);
      summary.staleUploads = await this.cleanupStaleUploads(now);
      try {
        const lifecycle = await this.lifecycleService.runDuePolicies();
        if (lifecycle.affected > 0) {
          this.logger.log(`生命周期策略执行：policies=${lifecycle.policies} affected=${lifecycle.affected}`);
        }
      } catch (error) {
        this.logger.warn(`生命周期策略执行失败：${error instanceof Error ? error.message : String(error)}`);
      }

      if (summary.nonces || summary.refreshTokens || summary.auditLogs || summary.staleUploads) {
        this.logger.log(
          `定时清理完成：nonce=${summary.nonces} refreshToken=${summary.refreshTokens} auditLog=${summary.auditLogs} 分片会话=${summary.staleUploads}`,
        );
      }
    } catch (error) {
      this.logger.warn(`定时清理失败：${error instanceof Error ? error.message : String(error)}`);
    }

    return summary;
  }

  /** Remove chunked-upload session directories that were never completed within the TTL. */
  private async cleanupStaleUploads(now: Date): Promise<number> {
    const ttlHours = Math.max(1, Number(this.configService.get<number>('CHUNKED_UPLOAD_TTL_HOURS', 24)) || 24);
    const cutoff = now.getTime() - ttlHours * 60 * 60 * 1000;
    const root = this.configService.get<string>('LOCAL_STORAGE_ROOT', './storage');
    const base = isAbsolute(root) ? root : resolve(process.cwd(), root);
    const uploadsRoot = resolve(base, '.chunked-uploads');

    let entries: string[];
    try {
      entries = await readdir(uploadsRoot);
    } catch {
      return 0; // No upload sessions yet.
    }

    let removed = 0;
    for (const entry of entries) {
      const dir = join(uploadsRoot, entry);
      try {
        const info = await stat(dir);
        if (info.isDirectory() && info.mtimeMs < cutoff) {
          await rm(dir, { recursive: true, force: true });
          removed += 1;
        }
      } catch {
        // Skip entries we can't stat/remove; a later sweep retries.
      }
    }

    return removed;
  }

  private async cleanupAuditLogs(now: Date): Promise<number> {
    const days = Number(this.configService.get<number>('AUDIT_LOG_RETENTION_DAYS', 0)) || 0;
    if (days <= 0) {
      return 0; // Retain audit logs indefinitely unless an explicit retention is configured.
    }

    const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    const result = await this.prisma.auditLog.deleteMany({ where: { createdAt: { lt: cutoff } } });
    return result.count;
  }
}
