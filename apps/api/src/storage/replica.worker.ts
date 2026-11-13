import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';

import { PrismaService } from '../prisma/prisma.service';
import { ReplicaService } from './replica.service';

@Injectable()
export class ReplicaWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReplicaWorker.name);
  private readonly owner = `replica-${randomUUID()}`;
  private running = false;
  private stopped = false;
  private timer?: ReturnType<typeof setInterval>;
  private startupTimer?: ReturnType<typeof setTimeout>;
  constructor(private readonly config: ConfigService, private readonly prisma: PrismaService, private readonly replicas: ReplicaService) {}

  onModuleInit(): void {
    if (this.config.get<string>('REPLICA_WORKER_ENABLED') === 'false') return;
    this.startupTimer = setTimeout(() => { void this.seedProjectsAndRun(); }, 1_000);
    this.startupTimer.unref?.();
    const interval = Math.max(1_000, Number(this.config.get<string>('REPLICA_WORKER_INTERVAL_MS')) || 15_000);
    this.timer = setInterval(() => { void this.runOnce(); }, interval);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.startupTimer) clearTimeout(this.startupTimer);
  }

  private async seedProjectsAndRun(): Promise<void> {
    try {
      let cursor = '';
      do {
        const projects = await this.prisma.project.findMany({ where: { deletedAt: null, enabled: true, ...(cursor ? { id: { gt: cursor } } : {}) },
          orderBy: { id: 'asc' }, take: 100, select: { id: true } });
        for (const project of projects) { if (this.stopped) return; await this.replicas.enqueueProject(project.id); }
        cursor = projects.length === 100 ? projects[projects.length - 1].id : '';
      } while (cursor && !this.stopped);
    } catch { this.logger.warn('初始化副本补齐任务失败，管理界面可重新发起同步。'); }
    await this.runOnce();
  }

  async runOnce(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      await this.replicas.processSyncBatch(this.owner);
      if (!this.stopped) await this.replicas.runBatch(this.owner, Number(this.config.get<string>('REPLICA_WORKER_BATCH_SIZE')) || 10);
    } catch { this.logger.warn('存储副本队列批次失败，将在后续批次重试。'); }
    finally { this.running = false; }
  }
}
