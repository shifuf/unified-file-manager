import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import type {
  DownloadRecordView,
  DownloadStatInput,
  DownloadStatsFilter,
  DownloadSummary,
  DownloadSourceValue,
} from './download-stats.types';

export const DOWNLOAD_SOURCE_LABELS: Record<string, string> = {
  ADMIN: '后台下载',
  OPEN_API: '开放 API',
  PUBLIC: '公开访问',
  SHARE: '文件分享',
  FOLDER_SHARE: '目录分享',
  WEBDAV: 'WebDAV',
  BATCH: '批量下载',
};

/** Download accounting: per-hit detail rows plus rolled-up daily counters. */
@Injectable()
export class DownloadStatsService {
  private readonly logger = new Logger(DownloadStatsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Fire-and-forget so hot download paths never fail on a stats write. */
  record(input: DownloadStatInput): void {
    void this.persist(input).catch((error) => {
      this.logger.warn(
        `下载统计写入失败 fileId=${input.fileId ?? '-'}：${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  async list(
    filter: DownloadStatsFilter,
    page = 1,
    pageSize = 20,
  ): Promise<{ items: DownloadRecordView[]; total: number; page: number; pageSize: number }> {
    const where = this.where(filter);
    const size = Math.min(100, Math.max(1, pageSize));
    const total = await this.prisma.downloadRecord.count({ where });
    const totalPages = Math.max(1, Math.ceil(total / size));
    const safePage = Math.min(Math.max(1, page), totalPages);

    const rows = await this.prisma.downloadRecord.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (safePage - 1) * size,
      take: size,
    });

    return {
      items: rows.map((row) => ({
        id: row.id,
        projectId: row.projectId,
        fileId: row.fileId,
        originalName: row.originalName,
        bytes: Number(row.size),
        source: row.source as DownloadSourceValue,
        success: row.success,
        ip: row.ip,
        userAgent: row.userAgent,
        referer: row.referer,
        createdAt: row.createdAt,
      })),
      total,
      page: safePage,
      pageSize: size,
    };
  }

  async summary(filter: DownloadStatsFilter): Promise<DownloadSummary> {
    const where = this.where(filter);
    const [count, failedCount, sources, files, days, ips] = await Promise.all([
      this.prisma.downloadRecord.count({ where }),
      this.prisma.downloadRecord.count({ where: { ...where, success: false } }),
      this.prisma.downloadRecord.groupBy({
        by: ['source'],
        where,
        _count: { _all: true },
        _sum: { size: true },
      }),
      this.prisma.downloadRecord.groupBy({
        by: ['fileId', 'originalName'],
        where,
        _count: { _all: true },
        _sum: { size: true },
      }),
      this.prisma.downloadDailyStat.groupBy({
        by: ['day'],
        where: this.dayWhere(filter),
        _sum: { count: true, bytes: true },
        orderBy: { day: 'asc' },
      }),
      this.prisma.downloadRecord.groupBy({
        by: ['ip'],
        where,
        _count: { _all: true },
        _sum: { size: true },
        orderBy: { _count: { ip: 'desc' } },
        take: 10,
      }),
    ]);

    const totalBytes = sources.reduce((sum, row) => sum + Number(row._sum.size ?? 0), 0);

    return {
      totalCount: count,
      totalBytes,
      successCount: count - failedCount,
      failedCount,
      bySource: sources
        .map((row) => ({
          source: row.source as DownloadSourceValue,
          count: row._count._all,
          bytes: Number(row._sum.size ?? 0),
        }))
        .sort((a, b) => b.bytes - a.bytes),
      byFile: files
        .map((row) => ({
          fileId: row.fileId,
          originalName: row.originalName,
          count: row._count._all,
          bytes: Number(row._sum.size ?? 0),
        }))
        .sort((a, b) => b.bytes - a.bytes)
        .slice(0, 20),
      byDay: days.slice(-90).map((row) => ({
        day: row.day instanceof Date ? row.day.toISOString().slice(0, 10) : String(row.day),
        count: Number(row._sum.count ?? 0),
        bytes: Number(row._sum.bytes ?? 0),
      })),
      topIps: ips
        .filter((row) => Boolean(row.ip))
        .map((row) => ({
          ip: row.ip as string,
          count: row._count._all,
          bytes: Number(row._sum.size ?? 0),
        })),
    };
  }

  /** Date-bounded filter for the pre-aggregated `DownloadDailyStat` rollups. */
  private dayWhere(filter: DownloadStatsFilter) {
    return {
      ...(filter.projectId ? { projectId: filter.projectId } : {}),
      ...(filter.fileId ? { fileId: filter.fileId } : {}),
      ...(filter.source ? { source: filter.source } : {}),
      ...(filter.from || filter.to
        ? {
            day: {
              ...(filter.from ? { gte: startOfUtcDay(filter.from) } : {}),
              ...(filter.to ? { lte: filter.to } : {}),
            },
          }
        : {}),
    };
  }

  private where(filter: DownloadStatsFilter) {
    return {
      ...(filter.projectId ? { projectId: filter.projectId } : {}),
      ...(filter.fileId ? { fileId: filter.fileId } : {}),
      ...(filter.source ? { source: filter.source } : {}),
      ...(filter.from || filter.to
        ? {
            createdAt: {
              ...(filter.from ? { gte: filter.from } : {}),
              ...(filter.to ? { lte: filter.to } : {}),
            },
          }
        : {}),
    };
  }

  private async persist(input: DownloadStatInput): Promise<void> {
    const bytes = Math.max(0, Math.floor(Number(input.bytes) || 0));
    const success = input.success !== false;

    await this.prisma.downloadRecord.create({
      data: {
        projectId: input.projectId,
        fileId: input.fileId ?? null,
        originalName: input.originalName ?? null,
        size: BigInt(bytes),
        source: input.source,
        actorId: input.actorId ?? null,
        shareId: input.shareId ?? null,
        ip: input.ip ?? null,
        userAgent: input.userAgent?.slice(0, 512) ?? null,
        referer: input.referer?.slice(0, 512) ?? null,
        rangeStart: input.rangeStart == null ? null : BigInt(input.rangeStart),
        rangeEnd: input.rangeEnd == null ? null : BigInt(input.rangeEnd),
        success,
        message: input.message?.slice(0, 512) ?? null,
      },
    });

    const day = utcDay();
    const where = {
      day,
      projectId: input.projectId,
      fileId: input.fileId ?? null,
      source: input.source,
    };
    const existing = await this.prisma.downloadDailyStat.findFirst({ where, select: { id: true } });

    if (existing) {
      await this.prisma.downloadDailyStat.update({
        where: { id: existing.id },
        data: {
          count: { increment: 1 },
          bytes: { increment: BigInt(bytes) },
          successCount: success ? { increment: 1 } : undefined,
          failedCount: success ? undefined : { increment: 1 },
        },
      });
      return;
    }

    try {
      await this.prisma.downloadDailyStat.create({
        data: {
          day,
          projectId: input.projectId,
          fileId: input.fileId ?? null,
          source: input.source,
          count: 1,
          bytes: BigInt(bytes),
          successCount: success ? 1 : 0,
          failedCount: success ? 0 : 1,
        },
      });
    } catch {
      await this.prisma.downloadDailyStat.updateMany({
        where,
        data: {
          count: { increment: 1 },
          bytes: { increment: BigInt(bytes) },
          successCount: success ? { increment: 1 } : undefined,
          failedCount: success ? undefined : { increment: 1 },
        },
      });
    }
  }
}

function utcDay(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function startOfUtcDay(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}
