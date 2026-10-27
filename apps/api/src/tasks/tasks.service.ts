import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditAction, UserRole, type Prisma } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../common/types/request-user.type';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectAccessService } from '../projects/project-access.service';
import { ListTasksDto } from './dto/list-tasks.dto';

export interface CreateTaskParams {
  projectId?: string;
  type: string;
  title: string;
  status?: string;
  progress?: number;
  detail?: Prisma.InputJsonValue;
  result?: Prisma.InputJsonValue;
  error?: string;
  actorId?: string;
}

@Injectable()
export class TasksService {
  constructor(
    private readonly auditService: AuditService,
    private readonly prisma: PrismaService,
    private readonly projectAccessService: ProjectAccessService,
  ) {}

  async create(params: CreateTaskParams): Promise<Record<string, unknown>> {
    const status = params.status ?? 'COMPLETED';
    const task = await this.prisma.task.create({
      data: {
        projectId: params.projectId,
        type: params.type,
        title: params.title,
        status,
        progress: params.progress ?? (status === 'COMPLETED' ? 100 : 0),
        detail: params.detail,
        result: params.result,
        error: params.error,
        finishedAt: status === 'RUNNING' ? null : new Date(),
      },
    });

    await this.auditService.write({
      action: AuditAction.TASK_CREATE,
      actorId: params.actorId,
      projectId: params.projectId,
      detail: { taskId: task.id, type: task.type, status: task.status },
    });

    return this.toResponse(task);
  }

  async update(
    taskId: string,
    patch: {
      status?: string;
      progress?: number;
      detail?: Prisma.InputJsonValue;
      result?: Prisma.InputJsonValue;
      error?: string | null;
    },
  ): Promise<Record<string, unknown>> {
    const existing = await this.prisma.task.findUnique({ where: { id: taskId } });
    if (!existing) {
      throw new NotFoundException('任务不存在。');
    }

    const status = patch.status ?? existing.status;
    const finished =
      status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELED'
        ? existing.finishedAt ?? new Date()
        : status === 'RUNNING'
          ? null
          : existing.finishedAt;

    const task = await this.prisma.task.update({
      where: { id: taskId },
      data: {
        status,
        progress: patch.progress ?? existing.progress,
        detail: patch.detail === undefined ? undefined : patch.detail,
        result: patch.result === undefined ? undefined : patch.result,
        error: patch.error === undefined ? undefined : patch.error,
        finishedAt: finished,
      },
    });

    return this.toResponse(task);
  }

  async list(query: ListTasksDto, user: RequestUser): Promise<{
    items: Record<string, unknown>[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    if (query.projectId) {
      await this.projectAccessService.assertProjectAccess(user, query.projectId);
    }

    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const where: Prisma.TaskWhereInput = {
      ...(query.projectId ? { projectId: query.projectId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.type ? { type: query.type } : {}),
      // Single super-admin: tasks are not scoped by project membership.
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.task.findMany({
        where,
        include: { project: { select: { id: true, name: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.task.count({ where }),
    ]);

    return {
      items: items.map((item) => this.toResponse(item)),
      total,
      page,
      pageSize,
    };
  }

  async get(taskId: string, user: RequestUser): Promise<Record<string, unknown>> {
    const task = await this.findTaskForUser(taskId, user);
    return this.toResponse(task);
  }

  async cancel(taskId: string, user: RequestUser): Promise<Record<string, unknown>> {
    const task = await this.findTaskForUser(taskId, user, true);

    if (!['RUNNING', 'PAUSED'].includes(task.status)) {
      throw new BadRequestException('只有运行中或已暂停的任务可以取消。');
    }

    const updated = await this.prisma.task.update({
      where: { id: taskId },
      data: {
        status: 'CANCELED',
        progress: task.progress,
        error: '任务已手动取消。',
        finishedAt: new Date(),
        leaseOwner: null,
        leaseUntil: null,
      },
      include: { project: { select: { id: true, name: true } } },
    });

    await this.auditService.write({
      action: AuditAction.TASK_CANCEL,
      actorId: user.id,
      projectId: task.projectId ?? undefined,
      detail: { taskId, type: task.type },
    });

    return this.toResponse(updated);
  }

  async pause(taskId: string, user: RequestUser): Promise<Record<string, unknown>> {
    const task = await this.findTaskForUser(taskId, user, true);
    if (task.type !== 'STORAGE_MIGRATION' || task.status !== 'RUNNING') {
      throw new BadRequestException('仅运行中的存储迁移任务可以暂停。');
    }
    const paused = await this.prisma.task.update({
      where: { id: taskId },
      data: { status: 'PAUSED', leaseOwner: null, leaseUntil: null },
      include: { project: { select: { id: true, name: true } } },
    });
    return this.toResponse(paused);
  }

  async resume(taskId: string, user: RequestUser): Promise<Record<string, unknown>> {
    const task = await this.findTaskForUser(taskId, user, true);
    if (task.type !== 'STORAGE_MIGRATION' || task.status !== 'PAUSED') {
      throw new BadRequestException('仅已暂停的存储迁移任务可以恢复。');
    }
    const resumed = await this.prisma.task.update({
      where: { id: taskId },
      data: { status: 'RUNNING', error: null, finishedAt: null, leaseOwner: null, leaseUntil: null },
      include: { project: { select: { id: true, name: true } } },
    });
    return this.toResponse(resumed);
  }

  async retry(taskId: string, user: RequestUser): Promise<Record<string, unknown>> {
    const task = await this.findTaskForUser(taskId, user, true);

    if (task.status !== 'FAILED') {
      throw new BadRequestException('只有失败任务可以重试。');
    }

    const originalDetail = this.asRecord(task.detail);
    const failedIds = Array.isArray(originalDetail.failures)
      ? originalDetail.failures.flatMap((failure) => {
          if (!failure || typeof failure !== 'object' || Array.isArray(failure)) return [];
          const id = (failure as Record<string, unknown>).fileId;
          return typeof id === 'string' ? [id] : [];
        })
      : [];
    const migrationRetry = task.type === 'STORAGE_MIGRATION';
    const retryDetail: Prisma.InputJsonValue = migrationRetry
      ? {
          ...originalDetail,
          retriedFromTaskId: task.id,
          retryFileIds: failedIds.length > 0 ? failedIds : undefined,
          retryIndex: 0,
          cursor: failedIds.length > 0 ? '' : String(originalDetail.cursor ?? ''),
          total: failedIds.length > 0 ? failedIds.length : originalDetail.total,
          scanned: 0,
          migrated: 0,
          skipped: 0,
          failed: 0,
          failures: [],
        } as Prisma.InputJsonObject
      : { retriedFromTaskId: task.id, originalDetail: task.detail };
    const retried = await this.prisma.task.create({
      data: {
        projectId: task.projectId,
        type: task.type,
        title: `${task.title}（重试）`,
        status: migrationRetry ? 'RUNNING' : 'COMPLETED',
        progress: migrationRetry ? 0 : 100,
        detail: retryDetail,
        result: migrationRetry ? undefined : {
          retryNotice: '该任务已重新登记；涉及外部副作用的任务请在对应功能页重新执行。',
          originalError: task.error,
        },
        finishedAt: migrationRetry ? null : new Date(),
      },
      include: { project: { select: { id: true, name: true } } },
    });

    await this.auditService.write({
      action: AuditAction.TASK_RETRY,
      actorId: user.id,
      projectId: task.projectId ?? undefined,
      detail: { taskId, retriedTaskId: retried.id, type: task.type },
    });

    return this.toResponse(retried);
  }

  async remove(taskId: string, user: RequestUser): Promise<{ success: boolean }> {
    const task = await this.findTaskForUser(taskId, user, true);

    if (task.status === 'RUNNING') {
      throw new BadRequestException('运行中的任务不能删除，请先取消。');
    }

    await this.prisma.task.delete({ where: { id: taskId } });

    await this.auditService.write({
      action: AuditAction.TASK_DELETE,
      actorId: user.id,
      projectId: task.projectId ?? undefined,
      detail: { taskId, type: task.type },
    });

    return { success: true };
  }

  private asRecord(value: Prisma.JsonValue | null): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  }

  private async findTaskForUser(
    taskId: string,
    user: RequestUser,
    requireAdmin = false,
  ): Promise<{
    id: string;
    projectId: string | null;
    type: string;
    title: string;
    status: string;
    progress: number;
    detail: Prisma.JsonValue | null;
    result: Prisma.JsonValue | null;
    error: string | null;
    createdAt: Date;
    updatedAt: Date;
    finishedAt: Date | null;
    project?: { id: string; name: string } | null;
  }> {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      include: { project: { select: { id: true, name: true } } },
    });

    if (!task) {
      throw new NotFoundException('任务不存在。');
    }

    if (user.role !== UserRole.SUPER_ADMIN) {
      throw new NotFoundException('任务不存在。');
    }
    if (task.projectId) {
      await this.projectAccessService.assertProjectAccess(user, task.projectId, requireAdmin);
    }

    return task;
  }

  private toResponse(task: {
    id: string;
    projectId: string | null;
    type: string;
    title: string;
    status: string;
    progress: number;
    detail: Prisma.JsonValue | null;
    result: Prisma.JsonValue | null;
    error: string | null;
    createdAt: Date;
    updatedAt: Date;
    finishedAt: Date | null;
    project?: { id: string; name: string } | null;
  }): Record<string, unknown> {
    return {
      id: task.id,
      projectId: task.projectId,
      project: task.project,
      type: task.type,
      title: task.title,
      status: task.status,
      progress: task.progress,
      detail: task.detail,
      result: task.result,
      error: task.error,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      finishedAt: task.finishedAt,
    };
  }
}
