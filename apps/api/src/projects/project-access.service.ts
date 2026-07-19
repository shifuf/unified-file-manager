import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { UserRole } from '@prisma/client';

import type { RequestUser } from '../common/types/request-user.type';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Project access gate for the single super-admin console.
 * Only SUPER_ADMIN sessions may use management APIs.
 */
@Injectable()
export class ProjectAccessService {
  constructor(private readonly prisma: PrismaService) {}

  async assertProjectAccess(user: RequestUser, projectId: string, _requireAdmin = false): Promise<void> {
    if (user.role !== UserRole.SUPER_ADMIN) {
      throw new ForbiddenException('仅超级管理员可访问管理接口。');
    }

    const project = await this.prisma.project.findFirst({
      where: { id: projectId, deletedAt: null, enabled: true },
      select: { id: true },
    });

    if (!project) {
      throw new NotFoundException('项目不存在或已停用。');
    }
  }
}
