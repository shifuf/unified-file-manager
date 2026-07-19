import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, FileStatus, type Prisma } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { folderPathKey, isUnderFolder } from '../common/utils/folder-path.util';
import type { RequestUser } from '../common/types/request-user.type';
import { DOMAIN_EVENTS } from '../events/domain-events';
import { EventBusService } from '../events/event-bus.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectAccessService } from '../projects/project-access.service';

@Injectable()
export class FolderPublicService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projectAccessService: ProjectAccessService,
    private readonly auditService: AuditService,
    private readonly eventBus: EventBusService,
  ) {}

  async list(projectId: string, user: RequestUser) {
    await this.projectAccessService.assertProjectAccess(user, projectId);
    const rows = await this.prisma.folderPublicPolicy.findMany({
      where: { projectId },
      orderBy: { folderPath: 'asc' },
    });
    return rows.map((row) => this.toResponse(row));
  }

  async upsert(
    projectId: string,
    dto: { folderPath?: string | null; isPublic: boolean },
    user: RequestUser,
  ) {
    await this.projectAccessService.assertProjectAccess(user, projectId, true);
    const folderPath = folderPathKey(dto.folderPath);
    const row = await this.prisma.folderPublicPolicy.upsert({
      where: { projectId_folderPath: { projectId, folderPath } },
      create: {
        projectId,
        folderPath,
        isPublic: dto.isPublic,
      },
      update: {
        isPublic: dto.isPublic,
      },
    });

    await this.auditService.write({
      action: dto.isPublic ? AuditAction.FOLDER_PUBLIC_SET : AuditAction.FOLDER_PUBLIC_UNSET,
      actorId: user.id,
      projectId,
      detail: { folderPath, isPublic: dto.isPublic },
    });

    return this.toResponse(row);
  }

  async remove(projectId: string, folderPathRaw: string | null | undefined, user: RequestUser) {
    await this.projectAccessService.assertProjectAccess(user, projectId, true);
    const folderPath = folderPathKey(folderPathRaw);
    const existing = await this.prisma.folderPublicPolicy.findUnique({
      where: { projectId_folderPath: { projectId, folderPath } },
    });
    if (!existing) {
      throw new NotFoundException('文件夹公开策略不存在。');
    }
    await this.prisma.folderPublicPolicy.delete({ where: { id: existing.id } });
    await this.auditService.write({
      action: AuditAction.FOLDER_PUBLIC_UNSET,
      actorId: user.id,
      projectId,
      detail: { folderPath, removed: true },
    });
    return { success: true };
  }

  /**
   * Batch set ManagedFile.isPublic for ACTIVE files under folderPath.
   * recursive=true (default): path prefix match; false: exact folder only.
   */
  async batchPublish(
    projectId: string,
    dto: { folderPath?: string | null; isPublic: boolean; recursive?: boolean },
    user: RequestUser,
  ) {
    await this.projectAccessService.assertProjectAccess(user, projectId, true);
    if (typeof dto.isPublic !== 'boolean') {
      throw new BadRequestException('isPublic 必填。');
    }

    const folderPath = folderPathKey(dto.folderPath);
    const recursive = dto.recursive !== false;

    const where: Prisma.ManagedFileWhereInput = {
      projectId,
      status: FileStatus.ACTIVE,
      isPublic: { not: dto.isPublic },
    };

    if (folderPath === '') {
      if (!recursive) {
        where.OR = [{ folderPath: null }, { folderPath: '' }];
      }
      // recursive root: all project files
    } else if (recursive) {
      where.OR = [
        { folderPath },
        { folderPath: { startsWith: `${folderPath}/` } },
      ];
    } else {
      where.folderPath = folderPath;
    }

    const result = await this.prisma.managedFile.updateMany({
      where,
      data: { isPublic: dto.isPublic },
    });

    await this.auditService.write({
      action: AuditAction.FOLDER_BATCH_PUBLISH,
      actorId: user.id,
      projectId,
      detail: {
        folderPath,
        isPublic: dto.isPublic,
        recursive,
        updated: result.count,
      },
    });

    // Summary event only (avoid N emits on large folders).
    if (result.count > 0) {
      this.eventBus.emit(
        dto.isPublic ? DOMAIN_EVENTS.FILE_PUBLISHED : DOMAIN_EVENTS.FILE_UNPUBLISHED,
        {
          projectId,
          fileId: '',
          originalName: `batch:${folderPath || '/'}`,
          actorId: user.id,
        },
      );
    }

    return { success: true, updated: result.count, folderPath, isPublic: dto.isPublic };
  }

  /** Whether a file path is covered by an active public folder policy. */
  async isPublicByFolderPolicy(projectId: string, fileFolderPath?: string | null): Promise<boolean> {
    const policies = await this.prisma.folderPublicPolicy.findMany({
      where: { projectId, isPublic: true },
      select: { folderPath: true, isPublic: true },
    });
    if (policies.length === 0) {
      return false;
    }
    return policies.some((policy) => isUnderFolder(fileFolderPath, policy.folderPath));
  }

  private toResponse(row: {
    id: string;
    projectId: string;
    folderPath: string;
    isPublic: boolean;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: row.id,
      projectId: row.projectId,
      folderPath: row.folderPath,
      isPublic: row.isPublic,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
