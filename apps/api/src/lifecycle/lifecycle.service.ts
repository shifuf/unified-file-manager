import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, FileCategory, FileStatus } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../common/types/request-user.type';
import { folderPathKey, isUnderFolder } from '../common/utils/folder-path.util';
import { DOMAIN_EVENTS } from '../events/domain-events';
import { EventBusService } from '../events/event-bus.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectAccessService } from '../projects/project-access.service';

@Injectable()
export class LifecycleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projectAccessService: ProjectAccessService,
    private readonly auditService: AuditService,
    private readonly eventBus: EventBusService,
  ) {}

  async list(projectId: string, user: RequestUser) {
    await this.projectAccessService.assertProjectAccess(user, projectId, true);
    return this.prisma.lifecyclePolicy.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async create(
    projectId: string,
    dto: {
      name: string;
      folderPath?: string | null;
      category?: FileCategory | null;
      ttlDays: number;
      action: 'RECYCLE' | 'PURGE';
      enabled?: boolean;
    },
    user: RequestUser,
  ) {
    await this.projectAccessService.assertProjectAccess(user, projectId, true);
    if (!dto.name?.trim()) {
      throw new BadRequestException('名称不能为空。');
    }
    if (!Number.isFinite(dto.ttlDays) || dto.ttlDays < 1) {
      throw new BadRequestException('ttlDays 必须 >= 1。');
    }
    if (dto.action !== 'RECYCLE' && dto.action !== 'PURGE') {
      throw new BadRequestException('action 仅支持 RECYCLE / PURGE。');
    }
    return this.prisma.lifecyclePolicy.create({
      data: {
        projectId,
        name: dto.name.trim(),
        folderPath: folderPathKey(dto.folderPath) || null,
        category: dto.category ?? null,
        ttlDays: dto.ttlDays,
        action: dto.action,
        enabled: dto.enabled ?? true,
      },
    });
  }

  async remove(projectId: string, policyId: string, user: RequestUser) {
    await this.projectAccessService.assertProjectAccess(user, projectId, true);
    const existing = await this.prisma.lifecyclePolicy.findFirst({
      where: { id: policyId, projectId },
    });
    if (!existing) {
      throw new NotFoundException('策略不存在。');
    }
    await this.prisma.lifecyclePolicy.delete({ where: { id: policyId } });
    return { success: true };
  }

  async run(projectId: string, policyId: string, user: RequestUser) {
    await this.projectAccessService.assertProjectAccess(user, projectId, true);
    const policy = await this.prisma.lifecyclePolicy.findFirst({
      where: { id: policyId, projectId, enabled: true },
    });
    if (!policy) {
      throw new NotFoundException('策略不存在或未启用。');
    }
    const result = await this.executePolicy(policy);
    await this.auditService.write({
      action: AuditAction.LIFECYCLE_RUN,
      actorId: user.id,
      projectId,
      detail: { policyId, ...result },
    });
    return result;
  }

  async runDuePolicies(): Promise<{ policies: number; affected: number }> {
    const policies = await this.prisma.lifecyclePolicy.findMany({
      where: { enabled: true },
    });
    let affected = 0;
    for (const policy of policies) {
      const result = await this.executePolicy(policy);
      affected += result.affected;
    }
    return { policies: policies.length, affected };
  }

  private async executePolicy(policy: {
    id: string;
    projectId: string;
    folderPath: string | null;
    category: FileCategory | null;
    ttlDays: number;
    action: string;
  }): Promise<{ affected: number }> {
    const cutoff = new Date(Date.now() - policy.ttlDays * 24 * 60 * 60 * 1000);
    const files = await this.prisma.managedFile.findMany({
      where: {
        projectId: policy.projectId,
        status: FileStatus.ACTIVE,
        createdAt: { lt: cutoff },
        ...(policy.category ? { category: policy.category } : {}),
      },
      take: 500,
    });

    const matched = files.filter((file) =>
      policy.folderPath == null || policy.folderPath === ''
        ? true
        : isUnderFolder(file.folderPath, policy.folderPath),
    );

    const now = new Date();
    for (const file of matched) {
      if (policy.action === 'PURGE') {
        // Soft-mark for immediate purge by maintenance; avoid hard storage delete here.
        await this.prisma.managedFile.update({
          where: { id: file.id },
          data: {
            status: FileStatus.RECYCLED,
            deletedAt: now,
            purgeAt: now,
          },
        });
      } else {
        await this.prisma.managedFile.update({
          where: { id: file.id },
          data: {
            status: FileStatus.RECYCLED,
            deletedAt: now,
            purgeAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
          },
        });
      }
      this.eventBus.emit(DOMAIN_EVENTS.FILE_DELETED, {
        projectId: file.projectId,
        fileId: file.id,
        originalName: file.originalName,
      });
    }

    await this.prisma.lifecyclePolicy.update({
      where: { id: policy.id },
      data: { lastRunAt: new Date() },
    });

    return { affected: matched.length };
  }
}
