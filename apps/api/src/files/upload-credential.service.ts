import { createHash, randomBytes } from 'node:crypto';

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { AuditAction, type UploadCredential } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../common/types/request-user.type';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectAccessService } from '../projects/project-access.service';
import { StorageService } from '../storage/storage.service';
import { FilesService } from './files.service';

export interface UploadCredentialScope {
  folderPath?: string | null;
  maxBytes?: number | null;
  maxFiles?: number | null;
  allowedMimeTypes?: string[];
}

export interface ValidatedUploadCredential {
  id: string;
  projectId: string;
  name: string;
  scope: UploadCredentialScope;
  maxBytes: bigint | null;
  usedBytes: bigint;
  maxFiles: number | null;
  usedFiles: number;
  expiresAt: Date;
}

@Injectable()
export class UploadCredentialService {
  constructor(
    private readonly auditService: AuditService,
    private readonly filesService: FilesService,
    private readonly prisma: PrismaService,
    private readonly projectAccessService: ProjectAccessService,
    private readonly storageService: StorageService,
  ) {}

  async create(
    projectId: string,
    dto: {
      name: string;
      expiresInSeconds?: number;
      maxBytes?: number | null;
      maxFiles?: number | null;
      folderPath?: string | null;
      allowedMimeTypes?: string[];
    },
    user: RequestUser,
  ): Promise<Record<string, unknown>> {
    await this.projectAccessService.assertProjectAccess(user, projectId, true);

    const name = dto.name.trim();
    if (!name) {
      throw new BadRequestException('凭证名称不能为空。');
    }

    const expiresInSeconds = Math.min(
      90 * 24 * 60 * 60,
      Math.max(60, Number(dto.expiresInSeconds) || 7 * 24 * 60 * 60),
    );
    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);
    const rawToken = `upl_${randomBytes(32).toString('base64url')}`;
    const tokenHash = this.hashToken(rawToken);
    const tokenPrefix = rawToken.slice(0, 12);

    const scope: UploadCredentialScope = {
      folderPath: dto.folderPath?.trim() || null,
      maxBytes: dto.maxBytes ?? null,
      maxFiles: dto.maxFiles ?? null,
      allowedMimeTypes: dto.allowedMimeTypes?.filter(Boolean),
    };

    const credential = await this.prisma.uploadCredential.create({
      data: {
        projectId,
        name,
        tokenHash,
        tokenPrefix,
        scope: scope as object,
        maxBytes: dto.maxBytes === undefined || dto.maxBytes === null ? null : BigInt(dto.maxBytes),
        maxFiles: dto.maxFiles ?? null,
        expiresAt,
        createdById: user.id,
      },
    });

    await this.auditService.write({
      action: AuditAction.UPLOAD_CREDENTIAL_CREATE,
      actorId: user.id,
      projectId,
      detail: { credentialId: credential.id, name, expiresAt },
    });

    return {
      ...this.toResponse(credential),
      token: rawToken,
    };
  }

  async list(projectId: string, user: RequestUser): Promise<Record<string, unknown>[]> {
    await this.projectAccessService.assertProjectAccess(user, projectId, true);
    const items = await this.prisma.uploadCredential.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
    });
    return items.map((item) => this.toResponse(item));
  }

  async revoke(projectId: string, credentialId: string, user: RequestUser): Promise<{ success: boolean }> {
    await this.projectAccessService.assertProjectAccess(user, projectId, true);
    const credential = await this.prisma.uploadCredential.findFirst({
      where: { id: credentialId, projectId },
    });
    if (!credential) {
      throw new NotFoundException('上传凭证不存在。');
    }
    if (credential.revokedAt) {
      return { success: true };
    }

    await this.prisma.uploadCredential.update({
      where: { id: credentialId },
      data: { revokedAt: new Date() },
    });

    await this.auditService.write({
      action: AuditAction.UPLOAD_CREDENTIAL_REVOKE,
      actorId: user.id,
      projectId,
      detail: { credentialId, name: credential.name },
    });

    return { success: true };
  }

  /**
   * Validate `Authorization: Upload <token>` and return the credential.
   * Throws Unauthorized/Forbidden on failure.
   */
  async validateToken(projectId: string, authorizationHeader?: string): Promise<ValidatedUploadCredential> {
    if (!authorizationHeader) {
      throw new UnauthorizedException('缺少上传凭证。');
    }

    const match = authorizationHeader.match(/^Upload\s+(.+)$/i);
    if (!match) {
      throw new UnauthorizedException('上传凭证格式无效，应为 Authorization: Upload <token>。');
    }

    const rawToken = match[1].trim();
    if (!rawToken) {
      throw new UnauthorizedException('上传凭证为空。');
    }

    const tokenHash = this.hashToken(rawToken);
    const credential = await this.prisma.uploadCredential.findFirst({
      where: { tokenHash, projectId },
    });

    if (!credential || credential.revokedAt) {
      throw new UnauthorizedException('上传凭证无效或已撤销。');
    }
    if (credential.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException('上传凭证已过期。');
    }

    return {
      id: credential.id,
      projectId: credential.projectId,
      name: credential.name,
      scope: this.parseScope(credential.scope),
      maxBytes: credential.maxBytes,
      usedBytes: credential.usedBytes,
      maxFiles: credential.maxFiles,
      usedFiles: credential.usedFiles,
      expiresAt: credential.expiresAt,
    };
  }

  async assertWithinQuota(credential: ValidatedUploadCredential, nextBytes: number): Promise<void> {
    if (credential.maxFiles !== null && credential.usedFiles + 1 > credential.maxFiles) {
      throw new ForbiddenException('上传凭证文件数量已达上限。');
    }
    if (credential.maxBytes !== null && credential.usedBytes + BigInt(nextBytes) > credential.maxBytes) {
      throw new ForbiddenException('上传凭证字节配额已达上限。');
    }
  }

  async recordUsage(credentialId: string, bytes: number, files = 1): Promise<void> {
    await this.prisma.uploadCredential.update({
      where: { id: credentialId },
      data: {
        usedBytes: { increment: BigInt(Math.max(0, bytes)) },
        usedFiles: { increment: Math.max(0, files) },
      },
    });
  }

  async createPresign(
    projectId: string,
    dto: {
      fileName: string;
      size: number;
      mimeType?: string;
      folderPath?: string | null;
    },
    user?: RequestUser,
    credential?: ValidatedUploadCredential,
  ): Promise<Record<string, unknown>> {
    if (user) {
      await this.projectAccessService.assertProjectAccess(user, projectId, true);
    } else if (credential) {
      if (credential.projectId !== projectId) {
        throw new ForbiddenException('上传凭证与项目不匹配。');
      }
    } else {
      throw new UnauthorizedException('需要登录或上传凭证。');
    }

    if (!dto.fileName?.trim()) {
      throw new BadRequestException('文件名不能为空。');
    }
    if (!Number.isFinite(dto.size) || dto.size <= 0) {
      throw new BadRequestException('文件大小无效。');
    }

    const mimeType = (dto.mimeType || 'application/octet-stream').trim();
    const folderPath = this.resolveScopedFolderPath(dto.folderPath, credential);

    if (credential) {
      this.assertMimeAllowed(credential, mimeType);
      await this.assertWithinQuota(credential, dto.size);
    }

    // Project-level quota (create charge) — same path as buffer upload.
    await this.filesService.assertProjectQuota(projectId, dto.size, user?.id, { mode: 'create' });

    const result = await this.storageService.createDirectUploadCredential(projectId, {
      fileName: dto.fileName.trim(),
      mimeType,
      size: dto.size,
      folderPath,
    });

    if (!result) {
      return {
        supported: false,
        mode: 'chunked',
        message: '当前存储不支持直传，请使用分片上传接口。',
        folderPath,
      };
    }

    return {
      supported: true,
      mode: 'direct',
      ...result,
      folderPath,
      credentialId: credential?.id ?? null,
    };
  }

  async completePresign(
    projectId: string,
    dto: {
      storageKey: string;
      fileName: string;
      size: number;
      mimeType?: string;
      folderPath?: string | null;
      publicUrl?: string | null;
      checksum?: string | null;
      credentialId?: string | null;
      cdnConfigId?: string | null;
      duplicateStrategy?: 'reject' | 'reuse' | 'replace';
    },
    user?: RequestUser,
    credential?: ValidatedUploadCredential,
  ): Promise<Record<string, unknown>> {
    if (user) {
      await this.projectAccessService.assertProjectAccess(user, projectId, true);
    } else if (credential) {
      if (credential.projectId !== projectId) {
        throw new ForbiddenException('上传凭证与项目不匹配。');
      }
    } else {
      throw new UnauthorizedException('需要登录或上传凭证。');
    }

    if (!dto.storageKey?.trim() || !dto.fileName?.trim()) {
      throw new BadRequestException('storageKey 与 fileName 必填。');
    }
    if (!Number.isFinite(dto.size) || dto.size <= 0) {
      throw new BadRequestException('文件大小无效。');
    }

    const mimeType = (dto.mimeType || 'application/octet-stream').trim();
    const folderPath = this.resolveScopedFolderPath(dto.folderPath, credential);

    if (credential) {
      this.assertMimeAllowed(credential, mimeType);
      await this.assertWithinQuota(credential, dto.size);
    }

    // Prefer the live credential id over a client-supplied one.
    const credentialId = credential?.id ?? dto.credentialId ?? null;

    const registered = await this.filesService.registerUploadedObject({
      projectId,
      storageKey: dto.storageKey,
      originalName: dto.fileName,
      mimeType,
      size: dto.size,
      folderPath,
      publicUrl: dto.publicUrl,
      checksum: dto.checksum,
      actorId: user?.id,
      cdnConfigId: dto.cdnConfigId,
      duplicateStrategy: dto.duplicateStrategy,
    });

    if (credentialId) {
      // Ensure the credential still belongs to this project before charging usage.
      const owned = await this.prisma.uploadCredential.findFirst({
        where: { id: credentialId, projectId },
        select: { id: true, revokedAt: true },
      });
      if (owned && !owned.revokedAt) {
        await this.recordUsage(credentialId, dto.size, 1);
      }
    }

    return {
      success: true,
      ...registered,
      credentialId,
    };
  }

  private resolveScopedFolderPath(
    requested: string | null | undefined,
    credential?: ValidatedUploadCredential,
  ): string | null {
    const requestedNormalized = this.normalizeFolderPath(requested);
    const scopeFolder = credential?.scope.folderPath
      ? this.normalizeFolderPath(credential.scope.folderPath)
      : null;

    if (!scopeFolder) {
      return requestedNormalized;
    }

    // Force scoped folder when client omits path; require prefix when client provides one.
    if (!requestedNormalized) {
      return scopeFolder;
    }

    if (requestedNormalized === scopeFolder || requestedNormalized.startsWith(`${scopeFolder}/`)) {
      return requestedNormalized;
    }

    throw new ForbiddenException(`上传目录必须位于凭证允许的路径下：${scopeFolder}`);
  }

  private assertMimeAllowed(credential: ValidatedUploadCredential, mimeType: string): void {
    const allowed = credential.scope.allowedMimeTypes;
    if (!allowed || allowed.length === 0) {
      return;
    }

    const normalized = mimeType.toLowerCase();
    const ok = allowed.some((pattern) => {
      const p = pattern.trim().toLowerCase();
      if (!p) {
        return false;
      }
      if (p.endsWith('/*')) {
        return normalized.startsWith(p.slice(0, -1));
      }
      return normalized === p;
    });

    if (!ok) {
      throw new ForbiddenException(`MIME 类型不被上传凭证允许：${mimeType}`);
    }
  }

  private normalizeFolderPath(value: string | null | undefined): string | null {
    const normalized = String(value ?? '')
      .trim()
      .replace(/\\/g, '/')
      .split('/')
      .map((part) => part.trim())
      .filter((part) => part && part !== '.' && part !== '..')
      .join('/');
    return normalized || null;
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private parseScope(value: unknown): UploadCredentialScope {
    if (!value || typeof value !== 'object') {
      return {};
    }
    const record = value as Record<string, unknown>;
    return {
      folderPath: typeof record.folderPath === 'string' ? record.folderPath : null,
      maxBytes: typeof record.maxBytes === 'number' ? record.maxBytes : null,
      maxFiles: typeof record.maxFiles === 'number' ? record.maxFiles : null,
      allowedMimeTypes: Array.isArray(record.allowedMimeTypes)
        ? record.allowedMimeTypes.filter((item): item is string => typeof item === 'string')
        : undefined,
    };
  }

  private toResponse(credential: UploadCredential): Record<string, unknown> {
    const now = Date.now();
    const revoked = Boolean(credential.revokedAt);
    const expired = credential.expiresAt.getTime() <= now;
    return {
      id: credential.id,
      projectId: credential.projectId,
      name: credential.name,
      tokenPrefix: credential.tokenPrefix,
      scope: this.parseScope(credential.scope),
      maxBytes: credential.maxBytes === null ? null : Number(credential.maxBytes),
      usedBytes: Number(credential.usedBytes),
      maxFiles: credential.maxFiles,
      usedFiles: credential.usedFiles,
      expiresAt: credential.expiresAt,
      revokedAt: credential.revokedAt,
      createdById: credential.createdById,
      createdAt: credential.createdAt,
      updatedAt: credential.updatedAt,
      status: revoked ? 'REVOKED' : expired ? 'EXPIRED' : 'ACTIVE',
    };
  }
}
