import { Injectable, NotFoundException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import {
  AuditAction,
  CdnProvider,
  FileCategory,
  FileStatus,
  UserRole,
  type Prisma,
} from '@prisma/client';
import * as bcrypt from 'bcryptjs';

import { AuditService } from '../audit/audit.service';
import { APP_ID_PREFIX, APP_SECRET_PREFIX, PASSWORD_SALT_ROUNDS } from '../common/constants';
import type { RequestUser } from '../common/types/request-user.type';
import { normalizeDomainAllowlist } from '../common/utils/domain-allowlist.util';
import { encryptText, randomToken } from '../common/utils/crypto.util';
import { getAppCryptoKey } from '../common/utils/security-config.util';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { CreateProjectSecretDto } from './dto/create-project-secret.dto';
import { CreateProjectDto } from './dto/create-project.dto';
import { ListProjectsDto } from './dto/list-projects.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { ProjectAccessService } from './project-access.service';

@Injectable()
export class ProjectsService {
  constructor(
    private readonly auditService: AuditService,
    private readonly configService: ConfigService,
    private readonly moduleRef: ModuleRef,
    private readonly projectAccessService: ProjectAccessService,
    private readonly prisma: PrismaService,
  ) {}

  async create(dto: CreateProjectDto, user: RequestUser): Promise<Record<string, unknown>> {
    const appId = randomToken(APP_ID_PREFIX, 12);
    const appSecret = randomToken(APP_SECRET_PREFIX, 32);
    const appSecretHash = await bcrypt.hash(appSecret, PASSWORD_SALT_ROUNDS);
    const cryptoKey = getAppCryptoKey(this.configService);
    const defaultStorageConfigId = await this.ensureDefaultLocalStorageConfig();

    const project = await this.prisma.project.create({
      data: {
        name: dto.name,
        description: dto.description,
        allowedDomains: normalizeDomainAllowlist(dto.allowedDomains) as Prisma.InputJsonValue,
        activeCdnConfigId: defaultStorageConfigId,
        appId,
        appSecretHash,
        appSecretVault: encryptText(appSecret, cryptoKey),
        notifyEnabled: dto.notifyEnabled ?? true,
        publicLibraryEnabled: dto.publicLibraryEnabled ?? false,
        publicLibrarySlug: dto.publicLibrarySlug?.trim() || null,
        quotaBytes: dto.quotaBytes == null ? null : BigInt(dto.quotaBytes),
        quotaFiles: dto.quotaFiles ?? null,
        apiSecrets: {
          create: {
            name: '默认密钥',
            secretHash: appSecretHash,
            secretVault: encryptText(appSecret, cryptoKey),
          },
        },
      },
      include: { activeCdnConfig: true },
    });

    await this.auditService.write({
      action: AuditAction.PROJECT_CREATE,
      actorId: user.id,
      projectId: project.id,
      detail: { name: dto.name },
    });

    return {
      ...this.toProjectResponse(project, user),
      appSecret,
      secretNotice: 'AppSecret 仅本次返回，请妥善保存。遗失后只能重置。',
    };
  }

  async list(dto: ListProjectsDto, user: RequestUser): Promise<Record<string, unknown>[]> {
    const projects = await this.prisma.project.findMany({
      where: {
        deletedAt: null,
        ...(dto.keyword ? { name: { contains: dto.keyword } } : {}),
        // Single super-admin sees every project.
      },
      include: {
        activeCdnConfig: true,
        _count: { select: { files: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    return projects.map((project) => this.toProjectResponse(project, user));
  }

  async get(projectId: string, user: RequestUser): Promise<Record<string, unknown>> {
    await this.projectAccessService.assertProjectAccess(user, projectId);
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, deletedAt: null },
      include: {
        activeCdnConfig: true,
        _count: { select: { files: true } },
      },
    });

    if (!project) {
      throw new NotFoundException('项目不存在。');
    }

    return this.toProjectResponse(project, user);
  }

  async update(projectId: string, dto: UpdateProjectDto, user: RequestUser): Promise<Record<string, unknown>> {
    await this.projectAccessService.assertProjectAccess(user, projectId, true);
    const data: Prisma.ProjectUpdateInput = {
      name: dto.name,
      description: dto.description,
      allowedDomains:
        dto.allowedDomains === undefined
          ? undefined
          : (normalizeDomainAllowlist(dto.allowedDomains) as Prisma.InputJsonValue),
      notifyEnabled: dto.notifyEnabled,
      publicLibraryEnabled: dto.publicLibraryEnabled,
      publicLibrarySlug:
        dto.publicLibrarySlug === undefined
          ? undefined
          : dto.publicLibrarySlug?.trim()
            ? dto.publicLibrarySlug.trim()
            : null,
      quotaBytes:
        dto.quotaBytes === undefined
          ? undefined
          : dto.quotaBytes == null
            ? null
            : BigInt(dto.quotaBytes),
      quotaFiles: dto.quotaFiles === undefined ? undefined : dto.quotaFiles,
    };
    const project = await this.prisma.project.update({
      where: { id: projectId },
      data,
      include: {
        activeCdnConfig: true,
        _count: { select: { files: true } },
      },
    });

    await this.auditService.write({
      action: AuditAction.PROJECT_UPDATE,
      actorId: user.id,
      projectId,
      detail: {
        name: dto.name,
        description: dto.description,
        allowedDomains: dto.allowedDomains,
      } as Prisma.InputJsonObject,
    });

    return this.toProjectResponse(project, user);
  }

  async remove(projectId: string, user: RequestUser): Promise<{ success: boolean }> {
    await this.projectAccessService.assertProjectAccess(user, projectId, true);
    const now = new Date();
    const files = await this.prisma.managedFile.findMany({
      where: { projectId, status: { not: FileStatus.DELETED } },
      include: { cdnConfig: true },
    });

    await this.prisma.$transaction([
      this.prisma.project.update({
        where: { id: projectId },
        data: { deletedAt: now, enabled: false },
      }),
      this.prisma.managedFile.updateMany({
        where: { projectId, status: { not: 'DELETED' } },
        data: { status: 'DELETED', deletedAt: now },
      }),
    ]);

    let purged = 0;
    let failed = 0;
    const storageService = this.moduleRef.get(StorageService, { strict: false });
    for (const file of files) {
      if (!file.cdnConfig) {
        continue;
      }

      try {
        await storageService.remove(file.cdnConfig, file.storageKey);
        purged += 1;
      } catch {
        failed += 1;
      }
    }

    await this.prisma.task.create({
      data: {
        projectId,
        type: 'PROJECT_STORAGE_PURGE',
        title: '删除项目后清理存储对象',
        status: failed > 0 ? 'FAILED' : 'COMPLETED',
        progress: 100,
        result: { total: files.length, purged, failed },
        error: failed > 0 ? `${failed} 个存储对象清理失败` : undefined,
        finishedAt: new Date(),
      },
    });

    await this.auditService.write({
      action: AuditAction.PROJECT_DELETE,
      actorId: user.id,
      projectId,
      detail: { totalFiles: files.length, purged, failed },
    });

    return { success: true };
  }

  async resetSecret(projectId: string, user: RequestUser): Promise<{
    appId: string;
    appSecret: string;
    secretNotice: string;
  }> {
    await this.projectAccessService.assertProjectAccess(user, projectId, true);
    const appSecret = randomToken(APP_SECRET_PREFIX, 32);
    const appSecretHash = await bcrypt.hash(appSecret, PASSWORD_SALT_ROUNDS);
    const cryptoKey = getAppCryptoKey(this.configService);
    const appSecretVault = encryptText(appSecret, cryptoKey);
    const project = await this.prisma.$transaction(async (tx) => {
      await tx.projectSecret.updateMany({
        where: { projectId, enabled: true },
        data: { enabled: false },
      });

      const updatedProject = await tx.project.update({
        where: { id: projectId },
        data: {
          appSecretHash,
          appSecretVault,
        },
      });

      await tx.projectSecret.create({
        data: {
          projectId,
          name: '重置密钥',
          secretHash: appSecretHash,
          secretVault: appSecretVault,
        },
      });

      return updatedProject;
    });

    await this.auditService.write({
      action: AuditAction.PROJECT_SECRET_RESET,
      actorId: user.id,
      projectId,
    });

    return {
      appId: project.appId,
      appSecret,
      secretNotice: '新 AppSecret 仅本次返回，旧密钥已立即失效。',
    };
  }

  async getStats(projectId: string, user: RequestUser): Promise<Record<string, unknown>> {
    await this.projectAccessService.assertProjectAccess(user, projectId);
    // Quota-aligned usage: only ACTIVE files count toward usedBytes / fileCount.
    const quotaWhere: Prisma.ManagedFileWhereInput = {
      projectId,
      status: FileStatus.ACTIVE,
    };
    // Broader view (non-deleted) for category/provider breakdowns still excludes purged rows.
    const nonDeletedWhere: Prisma.ManagedFileWhereInput = {
      projectId,
      status: { not: FileStatus.DELETED },
    };
    const [sizeStats, statusGroups, categoryGroups, providerRows, shareLinkCount, activeSecretCount, project, dailyUploads, topFilesBySize] =
      await Promise.all([
        this.prisma.managedFile.aggregate({
          where: quotaWhere,
          _count: { _all: true },
          _sum: { size: true },
        }),
        this.prisma.managedFile.groupBy({
          by: ['status'],
          where: { projectId },
          _count: { _all: true },
        }),
        this.prisma.managedFile.groupBy({
          by: ['category'],
          where: nonDeletedWhere,
          _count: { _all: true },
          _sum: { size: true },
        }),
        this.prisma.managedFile.findMany({
          where: nonDeletedWhere,
          select: {
            folderPath: true,
            duplicateOfId: true,
            size: true,
            cdnConfig: { select: { provider: true } },
          },
        }),
        this.prisma.shareLink.count({
          where: { enabled: true, file: { projectId, status: FileStatus.ACTIVE } },
        }),
        this.prisma.projectSecret.count({ where: { projectId, enabled: true } }),
        this.prisma.project.findFirst({
          where: { id: projectId, deletedAt: null },
          select: { quotaBytes: true, quotaFiles: true, notifyEnabled: true, publicLibraryEnabled: true, publicLibrarySlug: true },
        }),
        this.prisma.managedFile.findMany({
          where: {
            projectId,
            status: FileStatus.ACTIVE,
            createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
          },
          select: { createdAt: true, size: true },
        }),
        this.prisma.managedFile.findMany({
          where: quotaWhere,
          select: {
            id: true,
            originalName: true,
            size: true,
            category: true,
            folderPath: true,
            mimeType: true,
            createdAt: true,
          },
          orderBy: { size: 'desc' },
          take: 10,
        }),
      ]);

    const byProvider = this.countProviderRows(providerRows);
    const byFolder = this.countFolderRows(providerRows);
    const usedBytes = Number(sizeStats._sum.size ?? 0n);
    const usedFiles = sizeStats._count._all;
    const quotaBytes = project?.quotaBytes == null ? null : Number(project.quotaBytes);
    const quotaFiles = project?.quotaFiles ?? null;

    const trendMap = new Map<string, { count: number; size: number }>();
    for (let i = 29; i >= 0; i -= 1) {
      const day = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      trendMap.set(day, { count: 0, size: 0 });
    }
    for (const row of dailyUploads) {
      const day = row.createdAt.toISOString().slice(0, 10);
      const bucket = trendMap.get(day);
      if (bucket) {
        bucket.count += 1;
        bucket.size += Number(row.size);
      }
    }

    return {
      projectId,
      fileCount: usedFiles,
      totalSize: usedBytes,
      usedBytes,
      usedFiles,
      quotaBytes,
      quotaFiles,
      bytesUsagePercent: quotaBytes && quotaBytes > 0 ? Math.min(100, Math.round((usedBytes / quotaBytes) * 1000) / 10) : null,
      filesUsagePercent: quotaFiles && quotaFiles > 0 ? Math.min(100, Math.round((usedFiles / quotaFiles) * 1000) / 10) : null,
      notifyEnabled: project?.notifyEnabled ?? true,
      publicLibraryEnabled: project?.publicLibraryEnabled ?? false,
      publicLibrarySlug: project?.publicLibrarySlug ?? null,
      duplicateCount: providerRows.filter((file) => Boolean(file.duplicateOfId)).length,
      shareLinkCount,
      activeSecretCount,
      byStatus: Object.fromEntries(statusGroups.map((group) => [group.status, group._count._all])),
      byCategory: Object.fromEntries(
        categoryGroups.map((group) => [
          group.category,
          { count: group._count._all, size: Number(group._sum.size ?? 0n) },
        ]),
      ),
      byProvider,
      byFolder,
      uploadTrend: [...trendMap.entries()].map(([date, value]) => ({ date, ...value })),
      topFilesBySize: topFilesBySize.map((file) => ({
        id: file.id,
        originalName: file.originalName,
        size: Number(file.size),
        category: file.category,
        folderPath: file.folderPath,
        mimeType: file.mimeType,
        createdAt: file.createdAt,
      })),
    };
  }

  async exportProject(projectId: string, user: RequestUser): Promise<Record<string, unknown>> {
    await this.projectAccessService.assertProjectAccess(user, projectId, true);
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, deletedAt: null },
      include: {
        activeCdnConfig: true,
        files: {
          where: { status: { not: FileStatus.DELETED } },
          orderBy: { createdAt: 'asc' },
        },
        apiSecrets: {
          orderBy: { createdAt: 'asc' },
          select: { id: true, name: true, enabled: true, lastUsedAt: true, createdAt: true, updatedAt: true },
        },
      },
    });

    if (!project) {
      throw new NotFoundException('项目不存在。');
    }

    await this.auditService.write({
      action: AuditAction.PROJECT_EXPORT,
      actorId: user.id,
      projectId,
      detail: { fileCount: project.files.length },
    });

    return {
      version: 1,
      exportedAt: new Date(),
      project: {
        name: project.name,
        description: project.description,
        appId: project.appId,
        allowedDomains: normalizeDomainAllowlist(project.allowedDomains),
        enabled: project.enabled,
        activeCdnProvider: project.activeCdnConfig?.provider ?? null,
        activeCdnName: project.activeCdnConfig?.name ?? null,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
      },
      apiSecrets: project.apiSecrets,
      files: project.files.map((file) => ({
        originalName: file.originalName,
        storageKey: file.storageKey,
        mimeType: file.mimeType,
        extension: file.extension,
        size: Number(file.size),
        category: file.category,
        status: file.status,
        checksum: file.checksum,
        publicUrl: file.publicUrl,
        remark: file.remark,
        tags: file.tags,
        folderPath: file.folderPath,
        thumbnailUrl: file.thumbnailUrl,
        duplicateOfId: file.duplicateOfId,
        createdAt: file.createdAt,
        updatedAt: file.updatedAt,
        deletedAt: file.deletedAt,
        purgeAt: file.purgeAt,
      })),
    };
  }

  async importProject(payload: unknown, user: RequestUser): Promise<Record<string, unknown>> {
    const source = this.asRecord(payload);
    const sourceProject = this.asRecord(source.project ?? source);
    const name = this.asNonEmptyString(sourceProject.name) ?? `导入项目 ${new Date().toISOString().slice(0, 10)}`;
    const description = this.asNullableString(sourceProject.description) ?? undefined;
    const allowedDomains = normalizeDomainAllowlist(sourceProject.allowedDomains);
    const createdProject = await this.create({ name, description, allowedDomains }, user);
    const projectId = String(createdProject.id);
    const activeProject = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { activeCdnConfigId: true },
    });
    const files = Array.isArray(source.files) ? source.files : [];
    const fileRecords = files
      .map((file) => this.toImportedFileRecord(file, projectId, activeProject?.activeCdnConfigId ?? null))
      .filter((file): file is Prisma.ManagedFileCreateManyInput => Boolean(file));

    if (fileRecords.length > 0) {
      await this.prisma.managedFile.createMany({ data: fileRecords });
    }

    await this.prisma.task.create({
      data: {
        projectId,
        type: 'PROJECT_IMPORT',
        title: '导入项目',
        status: 'COMPLETED',
        progress: 100,
        result: {
          fileRecordsImported: fileRecords.length,
          blobNotice: '导入只恢复文件记录，不复制对象存储中的真实文件内容。',
        },
        finishedAt: new Date(),
      },
    });

    await this.auditService.write({
      action: AuditAction.PROJECT_IMPORT,
      actorId: user.id,
      projectId,
      detail: { fileRecordsImported: fileRecords.length },
    });

    return {
      ...createdProject,
      fileRecordsImported: fileRecords.length,
      importNotice: '文件记录已导入；真实文件内容需要仍存在于对应存储路径。',
    };
  }

  async listProjectSecrets(projectId: string, user: RequestUser): Promise<Record<string, unknown>[]> {
    await this.projectAccessService.assertProjectAccess(user, projectId, true);
    const secrets = await this.prisma.projectSecret.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
    });

    return secrets.map((secret) => this.toProjectSecretResponse(secret));
  }

  async createProjectSecret(
    projectId: string,
    dto: CreateProjectSecretDto,
    user: RequestUser,
  ): Promise<Record<string, unknown>> {
    await this.projectAccessService.assertProjectAccess(user, projectId, true);
    const appSecret = randomToken(APP_SECRET_PREFIX, 32);
    const secretHash = await bcrypt.hash(appSecret, PASSWORD_SALT_ROUNDS);
    const cryptoKey = getAppCryptoKey(this.configService);
    const secret = await this.prisma.projectSecret.create({
      data: {
        projectId,
        name: dto.name?.trim() || '轮换密钥',
        secretHash,
        secretVault: encryptText(appSecret, cryptoKey),
      },
    });

    await this.auditService.write({
      action: AuditAction.PROJECT_SECRET_CREATE,
      actorId: user.id,
      projectId,
      detail: { secretId: secret.id, name: secret.name },
    });

    return {
      ...this.toProjectSecretResponse(secret),
      appSecret,
      secretNotice: 'AppSecret 仅本次返回，请立即保存。',
    };
  }

  async disableProjectSecret(
    projectId: string,
    secretId: string,
    user: RequestUser,
  ): Promise<{ success: boolean }> {
    await this.projectAccessService.assertProjectAccess(user, projectId, true);
    const secret = await this.prisma.projectSecret.findFirst({
      where: { id: secretId, projectId },
    });

    if (!secret) {
      throw new NotFoundException('项目密钥不存在。');
    }

    await this.prisma.projectSecret.update({
      where: { id: secretId },
      data: { enabled: false },
    });
    await this.auditService.write({
      action: AuditAction.PROJECT_SECRET_DISABLE,
      actorId: user.id,
      projectId,
      detail: { secretId },
    });

    return { success: true };
  }

  private toProjectResponse(project: {
    id: string;
    name: string;
    description: string | null;
    appId: string;
    allowedDomains: Prisma.JsonValue | null;
    enabled: boolean;
    notifyEnabled?: boolean;
    publicLibraryEnabled?: boolean;
    publicLibrarySlug?: string | null;
    quotaBytes?: bigint | null;
    quotaFiles?: number | null;
    createdAt: Date;
    updatedAt: Date;
    activeCdnConfig?: { provider: CdnProvider; name: string } | null;
    _count?: { files: number };
  }, user?: RequestUser): Record<string, unknown> {
    const canManage = user?.role === UserRole.SUPER_ADMIN;

    return {
      id: project.id,
      name: project.name,
      description: project.description,
      appId: project.appId,
      allowedDomains: normalizeDomainAllowlist(project.allowedDomains),
      enabled: project.enabled,
      notifyEnabled: project.notifyEnabled ?? true,
      publicLibraryEnabled: project.publicLibraryEnabled ?? false,
      publicLibrarySlug: project.publicLibrarySlug ?? null,
      quotaBytes: project.quotaBytes == null ? null : Number(project.quotaBytes),
      quotaFiles: project.quotaFiles ?? null,
      activeCdnProvider: project.activeCdnConfig?.provider ?? null,
      activeCdnName: project.activeCdnConfig?.name ?? null,
      fileCount: project._count?.files ?? 0,
      canManage,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    };
  }

  private async ensureDefaultLocalStorageConfig(): Promise<string> {
    const defaultConfig = this.defaultLocalStorageConfig();
    const existing = await this.prisma.cdnConfig.findFirst({
      where: { provider: CdnProvider.LOCAL, projectId: null, enabled: true },
      orderBy: { createdAt: 'asc' },
    });

    if (existing) {
      const config = {
        ...this.asRecord(existing.config),
        ...defaultConfig,
      } as Prisma.InputJsonObject;

      await this.prisma.cdnConfig.update({
        where: { id: existing.id },
        data: { config },
      });
      return existing.id;
    }

    const config = await this.prisma.cdnConfig.create({
      data: {
        provider: CdnProvider.LOCAL,
        name: '本地存储',
        active: false,
        config: defaultConfig,
      },
    });

    return config.id;
  }

  private defaultLocalStorageConfig(): Prisma.InputJsonObject {
    return {
      root: this.configService.get<string>('LOCAL_STORAGE_ROOT', './storage'),
      domain: this.configService.get<string>('PUBLIC_URL', ''),
    };
  }

  private countProviderRows(
    rows: Array<{ cdnConfig: { provider: CdnProvider } | null; size: bigint }>,
  ): Record<string, { count: number; size: number }> {
    const result: Record<string, { count: number; size: number }> = {};

    for (const row of rows) {
      const provider = row.cdnConfig?.provider ?? 'UNKNOWN';
      result[provider] ??= { count: 0, size: 0 };
      result[provider].count += 1;
      result[provider].size += Number(row.size);
    }

    return result;
  }

  private countFolderRows(
    rows: Array<{ folderPath: string | null; size: bigint }>,
  ): Record<string, { count: number; size: number }> {
    const result: Record<string, { count: number; size: number }> = {};

    for (const row of rows) {
      const folderPath = row.folderPath || '/';
      result[folderPath] ??= { count: 0, size: 0 };
      result[folderPath].count += 1;
      result[folderPath].size += Number(row.size);
    }

    return result;
  }

  private toProjectSecretResponse(secret: {
    id: string;
    name: string;
    enabled: boolean;
    lastUsedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }): Record<string, unknown> {
    return {
      id: secret.id,
      name: secret.name,
      enabled: secret.enabled,
      lastUsedAt: secret.lastUsedAt,
      createdAt: secret.createdAt,
      updatedAt: secret.updatedAt,
    };
  }

  private toImportedFileRecord(
    value: unknown,
    projectId: string,
    cdnConfigId: string | null,
  ): Prisma.ManagedFileCreateManyInput | null {
    const file = this.asRecord(value);
    const originalName = this.asNonEmptyString(file.originalName);
    const storageKey = this.asNonEmptyString(file.storageKey);
    const mimeType = this.asNonEmptyString(file.mimeType) ?? 'application/octet-stream';

    if (!originalName || !storageKey) {
      return null;
    }

    return {
      projectId,
      cdnConfigId,
      originalName: originalName.slice(0, 255),
      storageKey: storageKey.slice(0, 512),
      mimeType: mimeType.slice(0, 128),
      extension: (this.asNonEmptyString(file.extension) ?? '').slice(0, 32),
      size: BigInt(Math.max(0, Number(file.size) || 0)),
      category: this.asEnumValue(FileCategory, file.category, FileCategory.OTHER),
      status: this.asEnumValue(FileStatus, file.status, FileStatus.ACTIVE),
      checksum: this.asNullableString(file.checksum)?.slice(0, 128) ?? null,
      publicUrl: this.asNullableString(file.publicUrl)?.slice(0, 1024) ?? null,
      remark: this.asNullableString(file.remark)?.slice(0, 512) ?? null,
      tags: this.asNullableString(file.tags)?.slice(0, 512) ?? null,
      folderPath: this.asNullableString(file.folderPath)?.slice(0, 512) ?? null,
      thumbnailUrl: this.asNullableString(file.thumbnailUrl)?.slice(0, 1024) ?? null,
      duplicateOfId: this.asNullableString(file.duplicateOfId) ?? null,
      deletedAt: this.asDate(file.deletedAt),
      purgeAt: this.asDate(file.purgeAt),
    };
  }

  private asRecord(value: unknown): Record<string, unknown> {
    if (!value || Array.isArray(value) || typeof value !== 'object') {
      return {};
    }

    return value as Record<string, unknown>;
  }

  private asNonEmptyString(value: unknown): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }

    const normalized = value.trim();
    return normalized || undefined;
  }

  private asNullableString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  private asDate(value: unknown): Date | null {
    if (typeof value !== 'string' && !(value instanceof Date)) {
      return null;
    }

    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  private asEnumValue<T extends Record<string, string>>(enumObject: T, value: unknown, fallback: T[keyof T]): T[keyof T] {
    return typeof value === 'string' && Object.values(enumObject).includes(value) ? (value as T[keyof T]) : fallback;
  }
}
