import { BadRequestException, Injectable } from '@nestjs/common';
import { AuditAction, type Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';

interface WriteAuditParams {
  action: AuditAction;
  actorId?: string;
  projectId?: string;
  ip?: string;
  userAgent?: string;
  detail?: Prisma.InputJsonValue;
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async write(params: WriteAuditParams): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        action: params.action,
        actorId: params.actorId,
        projectId: params.projectId,
        ip: params.ip,
        userAgent: params.userAgent,
        detail: params.detail,
      },
    });
  }

  async list(params: {
    page?: number;
    pageSize?: number;
    projectId?: string;
    action?: AuditAction;
    keyword?: string;
    startAt?: string;
    endAt?: string;
  }): Promise<{
    items: Record<string, unknown>[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? 20;
    const where = this.buildWhere(params);

    const [items, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({
        where,
        include: {
          actor: { select: { id: true, username: true, displayName: true } },
          project: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return {
      items: items.map((item) => ({
        id: item.id,
        action: item.action,
        actor: item.actor,
        project: item.project,
        ip: item.ip,
        userAgent: item.userAgent,
        detail: item.detail,
        createdAt: item.createdAt,
      })),
      total,
      page,
      pageSize,
    };
  }

  async export(params: {
    format?: 'csv' | 'json';
    projectId?: string;
    action?: AuditAction;
    keyword?: string;
    startAt?: string;
    endAt?: string;
  }, actorId?: string): Promise<{ contentType: string; filename: string; body: string }> {
    const where = this.buildWhere(params);
    const items = await this.prisma.auditLog.findMany({
      where,
      include: {
        actor: { select: { id: true, username: true, displayName: true } },
        project: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 50_000,
    });

    await this.write({
      action: AuditAction.AUDIT_EXPORT,
      actorId,
      projectId: params.projectId,
      detail: { count: items.length, format: params.format ?? 'json' },
    });

    const rows = items.map((item) => ({
      id: item.id,
      action: item.action,
      actor: item.actor?.username ?? '',
      project: item.project?.name ?? '',
      ip: item.ip ?? '',
      userAgent: item.userAgent ?? '',
      detail: JSON.stringify(item.detail ?? {}),
      createdAt: item.createdAt.toISOString(),
    }));

    if ((params.format ?? 'json') === 'csv') {
      const header = ['id', 'action', 'actor', 'project', 'ip', 'userAgent', 'detail', 'createdAt'];
      const escape = (value: string) => `"${String(value).replace(/"/g, '""')}"`;
      const lines = [
        header.join(','),
        ...rows.map((row) =>
          header.map((key) => escape(String((row as Record<string, string>)[key] ?? ''))).join(','),
        ),
      ];
      return {
        contentType: 'text/csv; charset=utf-8',
        filename: `audit-logs-${Date.now()}.csv`,
        body: lines.join('\n'),
      };
    }

    return {
      contentType: 'application/json; charset=utf-8',
      filename: `audit-logs-${Date.now()}.json`,
      body: JSON.stringify(rows, null, 2),
    };
  }

  async cleanup(params: {
    beforeAt: string;
    projectId?: string;
    action?: AuditAction;
    keyword?: string;
  }, actorId?: string): Promise<{ success: boolean; deleted: number }> {
    if (!params.beforeAt) {
      throw new BadRequestException('请选择要清理的截止时间。');
    }

    const beforeAt = new Date(params.beforeAt);
    if (Number.isNaN(beforeAt.getTime())) {
      throw new BadRequestException('清理截止时间无效。');
    }

    if (beforeAt.getTime() > Date.now()) {
      throw new BadRequestException('清理截止时间不能晚于当前时间。');
    }

    const result = await this.prisma.auditLog.deleteMany({
      where: this.buildWhere({
        projectId: params.projectId,
        action: params.action,
        keyword: params.keyword,
        endAt: params.beforeAt,
      }),
    });

    await this.write({
      action: AuditAction.AUDIT_LOG_CLEANUP,
      actorId,
      detail: {
        beforeAt: params.beforeAt,
        projectId: params.projectId,
        action: params.action,
        keyword: params.keyword,
        deleted: result.count,
      },
    });

    return { success: true, deleted: result.count };
  }

  private buildWhere(params: {
    projectId?: string;
    action?: AuditAction;
    keyword?: string;
    startAt?: string;
    endAt?: string;
  }): Prisma.AuditLogWhereInput {
    const where: Prisma.AuditLogWhereInput = {
      ...(params.projectId ? { projectId: params.projectId } : {}),
      ...(params.action ? { action: params.action } : {}),
      ...(params.startAt || params.endAt
        ? {
            createdAt: {
              ...(params.startAt ? { gte: new Date(params.startAt) } : {}),
              ...(params.endAt ? { lt: new Date(params.endAt) } : {}),
            },
          }
        : {}),
    };
    const keyword = params.keyword?.trim();

    if (keyword) {
      where.OR = [
        { ip: { contains: keyword } },
        { userAgent: { contains: keyword } },
        { actor: { is: { username: { contains: keyword } } } },
        { actor: { is: { displayName: { contains: keyword } } } },
        { project: { is: { name: { contains: keyword } } } },
      ];
    }

    return where;
  }
}
