import { randomUUID } from 'node:crypto';

import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { StorageService, type StorageFileInput } from '../storage/storage.service';
import { recordMigrationAttempt, type MigrationProgress } from '../storage/storage-migration.util';

type MigrationDetail = MigrationProgress & {
  sourceConfigId: string;
  targetConfigId: string;
  batchSize?: number;
  total?: number;
  retryFileIds?: string[];
  retryIndex?: number;
  trigger?: string;
};

@Injectable()
export class StorageMigrationWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StorageMigrationWorker.name);
  private readonly workerId = randomUUID();
  private timer?: NodeJS.Timeout;
  private busy = false;
  private stopped = false;

  constructor(private readonly prisma: PrismaService, private readonly storage: StorageService) {}

  onModuleInit(): void {
    void this.runLoop();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private async runLoop(): Promise<void> {
    if (this.stopped) return;
    if (!this.busy) {
      this.busy = true;
      try {
        await this.runOneBatch();
      } catch (error) {
        this.logger.error(`存储迁移批次异常：${error instanceof Error ? error.stack || error.message : String(error)}`);
      } finally {
        this.busy = false;
      }
    }
    if (!this.stopped) this.timer = setTimeout(() => void this.runLoop(), 3000);
  }

  private async runOneBatch(): Promise<void> {
    const now = new Date();
    const candidate = await this.prisma.task.findFirst({
      where: {
        type: 'STORAGE_MIGRATION',
        status: 'RUNNING',
        OR: [{ leaseOwner: this.workerId }, { leaseUntil: null }, { leaseUntil: { lt: now } }],
      },
      orderBy: { createdAt: 'asc' },
    });
    if (!candidate) return;
    const claim = await this.prisma.task.updateMany({
      where: {
        id: candidate.id,
        status: 'RUNNING',
        OR: [{ leaseOwner: this.workerId }, { leaseUntil: null }, { leaseUntil: { lt: now } }],
      },
      data: { leaseOwner: this.workerId, leaseUntil: new Date(Date.now() + 5 * 60_000) },
    });
    if (claim.count !== 1) return;

    const task = await this.prisma.task.findUnique({ where: { id: candidate.id } });
    if (!task || task.status !== 'RUNNING') return;
    const detail = this.parseDetail(task.detail);
    if (!detail.sourceConfigId || !detail.targetConfigId) {
      await this.prisma.task.updateMany({
        where: { id: task.id, status: 'RUNNING', leaseOwner: this.workerId },
        data: { status: 'FAILED', error: '迁移任务缺少有效的来源或目标存储配置，请重新创建迁移任务。',
          finishedAt: new Date(), leaseOwner: null, leaseUntil: null },
      });
      return;
    }
    const batchSize = Math.min(100, Math.max(1, detail.batchSize ?? 20));
    const retryIds = detail.retryFileIds;
    const files = retryIds
      ? await this.prisma.managedFile.findMany({
          where: { id: { in: retryIds.slice(detail.retryIndex ?? 0, (detail.retryIndex ?? 0) + batchSize) }, projectId: task.projectId ?? undefined },
          include: { cdnConfig: true },
          orderBy: { id: 'asc' },
        })
      : await this.prisma.managedFile.findMany({
          where: {
            projectId: task.projectId ?? undefined,
            cdnConfigId: detail.sourceConfigId,
            deletedAt: null,
            ...(detail.cursor ? { id: { gt: detail.cursor } } : {}),
          },
          include: { cdnConfig: true },
          orderBy: { id: 'asc' },
          take: batchSize,
        });

    if (detail.total === undefined && !retryIds) {
      detail.total = await this.prisma.managedFile.count({
        where: { projectId: task.projectId ?? undefined, cdnConfigId: detail.sourceConfigId, deletedAt: null },
      });
    }

    // Retry checkpoints count requested IDs, not returned DB rows. An absent
    // record is an idempotent skip, not evidence that later IDs are finished.
    const attempts = retryIds
      ? retryIds.slice(detail.retryIndex ?? 0, (detail.retryIndex ?? 0) + batchSize)
        .map(fileId => ({ fileId, file: files.find(file => file.id === fileId) }))
      : files.map(file => ({ fileId: file.id, file }));
    if (attempts.length === 0) {
      await this.finish(task.id, detail);
      return;
    }

    for (const { fileId, file } of attempts) {
      const latestTask = await this.prisma.task.findUnique({ where: { id: task.id }, select: { status: true, leaseOwner: true } });
      if (!latestTask || latestTask.status !== 'RUNNING' || latestTask.leaseOwner !== this.workerId) return;
      const base = this.progressOnly(detail);
      let outcome: 'migrated' | 'skipped' | 'failed' = 'failed';
      let errorMessage: string | undefined;
      try {
        if (!file || file.cdnConfigId !== detail.sourceConfigId) {
          outcome = 'skipped';
        } else {
          if (!file.cdnConfig) throw new Error('来源存储配置不可用，文件尚未迁移。');
          const fileInput: StorageFileInput = {
            id: file.id,
            projectId: file.projectId,
            storageKey: file.storageKey,
            mimeType: file.mimeType,
            originalName: file.originalName,
            size: file.size,
            cdnConfigId: file.cdnConfigId,
            cdnConfig: file.cdnConfig,
          };
          await this.storage.copyToConfig(fileInput, detail.targetConfigId);
          const changed = await this.prisma.managedFile.updateMany({
            where: { id: file.id, cdnConfigId: detail.sourceConfigId },
            data: { cdnConfigId: detail.targetConfigId },
          });
          outcome = changed.count === 1 ? 'migrated' : 'skipped';
        }
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : String(error);
      }
      const next = recordMigrationAttempt(base, {
        fileId,
        fileName: file?.originalName,
        outcome,
        error: errorMessage,
      });
      Object.assign(detail, next);
      if (retryIds) detail.retryIndex = (detail.retryIndex ?? 0) + 1;
      await this.saveProgress(task.id, detail, task.projectId);
    }

    if (retryIds && (detail.retryIndex ?? 0) >= retryIds.length) {
      await this.finish(task.id, detail);
    }
  }

  private async saveProgress(taskId: string, detail: MigrationDetail, projectId: string | null): Promise<void> {
    const progress = detail.total && detail.total > 0 ? Math.min(99, Math.floor((detail.scanned / detail.total) * 100)) : 0;
    await this.prisma.task.updateMany({
      where: { id: taskId, status: 'RUNNING', leaseOwner: this.workerId },
      data: {
        progress,
        detail: detail as unknown as Prisma.InputJsonObject,
        leaseUntil: new Date(Date.now() + 5 * 60_000),
      },
    });
    void projectId;
  }

  private async finish(taskId: string, detail: MigrationDetail): Promise<void> {
    const hasFailures = detail.failed > 0;
    await this.prisma.task.updateMany({
      where: { id: taskId, status: 'RUNNING', leaseOwner: this.workerId },
      data: {
        status: hasFailures ? 'FAILED' : 'COMPLETED',
        progress: hasFailures ? 100 : 100,
        detail: detail as unknown as Prisma.InputJsonObject,
        error: hasFailures ? `${detail.failed} 个文件迁移失败；可在任务中心重试。` : null,
        finishedAt: new Date(),
        leaseOwner: null,
        leaseUntil: null,
      },
    });
  }

  private parseDetail(value: Prisma.JsonValue | null): MigrationDetail {
    const source = value && !Array.isArray(value) && typeof value === 'object' ? value as Record<string, unknown> : {};
    return {
      sourceConfigId: String(source.sourceConfigId ?? ''),
      targetConfigId: String(source.targetConfigId ?? ''),
      cursor: String(source.cursor ?? ''),
      scanned: Number(source.scanned ?? 0),
      migrated: Number(source.migrated ?? 0),
      skipped: Number(source.skipped ?? 0),
      failed: Number(source.failed ?? 0),
      failures: Array.isArray(source.failures) ? source.failures as MigrationProgress['failures'] : [],
      batchSize: Number(source.batchSize ?? 20),
      total: source.total == null ? undefined : Number(source.total),
      retryFileIds: Array.isArray(source.retryFileIds) ? source.retryFileIds.map(String) : undefined,
      retryIndex: Number(source.retryIndex ?? 0),
      trigger: typeof source.trigger === 'string' ? source.trigger : undefined,
    };
  }

  private progressOnly(detail: MigrationDetail): MigrationProgress {
    return {
      cursor: detail.cursor,
      scanned: detail.scanned,
      migrated: detail.migrated,
      skipped: detail.skipped,
      failed: detail.failed,
      failures: detail.failures,
    };
  }
}
