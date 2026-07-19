import { randomBytes } from 'node:crypto';

import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, FileStatus, type Prisma } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

import { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../common/types/request-user.type';
import { InMemoryAttemptLimiter } from '../common/utils/in-memory-attempt-limiter';
import { folderPathKey, isUnderFolder } from '../common/utils/folder-path.util';
import { isIpAllowed, sanitizeIpAllowlist } from '../common/utils/ip-allowlist.util';
import { resolvePublicBaseUrl } from '../common/utils/origin.util';
import { ConfigService } from '@nestjs/config';
import { DOMAIN_EVENTS } from '../events/domain-events';
import { EventBusService } from '../events/event-bus.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectAccessService } from '../projects/project-access.service';
import { SettingsService } from '../settings/settings.service';
import { CreateShareLinkDto } from './dto/create-share-link.dto';
import { ShareIpAbuseService } from './share-ip-abuse.service';
import { StorageService } from '../storage/storage.service';

@Injectable()
export class FolderShareService {
  private readonly downloadRateLimiter = new InMemoryAttemptLimiter({
    maxAttempts: 5,
    windowMs: 60 * 1000,
    lockMs: 10 * 60 * 1000,
    maxKeys: 20_000,
  });

  constructor(
    private readonly prisma: PrismaService,
    private readonly projectAccessService: ProjectAccessService,
    private readonly auditService: AuditService,
    private readonly configService: ConfigService,
    private readonly settingsService: SettingsService,
    private readonly storageService: StorageService,
    private readonly eventBus: EventBusService,
    private readonly shareIpAbuseService: ShareIpAbuseService,
  ) {}

  async create(
    projectId: string,
    folderPathRaw: string | null | undefined,
    dto: CreateShareLinkDto,
    user: RequestUser,
    publicBaseUrl?: string,
  ) {
    await this.projectAccessService.assertProjectAccess(user, projectId, true);
    const folderPath = folderPathKey(folderPathRaw);
    const token = randomBytes(24).toString('hex');
    const share = await this.prisma.folderShareLink.create({
      data: {
        projectId,
        folderPath,
        token,
        passwordHash: dto.password ? await bcrypt.hash(dto.password, 10) : null,
        expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
        maxDownloads: dto.maxDownloads ?? null,
        previewOnly: dto.previewOnly ?? false,
        allowedIps: sanitizeIpAllowlist(dto.allowedIps ?? []),
        watermarkText: dto.watermarkText?.trim() || null,
      },
      include: { project: { select: { id: true, name: true } } },
    });

    await this.auditService.write({
      action: AuditAction.FOLDER_SHARE_CREATE,
      actorId: user.id,
      projectId,
      detail: { shareId: share.id, folderPath, expiresAt: dto.expiresAt },
    });

    return this.toResponse(share, publicBaseUrl);
  }

  async list(projectId: string, user: RequestUser, publicBaseUrl?: string) {
    await this.projectAccessService.assertProjectAccess(user, projectId);
    const rows = await this.prisma.folderShareLink.findMany({
      where: { projectId },
      include: { project: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((row) => this.toResponse(row, publicBaseUrl));
  }

  async disable(shareId: string, user: RequestUser) {
    const share = await this.prisma.folderShareLink.findUnique({ where: { id: shareId } });
    if (!share) {
      throw new NotFoundException('目录分享不存在。');
    }
    await this.projectAccessService.assertProjectAccess(user, share.projectId, true);
    await this.prisma.folderShareLink.update({
      where: { id: shareId },
      data: { enabled: false },
    });
    await this.auditService.write({
      action: AuditAction.FOLDER_SHARE_DELETE,
      actorId: user.id,
      projectId: share.projectId,
      detail: { shareId },
    });
    return { success: true };
  }

  async getPublicInfo(token: string) {
    const share = await this.requireShare(token);
    const brand = await this.settingsService.getSharePageBrand();
    return {
      token: share.token,
      folderPath: share.folderPath || '/',
      projectName: share.project.name,
      hasPassword: Boolean(share.passwordHash),
      previewOnly: share.previewOnly,
      expiresAt: share.expiresAt,
      enabled: share.enabled,
      status: this.computeStatus(share),
      brand,
    };
  }

  async listPublicFiles(
    token: string,
    password: string | undefined,
    options: { page?: number; pageSize?: number; keyword?: string; ip?: string },
  ) {
    const share = await this.requireShare(token);
    await this.assertAccess(share, password, options.ip);
    const page = Math.max(1, Number(options.page ?? 1) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(options.pageSize ?? 20) || 20));
    const keyword = options.keyword?.trim();
    const folderPath = share.folderPath;

    const where: Prisma.ManagedFileWhereInput = {
      projectId: share.projectId,
      status: FileStatus.ACTIVE,

      ...(folderPath
        ? {
            OR: [{ folderPath }, { folderPath: { startsWith: `${folderPath}/` } }],
          }
        : {}),
      ...(keyword
        ? {
            OR: [
              { originalName: { contains: keyword } },
              { remark: { contains: keyword } },
              { tags: { contains: keyword } },
            ],
          }
        : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.managedFile.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          originalName: true,
          size: true,
          category: true,
          mimeType: true,
          extension: true,
          folderPath: true,
          thumbnailUrl: true,
          createdAt: true,
        },
      }),
      this.prisma.managedFile.count({ where }),
    ]);

    return {
      items: items.map((item) => ({
        ...item,
        size: Number(item.size),
        folderPath: item.folderPath || '/',
      })),
      total,
      page,
      pageSize,
      previewOnly: share.previewOnly,
    };
  }

  async getFileDownloadTarget(
    token: string,
    fileId: string,
    password: string | undefined,
    meta: {
      ip?: string;
      allowPreviewOnly?: boolean;
      range?: { start?: number; end?: number };
      /** Skip rate-limit + downloadCount (e.g. Range re-fetch after first counted hit). */
      skipCount?: boolean;
    },
  ) {
    const share = await this.requireShare(token);
    await this.assertAccess(share, password, meta.ip);

    if (share.previewOnly && !meta.allowPreviewOnly) {
      throw new ForbiddenException('该目录分享仅允许预览。');
    }

    if (share.maxDownloads !== null && share.downloadCount >= share.maxDownloads) {
      throw new ForbiddenException('下载次数已用尽。');
    }

    const file = await this.prisma.managedFile.findFirst({
      where: {
        id: fileId,
        projectId: share.projectId,
        status: FileStatus.ACTIVE,
      },
      include: { cdnConfig: true },
    });
    if (!file) {
      throw new NotFoundException('文件不存在。');
    }
    if (!isUnderFolder(file.folderPath, share.folderPath)) {
      throw new ForbiddenException('文件不在该分享目录下。');
    }

    if (!meta.allowPreviewOnly && !meta.skipCount) {
      const ip = (meta.ip || 'unknown').trim().replace(/^::ffff:/i, '') || 'unknown';
      await this.shareIpAbuseService.assertNotBanned(ip);
      const rateKey = `share-dl:${ip}`;
      this.downloadRateLimiter.assertAllowed(
        rateKey,
        '下载过于频繁，已临时限制访问（同一 IP 每分钟最多 5 次）',
      );
      const newlyLocked = this.downloadRateLimiter.recordAttempt(rateKey);
      await this.shareIpAbuseService.recordDownload(ip, {
        shareId: share.id,
        originalName: file.originalName,
      });
      if (newlyLocked) {
        await this.shareIpAbuseService.recordRateLimited(ip, {
          shareId: share.id,
          originalName: file.originalName,
          autoBanMinutes: 10,
        });
        this.eventBus.emit(DOMAIN_EVENTS.SHARE_DOWNLOAD_RATE_LIMITED, {
          projectId: share.projectId,
          fileId: file.id,
          shareId: share.id,
          originalName: file.originalName,
          ip,
          limit: 5,
          windowSeconds: 60,
          kind: 'folder-share',
        });
      }

      await this.prisma.folderShareLink.update({
        where: { id: share.id },
        data: { downloadCount: { increment: 1 } },
      });
      await this.auditService.write({
        action: AuditAction.FOLDER_SHARE_DOWNLOAD,
        projectId: share.projectId,
        detail: { shareId: share.id, fileId },
      });
    }

    return {
      file,
      // Force stream via API so each download hit is subject to IP rate limits (no CDN 302 bypass).
      target: await this.storageService.getDownloadTarget(file, 120, meta.range, {
        preferRedirect: false,
      }),
      watermarkText: share.watermarkText,
    };
  }

  private async requireShare(token: string) {
    const share = await this.prisma.folderShareLink.findUnique({
      where: { token },
      include: { project: { select: { id: true, name: true, enabled: true, deletedAt: true } } },
    });
    if (!share || !share.project.enabled || share.project.deletedAt) {
      throw new NotFoundException('目录分享不存在。');
    }
    if (!share.enabled) {
      throw new ForbiddenException('目录分享已停用。');
    }
    if (share.expiresAt && share.expiresAt.getTime() <= Date.now()) {
      throw new ForbiddenException('目录分享已过期。');
    }
    return share;
  }

  private async assertAccess(
    share: {
      passwordHash: string | null;
      allowedIps: Prisma.JsonValue;
    },
    password: string | undefined,
    ip?: string,
  ) {
    if (share.passwordHash) {
      const ok = password ? await bcrypt.compare(password, share.passwordHash) : false;
      if (!ok) {
        throw new ForbiddenException('分享密码错误。');
      }
    }
    const allowlist = Array.isArray(share.allowedIps) ? (share.allowedIps as string[]) : [];
    if (allowlist.length > 0 && !isIpAllowed(ip, allowlist)) {
      throw new ForbiddenException('当前 IP 无权访问该分享。');
    }
  }

  private computeStatus(share: {
    enabled: boolean;
    expiresAt: Date | null;
    maxDownloads: number | null;
    downloadCount: number;
  }) {
    if (!share.enabled) return 'DISABLED';
    if (share.expiresAt && share.expiresAt.getTime() <= Date.now()) return 'EXPIRED';
    if (share.maxDownloads !== null && share.downloadCount >= share.maxDownloads) return 'EXHAUSTED';
    return 'ACTIVE';
  }

  private toResponse(
    share: {
      id: string;
      projectId: string;
      folderPath: string;
      token: string;
      passwordHash: string | null;
      expiresAt: Date | null;
      maxDownloads: number | null;
      downloadCount: number;
      enabled: boolean;
      previewOnly: boolean;
      allowedIps: Prisma.JsonValue;
      watermarkText: string | null;
      createdAt: Date;
      updatedAt: Date;
      project?: { id: string; name: string } | null;
    },
    publicBaseUrl?: string,
  ) {
    const webPublicUrl = resolvePublicBaseUrl(publicBaseUrl, this.configService.get<string>('PUBLIC_URL'));
    const path = `/folder-shares/${share.token}`;
    return {
      id: share.id,
      kind: 'folder',
      projectId: share.projectId,
      projectName: share.project?.name ?? null,
      folderPath: share.folderPath || '/',
      token: share.token,
      url: webPublicUrl ? `${webPublicUrl}${path}` : path,
      hasPassword: Boolean(share.passwordHash),
      expiresAt: share.expiresAt,
      maxDownloads: share.maxDownloads,
      downloadCount: share.downloadCount,
      remainingDownloads:
        share.maxDownloads === null ? null : Math.max(0, share.maxDownloads - share.downloadCount),
      enabled: share.enabled,
      previewOnly: share.previewOnly,
      allowedIps: Array.isArray(share.allowedIps) ? share.allowedIps : [],
      watermarkText: share.watermarkText,
      status: this.computeStatus(share),
      createdAt: share.createdAt,
      updatedAt: share.updatedAt,
    };
  }
}
