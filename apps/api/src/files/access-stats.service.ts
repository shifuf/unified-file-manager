import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AccessStatsService {
  private readonly logger = new Logger(AccessStatsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Best-effort increment of daily public access counters.
   * Fire-and-forget from hot paths; never throws to callers.
   */
  recordPublicAccess(params: {
    projectId: string;
    fileId: string;
    bytes?: number;
    referer?: string | null;
    origin?: string | null;
  }): void {
    void this.persist(params).catch((error) => {
      this.logger.debug(
        `access stat write failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  private async persist(params: {
    projectId: string;
    fileId: string;
    bytes?: number;
    referer?: string | null;
    origin?: string | null;
  }): Promise<void> {
    const day = this.utcDay();
    const refererHost = this.extractHost(params.referer) || this.extractHost(params.origin) || '';
    const bytes = Math.max(0, Math.floor(Number(params.bytes) || 0));

    // Upsert aggregate row (MySQL-friendly: try update then create).
    const existing = await this.prisma.fileAccessDailyStat.findFirst({
      where: {
        day,
        projectId: params.projectId,
        fileId: params.fileId,
        refererHost,
      },
      select: { id: true },
    });

    if (existing) {
      await this.prisma.fileAccessDailyStat.update({
        where: { id: existing.id },
        data: {
          hits: { increment: 1 },
          bytes: { increment: BigInt(bytes) },
        },
      });
      return;
    }

    try {
      await this.prisma.fileAccessDailyStat.create({
        data: {
          day,
          projectId: params.projectId,
          fileId: params.fileId,
          refererHost,
          hits: 1,
          bytes: BigInt(bytes),
        },
      });
    } catch {
      // Race on unique key: retry as update.
      await this.prisma.fileAccessDailyStat.updateMany({
        where: {
          day,
          projectId: params.projectId,
          fileId: params.fileId,
          refererHost,
        },
        data: {
          hits: { increment: 1 },
          bytes: { increment: BigInt(bytes) },
        },
      });
    }
  }

  async hotspotReport(params: {
    projectId?: string;
    days?: number;
    limit?: number;
  }): Promise<{
    days: number;
    byReferer: Array<{ refererHost: string; hits: number; bytes: number }>;
    byFile: Array<{
      fileId: string | null;
      originalName: string | null;
      hits: number;
      bytes: number;
    }>;
  }> {
    const days = Math.min(90, Math.max(1, params.days ?? 7));
    const limit = Math.min(50, Math.max(1, params.limit ?? 20));
    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);
    since.setUTCDate(since.getUTCDate() - (days - 1));

    const where = {
      day: { gte: since },
      ...(params.projectId ? { projectId: params.projectId } : {}),
    };

    const rows = await this.prisma.fileAccessDailyStat.findMany({
      where,
      select: {
        fileId: true,
        refererHost: true,
        hits: true,
        bytes: true,
      },
    });

    const refererMap = new Map<string, { hits: number; bytes: number }>();
    const fileMap = new Map<string, { hits: number; bytes: number }>();

    for (const row of rows) {
      const host = row.refererHost || '(direct)';
      const r = refererMap.get(host) ?? { hits: 0, bytes: 0 };
      r.hits += row.hits;
      r.bytes += Number(row.bytes);
      refererMap.set(host, r);

      const fid = row.fileId || '';
      if (fid) {
        const f = fileMap.get(fid) ?? { hits: 0, bytes: 0 };
        f.hits += row.hits;
        f.bytes += Number(row.bytes);
        fileMap.set(fid, f);
      }
    }

    const byReferer = [...refererMap.entries()]
      .map(([refererHost, value]) => ({ refererHost, ...value }))
      .sort((a, b) => b.bytes - a.bytes || b.hits - a.hits)
      .slice(0, limit);

    const fileIds = [...fileMap.keys()];
    const names = fileIds.length
      ? await this.prisma.managedFile.findMany({
          where: { id: { in: fileIds } },
          select: { id: true, originalName: true },
        })
      : [];
    const nameMap = new Map(names.map((item) => [item.id, item.originalName]));

    const byFile = [...fileMap.entries()]
      .map(([fileId, value]) => ({
        fileId,
        originalName: nameMap.get(fileId) ?? null,
        ...value,
      }))
      .sort((a, b) => b.bytes - a.bytes || b.hits - a.hits)
      .slice(0, limit);

    return { days, byReferer, byFile };
  }

  private utcDay(): Date {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }

  private extractHost(raw?: string | null): string {
    if (!raw) {
      return '';
    }
    try {
      const url = raw.includes('://') ? new URL(raw) : new URL(`https://${raw}`);
      return url.hostname.toLowerCase().slice(0, 255);
    } catch {
      return String(raw).slice(0, 255);
    }
  }
}
