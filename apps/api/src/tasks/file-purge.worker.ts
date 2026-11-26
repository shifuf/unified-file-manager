import { randomUUID } from 'node:crypto';

import { BadRequestException, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AuditAction, UserRole, type Prisma } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { DOMAIN_EVENTS } from '../events/domain-events';
import { EventBusService } from '../events/event-bus.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectAccessService } from '../projects/project-access.service';
import { StorageService } from '../storage/storage.service';
import { purgeFileIds } from './file-purge.util';

type PurgeFailure = { fileId: string; error: string };
type PurgeDetail = {
  fileIds: string[];
  actorId: string;
  nextIndex: number;
  deleted: number;
  alreadyAbsent: number;
  failedFileIds: string[];
  failures: PurgeFailure[];
  batchSize: number;
  retriedFromTaskId?: string;
};
const LEASE_MS = 5 * 60_000;

@Injectable()
export class FilePurgeWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FilePurgeWorker.name);
  private readonly workerId = randomUUID();
  private timer?: NodeJS.Timeout;
  private stopped = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly projectAccess: ProjectAccessService,
    private readonly events: EventBusService,
  ) {}

  onModuleInit(): void { void this.runLoop(); }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private async runLoop(): Promise<void> {
    if (this.stopped) return;
    try { await this.runOneBatch(); }
    catch (error) { this.logger.error(`彻底删除任务批次异常：${this.errorMessage(error)}`); }
    if (!this.stopped) this.timer = setTimeout(() => void this.runLoop(), 3000);
  }

  private async runOneBatch(): Promise<void> {
    const now = new Date();
    const claimable = {
      type: 'FILE_BATCH_PURGE', status: 'RUNNING',
      OR: [{ leaseOwner: this.workerId }, { leaseUntil: null }, { leaseUntil: { lt: now } }],
    };
    const candidate = await this.prisma.task.findFirst({ where: claimable, orderBy: { createdAt: 'asc' } });
    if (!candidate) return;
    const claim = await this.prisma.task.updateMany({
      where: { id: candidate.id, ...claimable },
      data: { leaseOwner: this.workerId, leaseUntil: new Date(Date.now() + LEASE_MS) },
    });
    if (claim.count !== 1) return;

    const heartbeat = setInterval(() => {
      void this.prisma.task.updateMany({ where: this.owned(candidate.id),
        data: { leaseUntil: new Date(Date.now() + LEASE_MS) } })
        .catch(() => this.logger.warn('彻底删除任务续租失败，停止后续删除前将复核租约。'));
    }, 30_000);
    heartbeat.unref?.();
    try {
      const task = await this.prisma.task.findUnique({ where: { id: candidate.id } });
      if (!task || !await this.hasLease(task.id)) return;
      if (!task.projectId) throw new BadRequestException('删除任务缺少项目，请回到回收站重新选择文件。');
      const projectId = task.projectId;
      const detail = this.parseDetail(task.detail);
      const end = Math.min(detail.fileIds.length, detail.nextIndex + detail.batchSize);
      for (; detail.nextIndex < end;) {
        if (this.stopped || !await this.hasLease(task.id)) return;
        const fileId = detail.fileIds[detail.nextIndex];
        try {
          // Recheck the actual account and project for each item: a queued task
          // cannot retain access after its initiating account/project is disabled.
          const actor = await this.prisma.user.findUnique({ where: { id: detail.actorId } });
          if (!actor?.enabled || actor.role !== UserRole.SUPER_ADMIN) {
            throw new BadRequestException('执行用户已停用或无权彻底删除文件。');
          }
          await this.projectAccess.assertProjectAccess(actor, projectId, true);
          const file = await this.prisma.managedFile.findUnique({ where: { id: fileId } });
          if (file && (file.projectId !== projectId || file.status !== 'RECYCLED')) {
            throw new BadRequestException('文件不属于该项目的回收站，请刷新后重新选择。');
          }
          if (!await this.hasLease(task.id)) return;
          if (file) {
            const expected = { id: file.id, projectId, storageKey: file.storageKey, currentVersion: file.currentVersion };
            const keys = await this.storage.removeFileObjects(file.id, { expectedHead: expected });
            // An in-flight provider operation may finish after cancel/takeover;
            // it must not authorize metadata removal or another file deletion.
            if (!await this.hasLease(task.id)) return;
            await this.storage.finishFileDeletion(expected, keys);
          }
          // Also audit idempotent recovery after a crash between hard deletion
          // and checkpoint/audit persistence. No remaining record is fabricated.
          await this.audit.write({
            action: AuditAction.FILE_PURGE, actorId: actor.id, projectId,
            detail: { fileId, taskId: task.id, storageRemoved: true, alreadyAbsent: !file, source: 'TASK_RETRY' },
          });
          if (file) {
            this.events.emit(DOMAIN_EVENTS.FILE_PURGED, { projectId, fileId, originalName: file.originalName, actorId: actor.id });
            detail.deleted++;
          } else detail.alreadyAbsent++;
        } catch (error) {
          detail.failedFileIds.push(fileId);
          detail.failures.push({ fileId, error: this.errorMessage(error) });
        }
        detail.nextIndex++;
        const saved = await this.prisma.task.updateMany({ where: this.owned(task.id), data: {
          detail: detail as unknown as Prisma.InputJsonObject,
          progress: Math.min(99, Math.floor(100 * detail.nextIndex / detail.fileIds.length)),
          leaseUntil: new Date(Date.now() + LEASE_MS),
        } });
        if (saved.count !== 1) return;
      }
      if (detail.nextIndex >= detail.fileIds.length) {
        const failed = detail.failedFileIds.length;
        await this.prisma.task.updateMany({ where: this.owned(task.id), data: {
          status: failed ? 'FAILED' : 'COMPLETED', progress: 100,
          detail: detail as unknown as Prisma.InputJsonObject,
          result: { total: detail.fileIds.length, deleted: detail.deleted, alreadyAbsent: detail.alreadyAbsent,
            failed, failures: detail.failures },
          error: failed ? `${failed} 个文件彻底删除失败：${detail.failures[0]?.error ?? '请查看失败详情'}。可在任务中心重试。`.slice(0, 1000) : null,
          finishedAt: new Date(), leaseOwner: null, leaseUntil: null,
        } });
      }
    } catch (error) {
      await this.prisma.task.updateMany({ where: this.owned(candidate.id), data: {
        status: 'FAILED', error: this.errorMessage(error), finishedAt: new Date(), leaseOwner: null, leaseUntil: null,
      } });
    } finally { clearInterval(heartbeat); }
  }

  private owned(taskId: string): Prisma.TaskWhereInput {
    return { id: taskId, type: 'FILE_BATCH_PURGE', status: 'RUNNING', leaseOwner: this.workerId, leaseUntil: { gt: new Date() } };
  }

  private async hasLease(taskId: string): Promise<boolean> {
    const task = await this.prisma.task.findUnique({ where: { id: taskId }, select: { status: true, leaseOwner: true, leaseUntil: true } });
    return !!task && task.status === 'RUNNING' && task.leaseOwner === this.workerId && !!task.leaseUntil && task.leaseUntil > new Date();
  }

  private parseDetail(value: Prisma.JsonValue | null): PurgeDetail {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const fileIds = purgeFileIds(source.fileIds);
    if (!fileIds.length) throw new BadRequestException('此任务缺少可执行的文件清单，请回到回收站重新选择文件并彻底删除。');
    if (typeof source.actorId !== 'string' || !source.actorId) throw new BadRequestException('删除任务缺少执行用户，请回到回收站重新选择文件。');
    const count = (key: string): number => Number.isSafeInteger(source[key]) && Number(source[key]) >= 0 ? Number(source[key]) : 0;
    const nextIndex = count('nextIndex');
    if (nextIndex > fileIds.length) throw new BadRequestException('删除任务进度无效，请回到回收站重新选择文件。');
    const failures = Array.isArray(source.failures) ? source.failures as PurgeFailure[] : [];
    return { fileIds, actorId: source.actorId, nextIndex, deleted: count('deleted'), alreadyAbsent: count('alreadyAbsent'),
      failedFileIds: purgeFileIds(source.failedFileIds), failures, batchSize: Math.min(100, Math.max(1, count('batchSize') || 20)),
      ...(typeof source.retriedFromTaskId === 'string' ? { retriedFromTaskId: source.retriedFromTaskId } : {}) };
  }

  private errorMessage(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 1000); }
}
