import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import type { RequestUser } from '../common/types/request-user.type';
import { PrismaService } from '../prisma/prisma.service';

const projectScope = { deletedAt: null };
const fileScope: Prisma.ManagedFileWhereInput = {
  status: 'ACTIVE',
  deletedAt: null,
  project: projectScope,
};
const taskScope: Prisma.TaskWhereInput = { OR: [{ projectId: null }, { project: projectScope }] };
const storageScope: Prisma.CdnConfigWhereInput = {
  OR: [{ projectId: null }, { project: projectScope }],
};
const storageSelect = {
  id: true,
  name: true,
  provider: true,
  enabled: true,
  priority: true,
  projectId: true,
} as const;
type PageQuery = { page?: string | number; pageSize?: string | number };
type StatusGroup = { status: string; _count: { _all: number }; _sum?: { size: bigint | null } };
type StorageSummary = {
  id: string;
  name: string;
  provider: string;
  enabled: boolean;
  priority: number;
  projectId?: string | null;
};

function replicasView(groups: StatusGroup[]) {
  const count = (statuses: string[]) =>
    groups.filter((g) => statuses.includes(g.status)).reduce((sum, g) => sum + g._count._all, 0);
  return {
    ready: count(['READY']),
    pending: count(['PENDING', 'SYNCING']),
    failedOrMissing: count(['FAILED', 'MISSING']),
    readyBytes: groups
      .filter((g) => g.status === 'READY')
      .reduce((sum, g) => sum + (g._sum?.size ?? 0n), 0n)
      .toString(),
  };
}

function pagination(query: PageQuery, total: number) {
  const integer = (value: string | number | undefined, defaultValue: number) => {
    if (value === undefined) return defaultValue;
    if (
      (typeof value !== 'string' && typeof value !== 'number') ||
      (typeof value === 'string' && !/^\d+$/.test(value)) ||
      !Number.isSafeInteger(Number(value)) ||
      Number(value) < 1
    ) {
      throw new BadRequestException('页码和每页条数必须为正整数。');
    }
    return Number(value);
  };
  const pageSize = integer(query.pageSize, 20);
  if (![10, 20, 50, 100].includes(pageSize))
    throw new BadRequestException('每页条数应为 10、20、50 或 100。');
  return {
    page: Math.min(integer(query.page, 1), Math.max(1, Math.ceil(total / pageSize))),
    pageSize,
    total,
  };
}

function backupView(
  row: {
    id: string;
    name: string;
    status: string;
    includeObjects: boolean;
    createdAt: Date;
    finishedAt: Date | null;
  } | null,
) {
  return row
    ? {
        id: row.id,
        name: row.name,
        status: row.status,
        includeObjects: row.includeObjects,
        createdAt: row.createdAt.toISOString(),
        finishedAt: row.finishedAt?.toISOString() ?? null,
      }
    : null;
}

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  private assertAdmin(user: RequestUser): void {
    if (user.role !== 'SUPER_ADMIN') throw new ForbiddenException('仅超级管理员可访问管理接口。');
  }

  async summary(user: RequestUser) {
    this.assertAdmin(user);
    const [projects, enabledProjects, files, storage, replicas, tasks] = await Promise.all([
      this.prisma.project.count({ where: projectScope }),
      this.prisma.project.count({ where: { ...projectScope, enabled: true } }),
      this.prisma.managedFile.aggregate({
        where: fileScope,
        _count: { _all: true },
        _sum: { size: true },
      }),
      this.prisma.cdnConfig.count({ where: { ...storageScope, enabled: true } }),
      this.prisma.storageReplica.groupBy({
        by: ['status'],
        where: { project: projectScope },
        _count: { _all: true },
        _sum: { size: true },
      }),
      this.prisma.task.groupBy({ by: ['status'], where: taskScope, _count: { _all: true } }),
    ]);
    const taskCount = (status: string) => tasks.find((g) => g.status === status)?._count._all ?? 0;
    return {
      updatedAt: new Date().toISOString(),
      projects: { total: projects, enabled: enabledProjects },
      files: { active: files._count._all, sourceBytes: (files._sum.size ?? 0n).toString() },
      storage: { enabled: storage },
      replicas: replicasView(replicas),
      tasks: { running: taskCount('RUNNING'), failed: taskCount('FAILED') },
    };
  }

  async trends(span: string | undefined, user: RequestUser, now = new Date()) {
    this.assertAdmin(user);
    if (span !== undefined && span !== '7' && span !== '30')
      throw new BadRequestException('趋势仅支持最近 7 或 30 天。');
    const days = span === '30' ? 30 : 7;
    // MySQL DATETIME is stored in UTC by Prisma. Fixed +08:00 avoids dependence on installed timezone tables.
    const today = new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10);
    const end = new Date(`${today}T16:00:00.000Z`);
    const start = new Date(end.getTime() - days * 86400000);
    const rows = await this.prisma.$queryRaw<
      Array<{ day: string; requests: bigint; bytes: bigint | Prisma.Decimal | null }>
    >(Prisma.sql`
      SELECT DATE_FORMAT(DATE_ADD(d.createdAt, INTERVAL 8 HOUR), '%Y-%m-%d') AS day,
             COUNT(*) AS requests, COALESCE(SUM(d.size), 0) AS bytes
      FROM DownloadRecord d INNER JOIN Project p ON p.id = d.projectId
      WHERE p.deletedAt IS NULL AND d.createdAt >= ${start} AND d.createdAt < ${end}
      GROUP BY day ORDER BY day ASC LIMIT ${days}
    `);
    const byDay = new Map(rows.map((row) => [row.day, row]));
    const items = Array.from({ length: days }, (_, index) => {
      const day = new Date(start.getTime() + (index + 1) * 86400000).toISOString().slice(0, 10);
      const row = byDay.get(day);
      return { day, requests: Number(row?.requests ?? 0), bytes: row?.bytes?.toString() ?? '0' };
    });
    return { updatedAt: now.toISOString(), timezone: 'Asia/Shanghai', days, items };
  }

  async storage(query: PageQuery, user: RequestUser) {
    this.assertAdmin(user);
    pagination(query, 0);
    const total = await this.prisma.cdnConfig.count({ where: storageScope });
    const page = pagination(query, total);
    const configs = await this.prisma.cdnConfig.findMany({
      where: storageScope,
      orderBy: [{ priority: 'asc' }, { id: 'asc' }],
      skip: (page.page - 1) * page.pageSize,
      take: page.pageSize,
      select: {
        ...storageSelect,
        _count: { select: { projectBindings: { where: { project: projectScope } } } },
      },
    });
    const ids = configs.map((c) => c.id);
    const [replicas, healthRows] = ids.length
      ? await Promise.all([
          this.prisma.storageReplica.groupBy({
            by: ['configId', 'status'],
            where: { configId: { in: ids }, project: projectScope },
            _count: { _all: true },
            _sum: { size: true },
          }),
          this.prisma.$queryRaw<
            Array<{ configId: string; success: string | null; createdAt: Date }>
          >(Prisma.sql`
        SELECT configId, success, createdAt FROM (
          SELECT JSON_UNQUOTE(JSON_EXTRACT(detail, '$.configId')) AS configId,
                 JSON_UNQUOTE(JSON_EXTRACT(detail, '$.success')) AS success, createdAt,
                 ROW_NUMBER() OVER (PARTITION BY JSON_UNQUOTE(JSON_EXTRACT(detail, '$.configId')) ORDER BY createdAt DESC, id DESC) AS rn
          FROM AuditLog WHERE action = 'CDN_HEALTH_CHECK'
            AND JSON_UNQUOTE(JSON_EXTRACT(detail, '$.configId')) IN (${Prisma.join(ids)})
            AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(detail, '$.draft')), 'false') <> 'true'
        ) latest WHERE rn = 1 LIMIT ${ids.length}
      `),
        ])
      : [[], []];
    const health = new Map(healthRows.map((row) => [row.configId, row]));
    return {
      updatedAt: new Date().toISOString(),
      ...page,
      items: configs.map((config) => {
        const check = health.get(config.id);
        return {
          id: config.id,
          name: config.name,
          provider: config.provider,
          enabled: config.enabled,
          priority: config.priority,
          boundProjects: config._count.projectBindings,
          health: {
            status:
              check?.success === 'true'
                ? 'HEALTHY'
                : check?.success === 'false'
                  ? 'FAILED'
                  : 'UNKNOWN',
            checkedAt: check?.createdAt.toISOString() ?? null,
          },
          accountUsedBytes: null,
          replicas: replicasView(replicas.filter((row) => row.configId === config.id)),
        };
      }),
    };
  }

  async activity(query: PageQuery, user: RequestUser) {
    this.assertAdmin(user);
    pagination(query, 0);
    const backupSelect = {
      id: true,
      name: true,
      status: true,
      includeObjects: true,
      createdAt: true,
      finishedAt: true,
    } as const;
    const [
      recentFiles,
      topGroups,
      failedTasks,
      replicaProjects,
      recycleFiles,
      latestBackup,
      lastFailed,
      total,
      fallback,
    ] = await Promise.all([
      this.prisma.managedFile.findMany({
        where: fileScope,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 10,
        select: {
          id: true,
          originalName: true,
          projectId: true,
          size: true,
          createdAt: true,
          project: { select: { id: true, name: true } },
        },
      }),
      this.prisma.managedFile.groupBy({
        by: ['projectId'],
        where: fileScope,
        _count: { _all: true },
        _sum: { size: true },
        orderBy: [{ _sum: { size: 'desc' } }, { projectId: 'asc' }],
        take: 5,
      }),
      this.prisma.task.findMany({
        where: { ...taskScope, status: 'FAILED' },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 5,
        select: { id: true, title: true, projectId: true, type: true, createdAt: true },
      }),
      this.prisma.storageReplica.groupBy({
        by: ['projectId'],
        where: { project: projectScope, status: { in: ['FAILED', 'MISSING'] } },
        _count: { _all: true },
        orderBy: [{ _count: { projectId: 'desc' } }, { projectId: 'asc' }],
        take: 5,
      }),
      this.prisma.managedFile.count({ where: { status: 'RECYCLED', project: projectScope } }),
      this.prisma.backup.findFirst({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: backupSelect,
      }),
      this.prisma.backup.findFirst({
        where: { status: 'FAILED' },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: backupSelect,
      }),
      this.prisma.project.count({ where: projectScope }),
      this.prisma.cdnConfig.findFirst({
        where: { provider: 'LOCAL', enabled: true, projectId: null },
        orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        select: storageSelect,
      }),
    ]);
    let page = pagination(query, total);
    const projectRows = () =>
      this.prisma.project.findMany({
        where: projectScope,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page.page - 1) * page.pageSize,
        take: page.pageSize,
        select: {
          id: true,
          name: true,
          enabled: true,
          _count: { select: { files: { where: { status: 'ACTIVE', deletedAt: null } } } },
          storageBindings: { select: { config: { select: storageSelect } } },
        },
      });
    let projects = await projectRows();
    if (!projects.length && page.total > 0) {
      page = pagination(query, await this.prisma.project.count({ where: projectScope }));
      projects = await projectRows();
    }
    const lookupIds = [
      ...new Set([
        ...topGroups.map((g) => g.projectId),
        ...replicaProjects.map((g) => g.projectId),
      ]),
    ];
    const names = lookupIds.length
      ? await this.prisma.project.findMany({
          where: { id: { in: lookupIds }, ...projectScope },
          take: 10,
          select: { id: true, name: true },
        })
      : [];
    const nameMap = new Map(names.map((p) => [p.id, p.name]));
    return {
      updatedAt: new Date().toISOString(),
      recentFiles: recentFiles.map((f) => ({
        id: f.id,
        name: f.originalName,
        projectId: f.projectId,
        projectName: f.project.name,
        size: f.size.toString(),
        createdAt: f.createdAt.toISOString(),
      })),
      topProjects: topGroups
        .filter((g) => nameMap.has(g.projectId))
        .map((g) => ({
          id: g.projectId,
          name: nameMap.get(g.projectId)!,
          fileCount: g._count._all,
          sourceBytes: (g._sum.size ?? 0n).toString(),
        })),
      exceptions: {
        recycleFiles,
        failedTasks: failedTasks.map((t) => ({
          id: t.id,
          title: t.title,
          projectId: t.projectId,
          type: t.type,
          createdAt: t.createdAt.toISOString(),
        })),
        replicaProjects: replicaProjects
          .filter((g) => nameMap.has(g.projectId))
          .map((g) => ({
            projectId: g.projectId,
            projectName: nameMap.get(g.projectId)!,
            failedOrMissing: g._count._all,
          })),
      },
      backup: { latest: backupView(latestBackup), lastFailed: backupView(lastFailed) },
      projects: {
        ...page,
        items: projects.map((p) => {
          const storages: StorageSummary[] = p.storageBindings.map((b) => b.config);
          if (
            fallback &&
            !storages.some((s) => s.provider === 'LOCAL' && s.enabled && s.projectId === null) &&
            !storages.some((s) => s.id === fallback.id)
          )
            storages.push(fallback);
          storages.sort(
            (a, b) =>
              Number(a.provider === 'LOCAL') - Number(b.provider === 'LOCAL') ||
              a.priority - b.priority ||
              a.id.localeCompare(b.id),
          );
          return {
            id: p.id,
            name: p.name,
            enabled: p.enabled,
            fileCount: p._count.files,
            storages: storages.map((s) => ({
              id: s.id,
              name: s.name,
              provider: s.provider,
              enabled: s.enabled,
              priority: s.priority,
            })),
          };
        }),
      },
    };
  }
}
