import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditAction } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { WebdavAccountService } from './webdav-account.service';
import { UpdateWebdavSettingsDto } from './dto/webdav-settings.dto';

/** Persists per-project WebDAV settings (enable flag + credentials). */
@Injectable()
export class WebdavSettingsService {
  constructor(
    private readonly accountService: WebdavAccountService,
    private readonly auditService: AuditService,
    private readonly prisma: PrismaService,
  ) {}

  async get(projectId: string): Promise<Record<string, unknown>> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, deletedAt: null },
      select: { webdavEnabled: true, webdavUsername: true, webdavPasswordHash: true },
    });

    if (!project) {
      throw new NotFoundException('项目不存在。');
    }

    return {
      projectId,
      enabled: Boolean(project.webdavEnabled),
      username: project.webdavUsername ?? null,
      hasPassword: Boolean(project.webdavPasswordHash),
      baseUrl: this.accountService.mountUrl(projectId),
    };
  }

  async update(
    projectId: string,
    dto: UpdateWebdavSettingsDto,
    actorId: string,
  ): Promise<Record<string, unknown>> {
    const existing = await this.prisma.project.findFirst({
      where: { id: projectId, deletedAt: null },
      select: { webdavUsername: true, webdavPasswordHash: true },
    });

    if (!existing) {
      throw new NotFoundException('项目不存在。');
    }

    const username = dto.username === undefined ? existing.webdavUsername : dto.username?.trim() || null;
    const passwordChanged = dto.password !== undefined && dto.password !== null;
    const passwordHash = passwordChanged
      ? await this.accountService.hashPassword(dto.password as string)
      : existing.webdavPasswordHash;

    if (dto.enabled === true) {
      if (!username) {
        throw new BadRequestException('启用 WebDAV 前必须设置用户名。');
      }
      if (!passwordHash) {
        throw new BadRequestException('启用 WebDAV 前必须设置密码。');
      }
    }

    const updated = await this.prisma.project.update({
      where: { id: projectId },
      data: {
        webdavEnabled: dto.enabled ?? undefined,
        webdavUsername: username,
        webdavPasswordHash: passwordHash,
        ...(passwordChanged ? { webdavPasswordVault: this.accountService.vaultPassword(dto.password as string) } : {}),
      },
      select: { webdavEnabled: true, webdavUsername: true, webdavPasswordHash: true },
    });

    await this.auditService.write({
      action: AuditAction.PROJECT_UPDATE,
      actorId,
      projectId,
      detail: {
        webdavEnabled: updated.webdavEnabled,
        webdavUsername: updated.webdavUsername,
        webdavPasswordChanged: passwordChanged,
      },
    });

    return {
      projectId,
      enabled: Boolean(updated.webdavEnabled),
      username: updated.webdavUsername,
      hasPassword: Boolean(updated.webdavPasswordHash),
      baseUrl: this.accountService.mountUrl(projectId),
    };
  }
}
