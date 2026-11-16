import { ForbiddenException, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { AuditAction, type Prisma } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../common/types/request-user.type';
import { InMemoryAttemptLimiter } from '../common/utils/in-memory-attempt-limiter';
import { PrismaService } from '../prisma/prisma.service';

function normalizeIp(raw?: string | null): string {
  const value = (raw || 'unknown').trim().replace(/^::ffff:/i, '');
  return value || 'unknown';
}

@Injectable()
export class ShareIpAbuseService {
  // All share entry points and the admin unban action must use the same bucket.
  private readonly downloadRateLimiter = new InMemoryAttemptLimiter({
    maxAttempts: 5,
    windowMs: 60 * 1000,
    lockMs: 10 * 60 * 1000,
    maxKeys: 20_000,
  });
  private readonly pendingIpOperations = new Map<string, Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async assertDownloadAllowed(
    ipRaw: string | undefined | null,
    meta?: { shareId?: string | null; originalName?: string | null },
  ): Promise<boolean> {
    const ip = normalizeIp(ipRaw);
    return this.withIpOperation(ip, async () => {
      await this.assertNotBanned(ip);
      this.downloadRateLimiter.assertAllowed(
        ip,
        '下载过于频繁，已临时限制访问（同一 IP 每分钟最多 5 次）',
      );
      const newlyLocked = this.downloadRateLimiter.recordAttempt(ip);
      await this.recordDownload(ip, meta);
      if (newlyLocked) {
        await this.recordRateLimited(ip, { ...meta, autoBanMinutes: 10 });
      }
      return newlyLocked;
    });
  }

  // Serialize DB writes with resets so an older download cannot re-ban an IP
  // after the administrator's unban has completed. Different IPs stay independent.
  private async withIpOperation<T>(ip: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.pendingIpOperations.get(ip);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    this.pendingIpOperations.set(ip, pending);
    try {
      await previous;
      return await operation();
    } finally {
      release();
      if (this.pendingIpOperations.get(ip) === pending) {
        this.pendingIpOperations.delete(ip);
      }
    }
  }

  /**
   * Reject downloads when IP is permanently banned or still inside banUntil.
   */
  async assertNotBanned(ipRaw?: string | null): Promise<void> {
    const ip = normalizeIp(ipRaw);
    if (ip === 'unknown') {
      return;
    }

    const row = await this.prisma.shareIpStat.findUnique({ where: { ip } });
    if (!row) {
      return;
    }

    if (row.permanentBan) {
      throw new ForbiddenException(
        row.banReason
          ? `该 IP 已被永久禁止下载分享文件：${row.banReason}`
          : '该 IP 已被永久禁止下载分享文件。',
      );
    }

    if (row.banUntil && row.banUntil.getTime() > Date.now()) {
      const retryMinutes = Math.max(1, Math.ceil((row.banUntil.getTime() - Date.now()) / 60_000));
      throw new HttpException(
        `该 IP 已被临时禁止下载，请 ${retryMinutes} 分钟后再试。`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /** Count one logical download / session-issue attempt. */
  async recordDownload(
    ipRaw: string | undefined | null,
    meta?: { shareId?: string | null; originalName?: string | null },
  ): Promise<void> {
    const ip = normalizeIp(ipRaw);
    const now = new Date();
    await this.prisma.shareIpStat.upsert({
      where: { ip },
      create: {
        ip,
        downloadCount: 1,
        lastDownloadAt: now,
        lastShareId: meta?.shareId ?? null,
        lastFileName: meta?.originalName ?? null,
      },
      update: {
        downloadCount: { increment: 1 },
        lastDownloadAt: now,
        lastShareId: meta?.shareId ?? null,
        lastFileName: meta?.originalName ?? null,
      },
    });
  }

  /**
   * Increment rate-limit hits and apply auto temporary ban (default 10 minutes)
   * when in-memory limiter newly locks.
   */
  async recordRateLimited(
    ipRaw: string | undefined | null,
    meta?: {
      shareId?: string | null;
      originalName?: string | null;
      autoBanMinutes?: number;
    },
  ): Promise<void> {
    const ip = normalizeIp(ipRaw);
    const now = new Date();
    const autoMinutes = Math.max(1, meta?.autoBanMinutes ?? 10);
    const autoUntil = new Date(now.getTime() + autoMinutes * 60_000);

    const existing = await this.prisma.shareIpStat.findUnique({ where: { ip } });
    const nextBanUntil =
      existing?.permanentBan
        ? existing.banUntil
        : !existing?.banUntil || existing.banUntil.getTime() < autoUntil.getTime()
          ? autoUntil
          : existing.banUntil;

    await this.prisma.shareIpStat.upsert({
      where: { ip },
      create: {
        ip,
        downloadCount: 0,
        rateLimitCount: 1,
        lastRateLimitedAt: now,
        banUntil: autoUntil,
        banReason: `自动限流（${autoMinutes} 分钟）`,
        lastShareId: meta?.shareId ?? null,
        lastFileName: meta?.originalName ?? null,
      },
      update: {
        rateLimitCount: { increment: 1 },
        lastRateLimitedAt: now,
        banUntil: nextBanUntil,
        banReason:
          existing?.permanentBan
            ? existing.banReason
            : existing?.banReason && existing.banUntil && existing.banUntil.getTime() > autoUntil.getTime()
              ? existing.banReason
              : `自动限流（${autoMinutes} 分钟）`,
        lastShareId: meta?.shareId ?? null,
        lastFileName: meta?.originalName ?? null,
      },
    });
  }

  async list(options?: {
    page?: number;
    pageSize?: number;
    keyword?: string;
    bannedOnly?: boolean;
  }) {
    const page = Math.max(1, Number(options?.page ?? 1) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(options?.pageSize ?? 20) || 20));
    const keyword = options?.keyword?.trim();
    const now = new Date();

    const where: Prisma.ShareIpStatWhereInput = {
      ...(keyword
        ? {
            OR: [
              { ip: { contains: keyword } },
              { banReason: { contains: keyword } },
              { notes: { contains: keyword } },
              { lastFileName: { contains: keyword } },
            ],
          }
        : {}),
      ...(options?.bannedOnly
        ? {
            OR: [{ permanentBan: true }, { banUntil: { gt: now } }],
          }
        : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.shareIpStat.findMany({
        where,
        orderBy: [{ lastDownloadAt: 'desc' }, { updatedAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.shareIpStat.count({ where }),
    ]);

    return {
      items: items.map((row) => this.toView(row, now)),
      total,
      page,
      pageSize,
    };
  }

  async ban(
    ipRaw: string,
    options: {
      permanent?: boolean;
      minutes?: number;
      reason?: string;
      notes?: string;
      actor?: RequestUser;
    },
  ) {
    const ip = normalizeIp(ipRaw);
    if (!ip || ip === 'unknown') {
      throw new ForbiddenException('IP 无效。');
    }

    const permanent = Boolean(options.permanent);
    const minutes = Math.max(1, Number(options.minutes ?? 60) || 60);
    const banUntil = permanent ? null : new Date(Date.now() + minutes * 60_000);
    const banReason =
      options.reason?.trim() ||
      (permanent ? '管理员永久拉黑' : `管理员临时拉黑 ${minutes} 分钟`);

    const row = await this.prisma.shareIpStat.upsert({
      where: { ip },
      create: {
        ip,
        permanentBan: permanent,
        banUntil,
        banReason,
        notes: options.notes?.trim() || null,
      },
      update: {
        permanentBan: permanent,
        banUntil,
        banReason,
        notes: options.notes?.trim() || undefined,
      },
    });

    await this.auditService.write({
      action: AuditAction.SETTING_UPDATE,
      actorId: options.actor?.id,
      detail: {
        kind: 'share-ip-ban',
        ip,
        permanent,
        minutes: permanent ? null : minutes,
        banReason,
      },
    });

    return this.toView(row);
  }

  async unban(ipRaw: string, actor?: RequestUser) {
    const ip = normalizeIp(ipRaw);
    return this.withIpOperation(ip, () => this.unbanIp(ip, actor));
  }

  private async unbanIp(ip: string, actor?: RequestUser) {
    const row = await this.prisma.shareIpStat.findUnique({ where: { ip } });
    if (!row) {
      this.downloadRateLimiter.reset(ip);
      return { success: true, ip };
    }

    const updated = await this.prisma.shareIpStat.update({
      where: { ip },
      data: {
        permanentBan: false,
        banUntil: null,
        banReason: null,
      },
    });
    this.downloadRateLimiter.reset(ip);

    await this.auditService.write({
      action: AuditAction.SETTING_UPDATE,
      actorId: actor?.id,
      detail: { kind: 'share-ip-unban', ip },
    });

    return this.toView(updated);
  }

  private toView(
    row: {
      id: string;
      ip: string;
      downloadCount: number;
      rateLimitCount: number;
      lastDownloadAt: Date | null;
      lastRateLimitedAt: Date | null;
      permanentBan: boolean;
      banUntil: Date | null;
      banReason: string | null;
      notes: string | null;
      lastShareId: string | null;
      lastFileName: string | null;
      createdAt: Date;
      updatedAt: Date;
    },
    now = new Date(),
  ) {
    const tempBanned = Boolean(row.banUntil && row.banUntil.getTime() > now.getTime());
    return {
      ...row,
      banned: row.permanentBan || tempBanned,
      banStatus: row.permanentBan ? 'permanent' : tempBanned ? 'temporary' : 'none',
      banRemainingMinutes:
        tempBanned && row.banUntil
          ? Math.max(1, Math.ceil((row.banUntil.getTime() - now.getTime()) / 60_000))
          : null,
    };
  }
}
