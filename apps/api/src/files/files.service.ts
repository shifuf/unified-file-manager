import { createHash, randomBytes } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { mkdir, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';

import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AuditAction,
  CdnProvider,
  DerivativeKind,
  DerivativeStatus,
  FileCategory,
  FileStatus,
  UserRole,
  type CdnConfig,
  type ManagedFile,
  type Prisma,
} from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../common/types/request-user.type';
import { normalizeDomainAllowlist } from '../common/utils/domain-allowlist.util';
import { isIpAllowed, sanitizeIpAllowlist } from '../common/utils/ip-allowlist.util';
import { isPreviewable, resolveExtension, resolveFileCategory } from '../common/utils/file-category.util';
import { InMemoryAttemptLimiter } from '../common/utils/in-memory-attempt-limiter';
import { resolvePublicBaseUrl } from '../common/utils/origin.util';
import { DOMAIN_EVENTS } from '../events/domain-events';
import { EventBusService } from '../events/event-bus.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectAccessService } from '../projects/project-access.service';
import { SearchService } from '../search/search.service';
import { SettingsService } from '../settings/settings.service';
import { StorageService } from '../storage/storage.service';
import { TasksService } from '../tasks/tasks.service';
import { BatchFileOperationDto } from './dto/batch-file-operation.dto';
import { BatchCopyFileDto, BatchMoveFileDto } from './dto/batch-move-file.dto';
import { CopyFileDto } from './dto/copy-file.dto';
import { CreateShareLinkDto } from './dto/create-share-link.dto';
import { ListFilesDto } from './dto/list-files.dto';
import { ListShareLinksDto } from './dto/list-share-links.dto';
import { MoveFileDto } from './dto/move-file.dto';
import { UpdateFileDto } from './dto/update-file.dto';
import { UpdateShareLinkDto } from './dto/update-share-link.dto';
import { FolderPublicService } from './folder-public.service';
import { ShareIpAbuseService } from './share-ip-abuse.service';

type FileWithStorage = ManagedFile & {
  cdnConfig: CdnConfig | null;
  project?: { id: string; name: string } | null;
  /** Ready video derivatives attached before toResponse (list/detail). */
  _videoDerivatives?: Array<{
    kind: DerivativeKind;
    status: DerivativeStatus;
    publicUrl: string | null;
    storageKey: string;
  }>;
  /** Content-addressed reuse short-circuit marker for upload responses. */
  _duplicateReused?: boolean;
};
type DuplicateStrategy = 'reject' | 'reuse' | 'replace';
type UploadOptions = {
  duplicateStrategy?: DuplicateStrategy;
  folderPath?: string;
  /** When set, replace this existing file in-place (keeps fileId / share links / public URL). */
  targetFileId?: string;
};
type ShareStatus = 'ACTIVE' | 'DISABLED' | 'EXPIRED' | 'EXHAUSTED';

interface ChunkedUploadManifest {
  uploadId: string;
  projectId: string;
  fileName: string;
  size: number;
  totalChunks: number;
  mimeType: string;
  folderPath: string | null;
  duplicateStrategy: DuplicateStrategy;
  targetFileId?: string;
  uploaderId: string;
  createdAt: string;
}

/** Hard ceiling on chunk count per upload session (defence against tiny-chunk floods). */
const MAX_UPLOAD_CHUNKS = 10000;

export interface LocalFileMigrationSummary {
  projectId: string;
  targetConfigId: string;
  targetProvider: CdnProvider;
  scanned: number;
  migrated: number;
  skipped: number;
  failed: number;
  failures: Array<{
    fileId: string;
    originalName: string;
    reason: string;
  }>;
}

@Injectable()
export class FilesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FilesService.name);
  private readonly sharePasswordAttemptLimiter = new InMemoryAttemptLimiter({
    maxAttempts: 5,
    windowMs: 15 * 60 * 1000,
    lockMs: 15 * 60 * 1000,
  });
  /**
   * Share download anti-abuse: more than 5 download hits / IP / 60s → lock ~10 min + notify.
   * Counts every real download response (including ticket reuse), not previews.
   */
  private readonly shareDownloadRateLimiter = new InMemoryAttemptLimiter({
    maxAttempts: 5,
    windowMs: 60 * 1000,
    lockMs: 10 * 60 * 1000,
    maxKeys: 20_000,
  });
  private cleanupTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly auditService: AuditService,
    private readonly configService: ConfigService,
    private readonly eventBus: EventBusService,
    private readonly folderPublicService: FolderPublicService,
    private readonly prisma: PrismaService,
    private readonly projectAccessService: ProjectAccessService,
    private readonly searchService: SearchService,
    private readonly settingsService: SettingsService,
    private readonly shareIpAbuseService: ShareIpAbuseService,
    private readonly storageService: StorageService,
    private readonly tasksService: TasksService,
  ) {}

  onModuleInit(): void {
    const intervalMinutes = this.configService.get<number>('RECYCLE_CLEANUP_INTERVAL_MINUTES', 60);
    const intervalMs = Math.max(1, Number(intervalMinutes) || 60) * 60 * 1000;
    const startupTimer = setTimeout(() => {
      void this.runRecycleCleanup();
    }, 30 * 1000);

    startupTimer.unref?.();
    this.cleanupTimer = setInterval(() => {
      void this.runRecycleCleanup();
    }, intervalMs);
    this.cleanupTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
  }

  async upload(
    projectId: string,
    files: Express.Multer.File[],
    user: RequestUser,
    options: UploadOptions = {},
  ): Promise<Record<string, unknown>[]> {
    await this.projectAccessService.assertProjectAccess(user, projectId, true);
    return this.uploadToProject(projectId, files, user.id, options);
  }

  async uploadByCredential(
    projectId: string,
    files: Express.Multer.File[],
    options: UploadOptions = {},
  ): Promise<Record<string, unknown>[]> {
    return this.uploadToProject(projectId, files, undefined, options);
  }

  private async uploadToProject(
    projectId: string,
    files: Express.Multer.File[],
    actorId?: string,
    options: UploadOptions = {},
  ): Promise<Record<string, unknown>[]> {
    try {
      if (files.length === 0) {
        throw new BadRequestException('请选择至少一个文件。');
      }

      const uploadLimits = await this.settingsService.getUploadLimits();
      if (files.length > uploadLimits.maxBatchUploadCount) {
        throw new BadRequestException(`单次最多上传 ${uploadLimits.maxBatchUploadCount} 个文件。`);
      }

      const oversizedFile = files.find((file) => file.size > uploadLimits.maxFileSizeBytes);
      if (oversizedFile) {
        throw new BadRequestException(`单个文件不能超过 ${uploadLimits.maxFileSizeMb} MB。`);
      }

      const createdFiles: Record<string, unknown>[] = [];
      const project = await this.prisma.project.findUnique({
        where: { id: projectId },
        select: { name: true },
      });

      if (!project) {
        throw new NotFoundException('项目不存在。');
      }

      // targetFileId is only valid for a single-file overwrite.
      if (options.targetFileId && files.length !== 1) {
        throw new BadRequestException('指定文件覆盖时一次只能上传一个文件。');
      }

      for (const file of files) {
        const buffer = await this.readUploadBuffer(file);
        const uploadName = Buffer.from(file.originalname, 'latin1').toString('utf8').replace(/\\/g, '/');
        const uploadSegments = uploadName.split('/').filter(Boolean);
        const originalName = basename(uploadSegments.pop() ?? uploadName);
        const uploadRelativeFolder = uploadSegments.join('/');
        const folderPath = this.normalizeFolderPath([options.folderPath, uploadRelativeFolder].filter(Boolean).join('/'));

        createdFiles.push(
          await this.persistFileBuffer({
            projectId,
            projectName: project.name,
            buffer,
            originalName,
            mimeType: file.mimetype || 'application/octet-stream',
            size: file.size,
            folderPath,
            actorId,
            duplicateStrategy: options.duplicateStrategy,
            targetFileId: options.targetFileId,
          }),
        );
      }

      return createdFiles;
    } finally {
      await this.cleanupUploadFiles(files);
    }
  }

  /**
   * Dedupe (by checksum+size), store to the project's active CDN, and record a
   * single uploaded file. Shared by multipart upload and chunked-upload assembly.
   *
   * Strategies:
   * - reject (default): throw when content already exists in the project
   * - reuse: return the existing file when content matches
   * - replace: overwrite by name(+folder) or by targetFileId, keeping the same
   *   fileId so public access URLs and share links stay valid
   */
  private async persistFileBuffer(params: {
    projectId: string;
    projectName: string;
    buffer: Buffer;
    originalName: string;
    mimeType: string;
    size: number;
    folderPath: string | null;
    actorId?: string;
    duplicateStrategy?: DuplicateStrategy;
    targetFileId?: string;
  }): Promise<Record<string, unknown>> {
    const { projectId, projectName, buffer, originalName, mimeType, size, folderPath, actorId } = params;
    const extension = resolveExtension(originalName);
    const category = resolveFileCategory(originalName, mimeType);
    const checksum = createHash('sha256').update(buffer).digest('hex');
    const strategy = params.duplicateStrategy ?? 'reject';

    // Explicit target takes precedence — always replace that record in-place.
    // Even when the uploaded name differs, content is overwritten and originalName is updated.
    if (params.targetFileId) {
      const existingTarget = await this.prisma.managedFile.findFirst({
        where: { id: params.targetFileId, projectId },
        select: { size: true, status: true, folderPath: true },
      });
      if (!existingTarget) {
        throw new NotFoundException('要覆盖的目标文件不存在。');
      }
      await this.assertProjectQuota(projectId, size, actorId, {
        mode: 'replace',
        previousBytes: existingTarget.status === FileStatus.ACTIVE ? Number(existingTarget.size) : 0,
      });
      return this.replaceExistingFile({
        projectId,
        projectName,
        buffer,
        originalName,
        mimeType,
        size,
        // Keep the target file in its original directory; only the display name changes.
        folderPath: existingTarget.folderPath,
        extension,
        category,
        checksum,
        actorId,
        targetFileId: params.targetFileId,
        forceRename: true,
      });
    }

    // Name-based replace: same project + folderPath + originalName → keep fileId.
    if (strategy === 'replace') {
      const nameMatch =
        (await this.prisma.managedFile.findFirst({
          where: {
            projectId,
            originalName,
            folderPath,
            status: FileStatus.ACTIVE,
          },
          include: { cdnConfig: true },
          orderBy: { createdAt: 'asc' },
        })) ??
        (await this.prisma.managedFile.findFirst({
          where: {
            projectId,
            originalName,
            folderPath,
            status: FileStatus.RECYCLED,
          },
          include: { cdnConfig: true },
          orderBy: { createdAt: 'asc' },
        }));

      if (nameMatch) {
        await this.assertProjectQuota(projectId, size, actorId, {
          mode: 'replace',
          previousBytes: nameMatch.status === FileStatus.ACTIVE ? Number(nameMatch.size) : 0,
        });
        return this.replaceExistingFile({
          projectId,
          projectName,
          buffer,
          originalName,
          mimeType,
          size,
          folderPath,
          extension,
          category,
          checksum,
          actorId,
          targetFileId: nameMatch.id,
        });
      }
    }

    const duplicateSource = checksum
      ? (await this.prisma.managedFile.findFirst({
          where: { projectId, checksum, size: BigInt(size), status: FileStatus.ACTIVE },
          include: { cdnConfig: true },
          orderBy: { createdAt: 'asc' },
        })) ??
        (await this.prisma.managedFile.findFirst({
          where: { projectId, checksum, size: BigInt(size), status: FileStatus.RECYCLED },
          include: { cdnConfig: true },
          orderBy: { createdAt: 'asc' },
        }))
      : null;

    if (duplicateSource) {
      // Content-identical with an existing file: reuse/restore only when strategy is
      // 'reuse'. Name-based replace already ran above; without a name match, content
      // collisions still reject (or reuse) rather than silently rewriting another file.
      if (strategy === 'reuse' && duplicateSource.status === FileStatus.ACTIVE) {
        await this.assertProjectQuota(projectId, size, actorId, { mode: 'reuse' });
        const reused =
          duplicateSource.duplicateOfId
            ? duplicateSource
            : await this.prisma.managedFile.update({
                where: { id: duplicateSource.id },
                data: { duplicateOfId: duplicateSource.id },
                include: { cdnConfig: true },
              });
        await this.auditService.write({
          action: AuditAction.FILE_UPLOAD,
          actorId,
          projectId,
          detail: { fileId: reused.id, originalName, size, duplicateReused: true },
        });
        this.eventBus.emit(DOMAIN_EVENTS.FILE_UPLOADED, {
          projectId,
          fileId: reused.id,
          originalName,
          size,
          mimeType,
          category,
          folderPath,
          actorId,
        });
        return this.toResponse({ ...reused, _duplicateReused: true });
      }

      if (strategy === 'reuse' && duplicateSource.status === FileStatus.RECYCLED) {
        // Restoring a recycled file re-enters ACTIVE usage; charge as create for quota.
        await this.assertProjectQuota(projectId, size, actorId, { mode: 'create' });
        const restoredDuplicate = await this.prisma.managedFile.update({
          where: { id: duplicateSource.id },
          data: {
            status: FileStatus.ACTIVE,
            deletedAt: null,
            purgeAt: null,
            duplicateOfId: duplicateSource.duplicateOfId ?? duplicateSource.id,
          },
          include: { cdnConfig: true },
        });
        await this.auditService.write({
          action: AuditAction.FILE_UPLOAD,
          actorId,
          projectId,
          detail: { fileId: restoredDuplicate.id, originalName, size, duplicateReused: true, duplicateRestored: true },
        });
        this.eventBus.emit(DOMAIN_EVENTS.FILE_UPLOADED, {
          projectId,
          fileId: restoredDuplicate.id,
          originalName,
          size,
          mimeType,
          category,
          folderPath,
          actorId,
        });
        return this.toResponse({ ...restoredDuplicate, _duplicateReused: true });
      }

      const location = duplicateSource.status === FileStatus.RECYCLED ? '回收站中' : '文件管理中';
      throw new BadRequestException(
        `文件 ${originalName} 与${location}的 ${duplicateSource.originalName} 内容重复，请先使用已有文件或处理原文件。`,
      );
    }

    await this.assertProjectQuota(projectId, size, actorId, { mode: 'create' });
    const storageKey = this.buildStorageKey(projectName, originalName, folderPath);
    const uploadResult = await this.storageService.upload(projectId, { key: storageKey, buffer, mimeType, originalName });
    const managedFile = await this.prisma.managedFile.create({
      data: {
        projectId,
        cdnConfigId: uploadResult.cdnConfigId,
        originalName,
        storageKey: uploadResult.storageKey,
        mimeType,
        extension,
        size: BigInt(size),
        category,
        checksum,
        publicUrl: uploadResult.publicUrl,
        folderPath,
        thumbnailUrl: null,
        scanStatus: 'SKIPPED',
        scannedAt: new Date(),
        scanDetail: null,
        uploadedById: actorId,
      },
      include: { cdnConfig: true },
    });

    await this.auditService.write({
      action: AuditAction.FILE_UPLOAD,
      actorId,
      projectId,
      detail: { fileId: managedFile.id, originalName, size },
    });

    this.eventBus.emit(DOMAIN_EVENTS.FILE_UPLOADED, {
      projectId,
      fileId: managedFile.id,
      originalName,
      size,
      mimeType,
      category,
      folderPath,
      actorId,
    });

    return this.toResponse(managedFile);
  }

  /**
   * Overwrite an existing ManagedFile in-place: new storage object, same row id.
   * Public URL (`/api/public/files/:fileId`) and share links remain valid.
   */
  private async replaceExistingFile(params: {
    projectId: string;
    projectName: string;
    buffer: Buffer;
    originalName: string;
    mimeType: string;
    size: number;
    folderPath: string | null;
    extension: string;
    category: FileCategory;
    checksum: string;
    actorId?: string;
    targetFileId: string;
    /** When true (target-id overwrite), always set originalName to the uploaded name. */
    forceRename?: boolean;
  }): Promise<Record<string, unknown>> {
    const existing = await this.prisma.managedFile.findFirst({
      where: { id: params.targetFileId, projectId: params.projectId },
      include: { cdnConfig: true },
    });

    if (!existing) {
      throw new NotFoundException('要覆盖的目标文件不存在。');
    }

    if (existing.status === FileStatus.DELETED) {
      throw new BadRequestException('目标文件已彻底删除，无法覆盖。');
    }

    // Short-circuit when content is identical — no storage rewrite needed.
    if (
      existing.status === FileStatus.ACTIVE &&
      existing.checksum === params.checksum &&
      existing.size === BigInt(params.size)
    ) {
      const nextName =
        params.forceRename && params.originalName?.trim()
          ? params.originalName.trim()
          : params.originalName?.trim() || existing.originalName;
      const nextFolder = params.forceRename
        ? existing.folderPath
        : params.folderPath ?? existing.folderPath;
      // Still allow renaming via the upload metadata (forced on targeted overwrite).
      if (existing.originalName !== nextName || existing.folderPath !== nextFolder) {
        const renamed = await this.prisma.managedFile.update({
          where: { id: existing.id },
          data: {
            originalName: nextName,
            extension: params.extension,
            category: params.category,
            folderPath: nextFolder,
            mimeType: params.mimeType,
          },
          include: { cdnConfig: true },
        });
        await this.auditService.write({
          action: AuditAction.FILE_UPLOAD,
          actorId: params.actorId,
          projectId: params.projectId,
          detail: {
            fileId: renamed.id,
            originalName: nextName,
            size: params.size,
            replaced: true,
            contentUnchanged: true,
            renamed: true,
          },
        });
        return this.toResponse(renamed);
      }

      await this.auditService.write({
        action: AuditAction.FILE_UPLOAD,
        actorId: params.actorId,
        projectId: params.projectId,
        detail: {
          fileId: existing.id,
          originalName: params.originalName,
          size: params.size,
          replaced: true,
          contentUnchanged: true,
        },
      });
      return this.toResponse(existing);
    }

    const storageKey = this.buildStorageKey(params.projectName, params.originalName, params.folderPath);
    // Snapshot current content before overwrite so restoreVersion can roll back.
    if (existing.status === FileStatus.ACTIVE) {
      await this.snapshotCurrentVersion(existing, params.actorId, 'before-replace');
    }
    const uploadResult = await this.storageService.upload(params.projectId, {
      key: storageKey,
      buffer: params.buffer,
      mimeType: params.mimeType,
      originalName: params.originalName,
    });

    const previousCdnConfig = existing.cdnConfig;
    const previousStorageKey = existing.storageKey;

    // Keep identity fields that define stable external links:
    // - id (fileId) never changes
    // - isPublic stays as-is so domain policy doesn't flip under clients
    // - originalName: targeted overwrite always renames to the uploaded filename
    //   (even when different from the previous name)
    const uploadedName = params.originalName?.trim() || '';
    const nextOriginalName =
      params.forceRename && uploadedName
        ? uploadedName
        : uploadedName || existing.originalName;
    const nextFolderPath =
      params.forceRename ? existing.folderPath : params.folderPath ?? existing.folderPath;
    const updated = await this.prisma.managedFile.update({
      where: { id: existing.id },
      data: {
        cdnConfigId: uploadResult.cdnConfigId,
        originalName: nextOriginalName,
        storageKey: uploadResult.storageKey,
        mimeType: params.mimeType,
        extension: params.extension || existing.extension,
        size: BigInt(params.size),
        category: params.category,
        checksum: params.checksum,
        publicUrl: uploadResult.publicUrl,
        folderPath: nextFolderPath,
        // isPublic intentionally omitted — overwrite must not change open/closed policy
        thumbnailUrl: null,
        scanStatus: 'SKIPPED',
        scanDetail: null,
        scannedAt: new Date(),
        // Reactivate if it was in the recycle bin.
        status: FileStatus.ACTIVE,
        deletedAt: null,
        purgeAt: null,
        // Clear stale duplicate pointers after content rewrite.
        duplicateOfId: null,
        currentVersion: Math.max(1, Number(existing.currentVersion || 1)) + 1,
      },
      include: { cdnConfig: true },
    });

    // Best-effort cleanup of the previous object (skip if key reused).
    if (
      previousCdnConfig &&
      previousStorageKey &&
      previousStorageKey !== uploadResult.storageKey
    ) {
      try {
        await this.storageService.remove(previousCdnConfig, previousStorageKey);
      } catch (error) {
        this.logger.warn(
          `覆盖上传后清理旧对象失败：fileId=${existing.id} key=${previousStorageKey} reason=${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    await this.auditService.write({
      action: AuditAction.FILE_UPLOAD,
      actorId: params.actorId,
      projectId: params.projectId,
      detail: {
        fileId: updated.id,
        originalName: params.originalName,
        size: params.size,
        replaced: true,
        previousStorageKey,
      },
    });

    this.eventBus.emit(DOMAIN_EVENTS.FILE_UPLOADED, {
      projectId: params.projectId,
      fileId: updated.id,
      originalName: nextOriginalName,
      size: params.size,
      mimeType: params.mimeType,
      category: params.category,
      folderPath: nextFolderPath,
      actorId: params.actorId,
    });

    return this.toResponse(updated);
  }

  // ---- Chunked / resumable upload -------------------------------------------------

  async initChunkedUpload(
    projectId: string,
    dto: {
      fileName: string;
      size: number;
      totalChunks: number;
      mimeType?: string;
      folderPath?: string;
      duplicateStrategy?: DuplicateStrategy;
      targetFileId?: string;
    },
    user: RequestUser,
  ): Promise<{ uploadId: string; received: number[]; totalChunks: number }> {
    await this.projectAccessService.assertProjectAccess(user, projectId, true);
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, deletedAt: null, enabled: true },
      select: { id: true },
    });
    if (!project) {
      throw new NotFoundException('项目不存在。');
    }

    const limits = await this.settingsService.getUploadLimits();
    if (!Number.isFinite(dto.size) || dto.size <= 0) {
      throw new BadRequestException('文件大小无效。');
    }
    if (dto.size > limits.maxFileSizeBytes) {
      throw new BadRequestException(`单个文件不能超过 ${limits.maxFileSizeMb} MB。`);
    }
    if (!Number.isInteger(dto.totalChunks) || dto.totalChunks < 1 || dto.totalChunks > MAX_UPLOAD_CHUNKS) {
      throw new BadRequestException('分片数量无效。');
    }

    if (dto.targetFileId) {
      const target = await this.prisma.managedFile.findFirst({
        where: { id: dto.targetFileId, projectId },
        select: { id: true },
      });
      if (!target) {
        throw new NotFoundException('要覆盖的目标文件不存在。');
      }
    }

    const uploadId = randomBytes(16).toString('hex');
    const dir = this.chunkedUploadDir(uploadId);
    await mkdir(dir, { recursive: true });
    const strategy: DuplicateStrategy = dto.targetFileId
      ? 'replace'
      : dto.duplicateStrategy === 'reuse' || dto.duplicateStrategy === 'replace'
        ? dto.duplicateStrategy
        : 'reject';
    const manifest: ChunkedUploadManifest = {
      uploadId,
      projectId,
      fileName: basename(dto.fileName ?? '').slice(0, 255) || `upload-${uploadId}`,
      size: Math.floor(dto.size),
      totalChunks: dto.totalChunks,
      mimeType: dto.mimeType?.trim() || 'application/octet-stream',
      folderPath: dto.folderPath ?? null,
      duplicateStrategy: strategy,
      ...(dto.targetFileId ? { targetFileId: dto.targetFileId } : {}),
      uploaderId: user.id,
      createdAt: new Date().toISOString(),
    };
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));

    return { uploadId, received: [], totalChunks: manifest.totalChunks };
  }

  async uploadChunk(
    projectId: string,
    uploadId: string,
    chunkIndex: number,
    file: Express.Multer.File | undefined,
    user: RequestUser,
  ): Promise<{ received: number; totalChunks: number }> {
    await this.projectAccessService.assertProjectAccess(user, projectId, true);
    const manifest = await this.readChunkManifest(projectId, uploadId);

    if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= manifest.totalChunks) {
      throw new BadRequestException('分片序号无效。');
    }
    if (!file) {
      throw new BadRequestException('分片内容为空。');
    }

    try {
      const buffer = await this.readUploadBuffer(file);
      if (buffer.length === 0) {
        throw new BadRequestException('分片内容为空。');
      }
      await writeFile(join(this.chunkedUploadDir(uploadId), `part-${chunkIndex}`), buffer);
    } finally {
      await this.cleanupUploadFiles([file]);
    }

    const received = await this.listReceivedChunks(uploadId, manifest.totalChunks);
    return { received: received.length, totalChunks: manifest.totalChunks };
  }

  async getChunkStatus(
    projectId: string,
    uploadId: string,
    user: RequestUser,
  ): Promise<{ uploadId: string; fileName: string; totalChunks: number; received: number[] }> {
    await this.projectAccessService.assertProjectAccess(user, projectId, true);
    const manifest = await this.readChunkManifest(projectId, uploadId);
    const received = await this.listReceivedChunks(uploadId, manifest.totalChunks);
    return { uploadId, fileName: manifest.fileName, totalChunks: manifest.totalChunks, received };
  }

  async completeChunkedUpload(projectId: string, uploadId: string, user: RequestUser): Promise<Record<string, unknown>> {
    await this.projectAccessService.assertProjectAccess(user, projectId, true);
    const manifest = await this.readChunkManifest(projectId, uploadId);
    const received = await this.listReceivedChunks(uploadId, manifest.totalChunks);

    if (received.length !== manifest.totalChunks) {
      throw new BadRequestException(`分片不完整（${received.length}/${manifest.totalChunks}），无法合并。`);
    }

    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { name: true } });
    if (!project) {
      await this.cleanupChunkedUpload(uploadId);
      throw new NotFoundException('项目不存在。');
    }

    const dir = this.chunkedUploadDir(uploadId);
    try {
      const limits = await this.settingsService.getUploadLimits();
      const parts: Buffer[] = [];
      let total = 0;
      for (let index = 0; index < manifest.totalChunks; index += 1) {
        const part = await readFile(join(dir, `part-${index}`));
        total += part.length;
        if (total > limits.maxFileSizeBytes) {
          throw new BadRequestException(`单个文件不能超过 ${limits.maxFileSizeMb} MB。`);
        }
        parts.push(part);
      }

      const buffer = Buffer.concat(parts);
      return await this.persistFileBuffer({
        projectId,
        projectName: project.name,
        buffer,
        originalName: manifest.fileName,
        mimeType: manifest.mimeType,
        size: buffer.length,
        folderPath: this.normalizeFolderPath(manifest.folderPath),
        actorId: user.id,
        duplicateStrategy: manifest.duplicateStrategy,
        targetFileId: manifest.targetFileId,
      });
    } finally {
      await this.cleanupChunkedUpload(uploadId);
    }
  }

  async abortChunkedUpload(projectId: string, uploadId: string, user: RequestUser): Promise<{ success: boolean }> {
    await this.projectAccessService.assertProjectAccess(user, projectId, true);
    this.chunkedUploadDir(uploadId); // validates the uploadId format

    let belongsToProject = true;
    try {
      await this.readChunkManifest(projectId, uploadId);
    } catch {
      belongsToProject = false; // missing or owned by another project — nothing to remove here
    }

    if (belongsToProject) {
      await this.cleanupChunkedUpload(uploadId);
    }

    return { success: true };
  }

  private chunkedUploadRoot(): string {
    const root = this.configService.get<string>('LOCAL_STORAGE_ROOT', './storage');
    const base = isAbsolute(root) ? root : resolve(process.cwd(), root);
    return resolve(base, '.chunked-uploads');
  }

  private chunkedUploadDir(uploadId: string): string {
    if (!/^[a-f0-9]{32}$/.test(uploadId)) {
      throw new BadRequestException('上传会话标识无效。');
    }
    return resolve(this.chunkedUploadRoot(), uploadId);
  }

  private async readChunkManifest(projectId: string, uploadId: string): Promise<ChunkedUploadManifest> {
    const dir = this.chunkedUploadDir(uploadId);
    let raw: string;
    try {
      raw = await readFile(join(dir, 'manifest.json'), 'utf8');
    } catch {
      throw new NotFoundException('上传会话不存在或已过期。');
    }

    const manifest = JSON.parse(raw) as ChunkedUploadManifest;
    if (manifest.projectId !== projectId) {
      throw new NotFoundException('上传会话不存在或已过期。');
    }

    return manifest;
  }

  private async listReceivedChunks(uploadId: string, totalChunks: number): Promise<number[]> {
    const dir = this.chunkedUploadDir(uploadId);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return [];
    }

    const indices = entries
      .map((name) => /^part-(\d+)$/.exec(name))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => Number(match[1]))
      .filter((index) => Number.isInteger(index) && index >= 0 && index < totalChunks);

    return [...new Set(indices)].sort((left, right) => left - right);
  }

  private async cleanupChunkedUpload(uploadId: string): Promise<void> {
    try {
      await rm(this.chunkedUploadDir(uploadId), { recursive: true, force: true });
    } catch {
      // Best effort — a maintenance sweep also reaps stale upload sessions.
    }
  }

  async list(query: ListFilesDto, user: RequestUser): Promise<{
    items: Record<string, unknown>[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    if (query.projectId) {
      await this.projectAccessService.assertProjectAccess(user, query.projectId);
    }

    return this.listByProject(query, user);
  }

  /**
   * Full-text search within a project. Tries Meilisearch first; falls back to SQL keyword list.
   */
  async search(
    projectId: string,
    q: string,
    user: RequestUser,
    options?: { page?: number; pageSize?: number },
  ): Promise<{
    items: Record<string, unknown>[];
    total: number;
    page: number;
    pageSize: number;
    source: 'meili' | 'sql';
  }> {
    await this.projectAccessService.assertProjectAccess(user, projectId);

    const page = Math.max(1, Number(options?.page ?? 1) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(options?.pageSize ?? 20) || 20));
    const keyword = q?.trim() ?? '';

    if (!keyword) {
      const empty = await this.listByProject(
        { projectId, page, pageSize, status: FileStatus.ACTIVE },
        user,
      );
      return { ...empty, source: 'sql' };
    }

    const meili = await this.searchService.searchFileIds(projectId, keyword, {
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });

    if (meili && meili.ids.length > 0) {
      const files = await this.prisma.managedFile.findMany({
        where: {
          id: { in: meili.ids },
          projectId,
          status: FileStatus.ACTIVE,
        },
        include: { cdnConfig: true, project: { select: { id: true, name: true } } },
      });
      const byId = new Map(files.map((file) => [file.id, file]));
      const ordered = meili.ids.map((id) => byId.get(id)).filter((file): file is NonNullable<typeof file> => Boolean(file));
      await this.attachVideoDerivatives(ordered);
      return {
        items: ordered.map((item) => this.toResponse(item)),
        total: meili.total,
        page,
        pageSize,
        source: 'meili',
      };
    }

    if (meili && meili.ids.length === 0) {
      return { items: [], total: meili.total, page, pageSize, source: 'meili' };
    }

    const fallback = await this.listByProject(
      { projectId, keyword, page, pageSize, status: FileStatus.ACTIVE },
      user,
    );
    return { ...fallback, source: 'sql' };
  }

  async getPublicLibrary(slug: string): Promise<Record<string, unknown>> {
    const project = await this.prisma.project.findFirst({
      where: {
        publicLibrarySlug: slug,
        publicLibraryEnabled: true,
        deletedAt: null,
        enabled: true,
      },
      select: {
        id: true,
        name: true,
        description: true,
        publicLibrarySlug: true,
      },
    });

    if (!project) {
      throw new NotFoundException('公开资源库不存在或未启用。');
    }

    const fileCount = await this.prisma.managedFile.count({
      where: {
        projectId: project.id,
        status: FileStatus.ACTIVE,
        isPublic: true,
      },
    });

    return {
      id: project.id,
      name: project.name,
      description: project.description,
      slug: project.publicLibrarySlug,
      fileCount,
    };
  }

  async listPublicLibraryFiles(
    slug: string,
    options?: {
      page?: number;
      pageSize?: number;
      keyword?: string;
      category?: string;
      folderPath?: string | null;
      sort?: 'newest' | 'oldest' | 'name' | 'size';
    },
  ): Promise<{
    items: Record<string, unknown>[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const project = await this.prisma.project.findFirst({
      where: {
        publicLibrarySlug: slug,
        publicLibraryEnabled: true,
        deletedAt: null,
        enabled: true,
      },
      select: { id: true, name: true },
    });

    if (!project) {
      throw new NotFoundException('公开资源库不存在或未启用。');
    }

    const page = Math.max(1, Number(options?.page ?? 1) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(options?.pageSize ?? 20) || 20));
    const keyword = options?.keyword?.trim();
    const category = options?.category?.trim().toUpperCase();
    const folderPath = this.normalizeFolderPath(options?.folderPath);
    const sort = options?.sort ?? 'newest';
    const orderBy: Prisma.ManagedFileOrderByWithRelationInput =
      sort === 'oldest'
        ? { createdAt: 'asc' }
        : sort === 'name'
          ? { originalName: 'asc' }
          : sort === 'size'
            ? { size: 'desc' }
            : { createdAt: 'desc' };

    const where: Prisma.ManagedFileWhereInput = {
      projectId: project.id,
      status: FileStatus.ACTIVE,
      isPublic: true,
      ...(category && Object.values(FileCategory).includes(category as FileCategory)
        ? { category: category as FileCategory }
        : {}),
      ...(folderPath !== null && folderPath !== undefined
        ? options?.folderPath === ''
          ? { OR: [{ folderPath: null }, { folderPath: '' }] }
          : {
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

    const total = await this.prisma.managedFile.count({ where });
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.min(page, totalPages);
    const items = await this.prisma.managedFile.findMany({
      where,
      include: { cdnConfig: true, project: { select: { id: true, name: true } } },
      orderBy,
      skip: (safePage - 1) * pageSize,
      take: pageSize,
    });

    await this.attachVideoDerivatives(items);
    return {
      items: items.map((item) => this.toResponse(item)),
      total,
      page: safePage,
      pageSize,
    };
  }

  async listByProject(query: ListFilesDto, user?: RequestUser): Promise<{
    items: Record<string, unknown>[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const requestedPage = Math.max(1, Number(query.page ?? 1) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(query.pageSize ?? 20) || 20));
    const where: Prisma.ManagedFileWhereInput = {
      ...(query.projectId ? { projectId: query.projectId } : this.accessibleProjectWhere(user)),
      status: query.status ?? FileStatus.ACTIVE,
      ...(query.category ? { category: query.category } : {}),
      ...(query.extension ? { extension: this.normalizeExtension(query.extension) } : {}),
      // undefined = no folder filter; '' / null-ish after normalize = root only (folderPath IS NULL)
      ...(query.folderPath !== undefined ? { folderPath: this.normalizeFolderPath(query.folderPath) } : {}),
      ...(query.tag ? { tags: { contains: this.normalizeTag(query.tag) } } : {}),
      ...(query.cdnProvider ? { cdnConfig: { is: { provider: query.cdnProvider } } } : {}),
      ...(query.duplicateOnly ? { duplicateOfId: { not: null } } : {}),
      ...(query.minSize !== undefined || query.maxSize !== undefined
        ? {
            size: {
              ...(query.minSize !== undefined ? { gte: BigInt(query.minSize) } : {}),
              ...(query.maxSize !== undefined ? { lte: BigInt(query.maxSize) } : {}),
            },
          }
        : {}),
      ...(query.uploadedStartAt || query.uploadedEndAt
        ? {
            createdAt: {
              ...(query.uploadedStartAt ? { gte: new Date(query.uploadedStartAt) } : {}),
              ...(query.uploadedEndAt ? { lte: new Date(query.uploadedEndAt) } : {}),
            },
          }
        : {}),
    };

    if (query.keyword?.trim()) {
      const keyword = query.keyword.trim();
      where.OR = [
        { originalName: { contains: keyword } },
        { remark: { contains: keyword } },
        { tags: { contains: keyword } },
        { extension: { contains: keyword.replace(/^\./, '') } },
      ];
    }
    const total = await this.prisma.managedFile.count({ where });
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(requestedPage, totalPages);
    const items = await this.prisma.managedFile.findMany({
      where,
      include: { cdnConfig: true, project: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });

    await this.attachVideoDerivatives(items);
    return {
      items: items.map((item) => this.toResponse(item)),
      total,
      page,
      pageSize,
    };
  }

  async get(fileId: string, user: RequestUser): Promise<Record<string, unknown>> {
    const file = await this.findFileForUser(fileId, user);
    await this.attachVideoDerivatives([file]);
    return this.toResponse(file);
  }

  async getForProject(fileId: string, projectId: string): Promise<Record<string, unknown>> {
    const file = await this.findFileForProject(fileId, projectId);
    await this.attachVideoDerivatives([file]);
    return this.toResponse(file);
  }

  async update(fileId: string, dto: UpdateFileDto, user: RequestUser): Promise<Record<string, unknown>> {
    const file = await this.findFileForUser(fileId, user, true);
    const originalName = dto.originalName === undefined ? undefined : basename(dto.originalName.trim());
    const updated = await this.prisma.managedFile.update({
      where: { id: fileId },
      data: {
        originalName,
        extension: originalName ? resolveExtension(originalName) : undefined,
        category: originalName ? resolveFileCategory(originalName, file.mimeType) : undefined,
        remark: dto.remark === undefined ? undefined : this.emptyToNull(dto.remark),
        tags: dto.tags === undefined ? undefined : this.serializeTags(dto.tags),
        folderPath: dto.folderPath === undefined ? undefined : this.normalizeFolderPath(dto.folderPath),
        isPublic: dto.isPublic === undefined ? undefined : dto.isPublic,
      },
      include: { cdnConfig: true },
    });

    await this.auditService.write({
      action: AuditAction.FILE_UPDATE,
      actorId: user.id,
      projectId: file.projectId,
      detail: {
        fileId,
        originalName,
        tags: dto.tags,
        folderPath: dto.folderPath,
        remarkChanged: dto.remark !== undefined,
        isPublic: dto.isPublic,
      },
    });

    this.eventBus.emit(DOMAIN_EVENTS.FILE_UPDATED, {
      projectId: file.projectId,
      fileId,
      originalName: updated.originalName,
      actorId: user.id,
    });

    if (dto.isPublic !== undefined && dto.isPublic !== file.isPublic) {
      this.eventBus.emit(dto.isPublic ? DOMAIN_EVENTS.FILE_PUBLISHED : DOMAIN_EVENTS.FILE_UNPUBLISHED, {
        projectId: file.projectId,
        fileId,
        originalName: updated.originalName,
        actorId: user.id,
      });
    }

    return this.toResponse(updated);
  }

  async updateForProject(fileId: string, projectId: string, dto: UpdateFileDto): Promise<Record<string, unknown>> {
    const file = await this.findFileForProject(fileId, projectId);
    const originalName = dto.originalName === undefined ? undefined : basename(dto.originalName.trim());
    const updated = await this.prisma.managedFile.update({
      where: { id: fileId },
      data: {
        originalName,
        extension: originalName ? resolveExtension(originalName) : undefined,
        category: originalName ? resolveFileCategory(originalName, file.mimeType) : undefined,
        remark: dto.remark === undefined ? undefined : this.emptyToNull(dto.remark),
        tags: dto.tags === undefined ? undefined : this.serializeTags(dto.tags),
        folderPath: dto.folderPath === undefined ? undefined : this.normalizeFolderPath(dto.folderPath),
        isPublic: dto.isPublic === undefined ? undefined : dto.isPublic,
      },
      include: { cdnConfig: true },
    });

    await this.auditService.write({
      action: AuditAction.FILE_UPDATE,
      projectId,
      detail: { fileId, source: 'open-api', isPublic: dto.isPublic },
    });

    this.eventBus.emit(DOMAIN_EVENTS.FILE_UPDATED, {
      projectId,
      fileId,
      originalName: updated.originalName,
    });

    if (dto.isPublic !== undefined && dto.isPublic !== file.isPublic) {
      this.eventBus.emit(dto.isPublic ? DOMAIN_EVENTS.FILE_PUBLISHED : DOMAIN_EVENTS.FILE_UNPUBLISHED, {
        projectId,
        fileId,
        originalName: updated.originalName,
      });
    }

    return this.toResponse(updated);
  }

  async move(fileId: string, dto: MoveFileDto, user: RequestUser): Promise<Record<string, unknown>> {
    const file = await this.findFileForUser(fileId, user, true);
    const folderPath = this.normalizeFolderPath(dto.folderPath);
    const updated = await this.prisma.managedFile.update({
      where: { id: fileId },
      data: { folderPath },
      include: { cdnConfig: true, project: { select: { id: true, name: true } } },
    });

    await this.auditService.write({
      action: AuditAction.FILE_MOVE,
      actorId: user.id,
      projectId: file.projectId,
      detail: { fileId, fromFolderPath: file.folderPath, toFolderPath: folderPath },
    });

    this.eventBus.emit(DOMAIN_EVENTS.FILE_UPDATED, {
      projectId: file.projectId,
      fileId,
      originalName: updated.originalName,
      actorId: user.id,
    });

    return this.toResponse(updated);
  }

  async copy(fileId: string, dto: CopyFileDto, user: RequestUser): Promise<Record<string, unknown>> {
    const file = await this.findFileForUser(fileId, user);
    const targetProjectId = dto.projectId || file.projectId;
    await this.projectAccessService.assertProjectAccess(user, targetProjectId, true);
    const copied = await this.copyFileToProject(file, targetProjectId, dto.folderPath, user.id, 'manual');

    return this.toResponse(copied);
  }

  async batchMove(dto: BatchMoveFileDto, user: RequestUser): Promise<Record<string, unknown>> {
    const files = await this.findFilesForUser(dto.fileIds, user, true);
    const folderPath = this.normalizeFolderPath(dto.folderPath);

    await this.prisma.managedFile.updateMany({
      where: { id: { in: files.map((file) => file.id) } },
      data: { folderPath },
    });
    await this.writeBatchAudit(AuditAction.FILE_BATCH_MOVE, files, user.id, { folderPath });

    for (const file of files) {
      this.eventBus.emit(DOMAIN_EVENTS.FILE_UPDATED, {
        projectId: file.projectId,
        fileId: file.id,
        originalName: file.originalName,
        actorId: user.id,
      });
    }

    const task = await this.tasksService.create({
      type: 'FILE_BATCH_MOVE',
      title: '批量移动文件',
      actorId: user.id,
      projectId: this.singleProjectId(files),
      result: { total: files.length, folderPath },
    });

    return { success: true, total: files.length, task };
  }

  async batchCopy(dto: BatchCopyFileDto, user: RequestUser): Promise<Record<string, unknown>> {
    const files = await this.findFilesForUser(dto.fileIds, user, false);
    const targetProjectId = dto.projectId?.trim() || undefined;
    let copied = 0;
    let failed = 0;

    if (targetProjectId) {
      await this.projectAccessService.assertProjectAccess(user, targetProjectId, true);
    }

    for (const file of files) {
      try {
        const destinationProjectId = targetProjectId ?? file.projectId;

        if (!targetProjectId) {
          await this.projectAccessService.assertProjectAccess(user, destinationProjectId, true);
        }

        await this.copyFileToProject(file, destinationProjectId, dto.folderPath, user.id, 'batch');
        copied += 1;
      } catch {
        failed += 1;
      }
    }

    await this.writeBatchAudit(AuditAction.FILE_BATCH_COPY, files, user.id, {
      copied,
      failed,
      folderPath: dto.folderPath,
      targetProjectId,
    });
    const task = await this.tasksService.create({
      type: 'FILE_BATCH_COPY',
      title: '批量复制文件',
      actorId: user.id,
      projectId: targetProjectId ?? this.singleProjectId(files),
      status: failed > 0 ? 'FAILED' : 'COMPLETED',
      result: { total: files.length, copied, failed, folderPath: dto.folderPath, targetProjectId },
      error: failed > 0 ? `${failed} 个文件复制失败` : undefined,
    });

    return { success: failed === 0, total: files.length, copied, failed, task };
  }

  async listFolders(projectId: string, user: RequestUser): Promise<string[]> {
    await this.projectAccessService.assertProjectAccess(user, projectId);
    return this.listFoldersByProject(projectId);
  }

  async listFoldersForProject(projectId: string): Promise<string[]> {
    return this.listFoldersByProject(projectId);
  }

  async listFolderTreeForProject(
    projectId: string,
  ): Promise<Array<{ name: string; path: string; fileCount: number; children: unknown[] }>> {
    return this.buildFolderTree(projectId);
  }

  async searchForProject(
    projectId: string,
    keyword: string,
    options?: { page?: number; pageSize?: number },
  ) {
    // Open API is already scoped to the signed project.
    return this.search(
      projectId,
      keyword,
      { id: 'open-api', username: 'open-api', displayName: 'Open API', role: UserRole.SUPER_ADMIN, totpEnabled: false },
      options,
    );
  }

  async listFolderTree(
    projectId: string,
    user: RequestUser,
  ): Promise<Array<{ name: string; path: string; fileCount: number; children: unknown[] }>> {
    await this.projectAccessService.assertProjectAccess(user, projectId);
    return this.buildFolderTree(projectId);
  }

  private async buildFolderTree(
    projectId: string,
  ): Promise<Array<{ name: string; path: string; fileCount: number; children: unknown[] }>> {
    const paths = await this.listFoldersByProject(projectId);
    const fileCounts = await this.prisma.managedFile.groupBy({
      by: ['folderPath'],
      where: { projectId, status: FileStatus.ACTIVE },
      _count: { _all: true },
    });
    const countMap = new Map(
      fileCounts.map((row) => [row.folderPath ?? '', row._count._all] as const),
    );

    type Node = { name: string; path: string; fileCount: number; children: Node[] };
    const root: Node[] = [];
    const index = new Map<string, Node>();

    const ensure = (path: string): Node => {
      const existing = index.get(path);
      if (existing) {
        return existing;
      }
      const segments = path.split('/').filter(Boolean);
      const name = segments[segments.length - 1] || path;
      const node: Node = { name, path, fileCount: countMap.get(path) ?? 0, children: [] };
      index.set(path, node);
      if (segments.length <= 1) {
        root.push(node);
      } else {
        const parentPath = segments.slice(0, -1).join('/');
        ensure(parentPath).children.push(node);
      }
      return node;
    };

    for (const path of paths) {
      ensure(path);
    }

    // Include intermediate parents that only exist as prefixes.
    for (const path of [...index.keys()]) {
      const segments = path.split('/').filter(Boolean);
      for (let i = 1; i < segments.length; i += 1) {
        ensure(segments.slice(0, i).join('/'));
      }
    }

    const sortTree = (nodes: Node[]): Node[] => {
      nodes.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
      for (const node of nodes) {
        sortTree(node.children);
      }
      return nodes;
    };

    return sortTree(root);
  }

  async listFoldersByProject(projectId: string): Promise<string[]> {
    const folders = await this.prisma.managedFile.findMany({
      where: {
        projectId,
        status: { not: FileStatus.DELETED },
        folderPath: { not: null },
      },
      select: { folderPath: true },
      distinct: ['folderPath'],
      orderBy: { folderPath: 'asc' },
    });

    return folders.map((item) => item.folderPath).filter((value): value is string => Boolean(value));
  }

  /**
   * Enforce project storage quotas.
   * - create: charge full incomingBytes + 1 file
   * - replace: charge max(0, incoming - previous) bytes only (no file count)
   * - reuse: no charge (existing ACTIVE file is shared)
   */
  async assertProjectQuota(
    projectId: string,
    incomingBytes: number,
    actorId?: string,
    options?: { mode?: 'create' | 'replace' | 'reuse'; previousBytes?: number },
  ): Promise<void> {
    const mode = options?.mode ?? 'create';
    if (mode === 'reuse') {
      return;
    }

    const chargeBytes =
      mode === 'replace'
        ? Math.max(0, Math.floor(Number(incomingBytes) || 0) - Math.max(0, Math.floor(Number(options?.previousBytes) || 0)))
        : Math.max(0, Math.floor(Number(incomingBytes) || 0));
    const chargeFiles = mode === 'create' ? 1 : 0;

    if (chargeBytes === 0 && chargeFiles === 0) {
      return;
    }

    const project = await this.prisma.project.findFirst({
      where: { id: projectId, deletedAt: null },
      select: { id: true, name: true, quotaBytes: true, quotaFiles: true },
    });
    if (!project) {
      throw new NotFoundException('项目不存在。');
    }

    if (project.quotaFiles == null && project.quotaBytes == null) {
      return;
    }

    // Lock the project row when quotas are configured so concurrent uploads cannot race past limits.
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM Project WHERE id = ${projectId} FOR UPDATE`;

      if (project.quotaFiles != null && chargeFiles > 0) {
        const fileCount = await tx.managedFile.count({
          where: { projectId, status: FileStatus.ACTIVE },
        });
        if (fileCount + chargeFiles > project.quotaFiles) {
          this.eventBus.emit(DOMAIN_EVENTS.QUOTA_EXCEEDED, {
            projectId,
            projectName: project.name,
            kind: 'files',
            used: fileCount,
            quota: project.quotaFiles,
            actorId,
          });
          throw new ForbiddenException(
            `项目文件数量已达配额上限（${fileCount}/${project.quotaFiles}）。`,
          );
        }
      }

      if (project.quotaBytes != null && chargeBytes > 0) {
        const used = await tx.managedFile.aggregate({
          where: { projectId, status: FileStatus.ACTIVE },
          _sum: { size: true },
        });
        const usedBytes = Number(used._sum.size ?? 0);
        if (usedBytes + chargeBytes > Number(project.quotaBytes)) {
          this.eventBus.emit(DOMAIN_EVENTS.QUOTA_EXCEEDED, {
            projectId,
            projectName: project.name,
            kind: 'bytes',
            used: usedBytes,
            quota: Number(project.quotaBytes),
            actorId,
          });
          throw new ForbiddenException(
            `项目存储空间已达配额上限（已用 ${usedBytes} 字节 / 上限 ${Number(project.quotaBytes)} 字节）。`,
          );
        }
      }
    });
  }

  async getDownloadTarget(
    fileId: string,
    user: RequestUser,
    range?: { start?: number; end?: number },
  ) {
    const file = await this.findFileForUser(fileId, user);

    if (file.status !== FileStatus.ACTIVE) {
      throw new NotFoundException('文件不可下载。');
    }

    await this.auditService.write({
      action: AuditAction.FILE_DOWNLOAD,
      actorId: user.id,
      projectId: file.projectId,
      detail: { fileId },
    });

    return {
      file,
      size: Number(file.size),
      target: await this.storageService.getDownloadTarget(file, undefined, range, {
        preferRedirect: !range,
      }),
    };
  }

  async getDownloadTargetForProject(
    fileId: string,
    projectId: string,
    range?: { start?: number; end?: number },
  ) {
    const file = await this.prisma.managedFile.findFirst({
      where: { id: fileId, projectId, status: FileStatus.ACTIVE },
      include: { cdnConfig: true },
    });

    if (!file) {
      throw new NotFoundException('文件不存在。');
    }

    await this.auditService.write({
      action: AuditAction.FILE_DOWNLOAD,
      projectId,
      detail: { fileId, source: 'open-api' },
    });

    return {
      file,
      size: Number(file.size),
      target: await this.storageService.getDownloadTarget(file, undefined, range, {
        preferRedirect: !range,
      }),
    };
  }

  async recycleForProject(fileId: string, projectId: string): Promise<{ success: boolean }> {
    const file = await this.findFileForProject(fileId, projectId);
    const now = new Date();
    const retentionDays = await this.settingsService.getRecycleRetentionDays();
    const purgeAt = new Date(now.getTime() + retentionDays * 24 * 60 * 60 * 1000);

    await this.prisma.managedFile.update({
      where: { id: fileId },
      data: { status: FileStatus.RECYCLED, deletedAt: now, purgeAt },
    });
    const disabledShareCount = await this.disableFileShareLinks(fileId);
    await this.auditService.write({
      action: AuditAction.FILE_DELETE,
      projectId,
      detail: { fileId: file.id, disabledShareCount, source: 'open-api' },
    });

    this.eventBus.emit(DOMAIN_EVENTS.FILE_DELETED, {
      projectId,
      fileId: file.id,
      originalName: file.originalName,
    });

    return { success: true };
  }

  async restoreForProject(fileId: string, projectId: string): Promise<Record<string, unknown>> {
    await this.findFileForProject(fileId, projectId);
    const restored = await this.prisma.managedFile.update({
      where: { id: fileId },
      data: { status: FileStatus.ACTIVE, deletedAt: null, purgeAt: null },
      include: { cdnConfig: true },
    });
    await this.auditService.write({
      action: AuditAction.FILE_RESTORE,
      projectId,
      detail: { fileId, source: 'open-api' },
    });

    this.eventBus.emit(DOMAIN_EVENTS.FILE_RESTORED, {
      projectId,
      fileId,
      originalName: restored.originalName,
    });

    return this.toResponse(restored);
  }

  async listVersionsForProject(fileId: string, projectId: string) {
    await this.findFileForProject(fileId, projectId);
    const rows = await this.prisma.fileVersion.findMany({
      where: { fileId },
      orderBy: { version: 'desc' },
    });
    return rows.map((row) => ({
      id: row.id,
      version: row.version,
      size: Number(row.size),
      originalName: row.originalName,
      mimeType: row.mimeType,
      checksum: row.checksum,
      createdAt: row.createdAt,
      remark: row.remark,
    }));
  }

  async restoreVersionForProject(
    fileId: string,
    version: number,
    projectId: string,
  ): Promise<Record<string, unknown>> {
    const file = await this.findFileForProject(fileId, projectId);
    if (!Number.isFinite(version) || version < 1) {
      throw new BadRequestException('版本号无效。');
    }
    const snapshot = await this.prisma.fileVersion.findUnique({
      where: { fileId_version: { fileId, version } },
    });
    if (!snapshot) {
      throw new NotFoundException('历史版本不存在。');
    }

    // Snapshot current HEAD before restoring.
    await this.snapshotCurrentVersion(file, undefined, 'restore-precheck');

    const updated = await this.prisma.managedFile.update({
      where: { id: fileId },
      data: {
        storageKey: snapshot.storageKey,
        cdnConfigId: snapshot.cdnConfigId,
        size: snapshot.size,
        checksum: snapshot.checksum,
        mimeType: snapshot.mimeType,
        originalName: snapshot.originalName,
        currentVersion: snapshot.version,
      },
      include: { cdnConfig: true },
    });

    await this.auditService.write({
      action: AuditAction.FILE_VERSION_RESTORE,
      projectId,
      detail: { fileId, version, source: 'open-api' },
    });

    this.eventBus.emit(DOMAIN_EVENTS.FILE_UPDATED, {
      projectId,
      fileId,
      originalName: updated.originalName,
    });

    return this.toResponse(updated);
  }

  async batchRecycleForProject(
    fileIds: string[],
    projectId: string,
  ): Promise<Record<string, unknown>> {
    const files = await this.findFilesForProject(fileIds, projectId);
    if (files.some((file) => file.status !== FileStatus.ACTIVE)) {
      throw new BadRequestException('只能批量删除有效文件。');
    }

    const now = new Date();
    const retentionDays = await this.settingsService.getRecycleRetentionDays();
    const purgeAt = new Date(now.getTime() + retentionDays * 24 * 60 * 60 * 1000);

    await this.prisma.managedFile.updateMany({
      where: { id: { in: files.map((file) => file.id) }, status: FileStatus.ACTIVE, projectId },
      data: { status: FileStatus.RECYCLED, deletedAt: now, purgeAt },
    });
    const disabledShareCount = await this.disableFileShareLinks(files.map((file) => file.id));

    await this.auditService.write({
      action: AuditAction.FILE_BATCH_DELETE,
      projectId,
      detail: {
        fileIds: files.map((file) => file.id),
        total: files.length,
        disabledShareCount,
        source: 'open-api',
      },
    });
    for (const file of files) {
      this.eventBus.emit(DOMAIN_EVENTS.FILE_DELETED, {
        projectId,
        fileId: file.id,
        originalName: file.originalName,
      });
    }

    return { success: true, total: files.length, disabledShareCount };
  }

  async batchRestoreForProject(
    fileIds: string[],
    projectId: string,
  ): Promise<Record<string, unknown>> {
    const files = await this.findFilesForProject(fileIds, projectId);
    if (files.some((file) => file.status !== FileStatus.RECYCLED)) {
      throw new BadRequestException('只能批量恢复回收站中的文件。');
    }

    await this.prisma.managedFile.updateMany({
      where: { id: { in: files.map((file) => file.id) }, status: FileStatus.RECYCLED, projectId },
      data: { status: FileStatus.ACTIVE, deletedAt: null, purgeAt: null },
    });

    await this.auditService.write({
      action: AuditAction.FILE_BATCH_RESTORE,
      projectId,
      detail: {
        fileIds: files.map((file) => file.id),
        total: files.length,
        source: 'open-api',
      },
    });
    for (const file of files) {
      this.eventBus.emit(DOMAIN_EVENTS.FILE_RESTORED, {
        projectId,
        fileId: file.id,
        originalName: file.originalName,
      });
    }

    return { success: true, total: files.length };
  }

  /**
   * Project storage quota + current ACTIVE usage for open-API callers.
   */
  async getUsageForProject(projectId: string): Promise<Record<string, unknown>> {
    const [project, sizeStats] = await Promise.all([
      this.prisma.project.findFirst({
        where: { id: projectId, deletedAt: null },
        select: { id: true, name: true, quotaBytes: true, quotaFiles: true },
      }),
      this.prisma.managedFile.aggregate({
        where: { projectId, status: FileStatus.ACTIVE },
        _count: { _all: true },
        _sum: { size: true },
      }),
    ]);

    if (!project) {
      throw new NotFoundException('项目不存在。');
    }

    const usedBytes = Number(sizeStats._sum.size ?? 0n);
    const usedFiles = sizeStats._count._all;
    const quotaBytes = project.quotaBytes == null ? null : Number(project.quotaBytes);
    const quotaFiles = project.quotaFiles ?? null;

    return {
      projectId: project.id,
      projectName: project.name,
      usedBytes,
      usedFiles,
      quotaBytes,
      quotaFiles,
      bytesUsagePercent:
        quotaBytes && quotaBytes > 0 ? Math.min(100, Math.round((usedBytes / quotaBytes) * 1000) / 10) : null,
      filesUsagePercent:
        quotaFiles && quotaFiles > 0 ? Math.min(100, Math.round((usedFiles / quotaFiles) * 1000) / 10) : null,
    };
  }

  async migrateLocalFiles(projectId: string, user: RequestUser): Promise<LocalFileMigrationSummary> {
    await this.projectAccessService.assertProjectAccess(user, projectId, true);
    const targetStorage = await this.storageService.getActiveStorage(projectId);

    if (targetStorage.provider === CdnProvider.LOCAL) {
      throw new BadRequestException('当前项目启用的仍是本地存储，请先启用七牛、又拍云或阿里云存储。');
    }

    const files = await this.prisma.managedFile.findMany({
      where: {
        projectId,
        status: { not: FileStatus.DELETED },
      },
      include: { cdnConfig: true },
      orderBy: { createdAt: 'asc' },
    });
    const localFiles = files.filter((file) => file.cdnConfig?.provider === CdnProvider.LOCAL);
    const uploadLimits = await this.settingsService.getUploadLimits();
    const summary: LocalFileMigrationSummary = {
      projectId,
      targetConfigId: targetStorage.id,
      targetProvider: targetStorage.provider,
      scanned: localFiles.length,
      migrated: 0,
      skipped: 0,
      failed: 0,
      failures: [],
    };

    for (const file of localFiles) {
      try {
        if (file.size > BigInt(uploadLimits.maxFileSizeBytes)) {
          throw new BadRequestException(`文件超过当前单文件上限 ${uploadLimits.maxFileSizeMb} MB。`);
        }

        const migrationResult = await this.storageService.migrateLocalFileToActiveStorage(file);
        await this.prisma.managedFile.update({
          where: { id: file.id },
          data: {
            cdnConfigId: migrationResult.cdnConfigId,
            storageKey: migrationResult.storageKey,
            publicUrl: migrationResult.publicUrl ?? null,
          },
        });
        summary.migrated += 1;
      } catch (error) {
        summary.failed += 1;
        summary.failures.push({
          fileId: file.id,
          originalName: file.originalName,
          reason: error instanceof Error && error.message ? error.message : '迁移失败',
        });
      }
    }

    await this.tasksService.create({
      type: 'LOCAL_FILE_MIGRATION',
      title: '迁移本地文件到当前存储',
      actorId: user.id,
      projectId,
      status: summary.failed > 0 ? 'FAILED' : 'COMPLETED',
      result: summary as unknown as Prisma.InputJsonObject,
      error: summary.failed > 0 ? `${summary.failed} 个文件迁移失败` : undefined,
    });

    return summary;
  }

  async getPublicDownloadTarget(
    fileId: string,
    expires?: number,
    signature?: string,
    range?: { start?: number; end?: number },
  ) {
    const hasSignature = expires !== undefined || signature !== undefined;
    const signatureValid =
      hasSignature &&
      Boolean(expires) &&
      Boolean(signature) &&
      this.storageService.verifyPublicAccess(fileId, Number(expires), String(signature));

    if (hasSignature && !signatureValid) {
      throw new BadRequestException('文件访问链接已过期或签名无效。');
    }

    const file = await this.prisma.managedFile.findFirst({
      where: {
        id: fileId,
        status: FileStatus.ACTIVE,
        project: { deletedAt: null, enabled: true },
      },
      include: {
        cdnConfig: true,
        project: { select: { allowedDomains: true, publicLibraryEnabled: true } },
      },
    });

    if (!file) {
      throw new NotFoundException('文件不存在。');
    }

    // Access model for /api/public/files/:id (enforced in PublicFilesController):
    // - isPublic / folder-public: open to any domain, publicly cacheable
    // - valid signed temporary link: allowed regardless of domain
    // - otherwise: only project/global authorized domains with Origin or Referer
    //   (missing both headers is denied — no curl/direct bypass)
    const publicByFolder = file.isPublic
      ? true
      : await this.folderPublicService.isPublicByFolderPolicy(file.projectId, file.folderPath);
    const isOpenPublic = Boolean(file.isPublic || publicByFolder);

    return {
      file,
      allowedDomains: normalizeDomainAllowlist(file.project.allowedDomains),
      isOpenPublic,
      signatureValid,
      // Full-body public GET prefers CDN 302; Range/transform callers re-fetch as stream.
      target: await this.storageService.getDownloadTarget(file, undefined, range, {
        preferRedirect: !range,
      }),
    };
  }

  async getReadyThumbDerivative(fileId: string): Promise<{
    storageKey: string;
    mimeType: string;
    size: number;
    publicUrl: string | null;
  } | null> {
    const derivative = await this.prisma.fileDerivative.findUnique({
      where: { fileId_kind: { fileId, kind: DerivativeKind.THUMB } },
      select: {
        storageKey: true,
        mimeType: true,
        size: true,
        publicUrl: true,
        status: true,
      },
    });

    if (!derivative || derivative.status !== DerivativeStatus.READY || !derivative.storageKey) {
      return null;
    }

    return {
      storageKey: derivative.storageKey,
      mimeType: derivative.mimeType || 'image/webp',
      size: Number(derivative.size),
      publicUrl: derivative.publicUrl,
    };
  }

  async listArchiveFiles(fileIds: string[], user: RequestUser): Promise<FileWithStorage[]> {
    const files = await this.prisma.managedFile.findMany({
      where: { id: { in: fileIds }, status: FileStatus.ACTIVE },
      include: { cdnConfig: true },
      orderBy: { createdAt: 'asc' },
    });

    if (files.length !== fileIds.length) {
      throw new NotFoundException('部分文件不存在或不可下载。');
    }

    const projectIds = new Set(files.map((file) => file.projectId));
    for (const projectId of projectIds) {
      await this.projectAccessService.assertProjectAccess(user, projectId);
    }

    return files;
  }

  async recycle(fileId: string, user: RequestUser): Promise<{ success: boolean }> {
    const file = await this.findFileForUser(fileId, user, true);
    if (file.status !== FileStatus.ACTIVE) {
      throw new BadRequestException('只能删除有效文件。');
    }

    const now = new Date();
    const retentionDays = await this.settingsService.getRecycleRetentionDays();
    const purgeAt = new Date(now.getTime() + retentionDays * 24 * 60 * 60 * 1000);

    await this.prisma.managedFile.update({
      where: { id: fileId },
      data: { status: FileStatus.RECYCLED, deletedAt: now, purgeAt },
    });
    const disabledShareCount = await this.disableFileShareLinks(fileId);

    await this.auditService.write({
      action: AuditAction.FILE_DELETE,
      actorId: user.id,
      projectId: file.projectId,
      detail: { fileId, disabledShareCount },
    });

    this.eventBus.emit(DOMAIN_EVENTS.FILE_DELETED, {
      projectId: file.projectId,
      fileId,
      originalName: file.originalName,
      actorId: user.id,
    });

    return { success: true };
  }

  async restore(fileId: string, user: RequestUser): Promise<Record<string, unknown>> {
    const file = await this.findFileForUser(fileId, user, true);
    if (file.status !== FileStatus.RECYCLED) {
      throw new BadRequestException('只能恢复回收站中的文件。');
    }

    const restored = await this.prisma.managedFile.update({
      where: { id: fileId },
      data: { status: FileStatus.ACTIVE, deletedAt: null, purgeAt: null },
      include: { cdnConfig: true },
    });

    await this.auditService.write({
      action: AuditAction.FILE_RESTORE,
      actorId: user.id,
      projectId: file.projectId,
      detail: { fileId },
    });

    this.eventBus.emit(DOMAIN_EVENTS.FILE_RESTORED, {
      projectId: file.projectId,
      fileId,
      originalName: restored.originalName,
      actorId: user.id,
    });

    return this.toResponse(restored);
  }

  async purge(fileId: string, user: RequestUser): Promise<{ success: boolean }> {
    const file = await this.findFileForUser(fileId, user, true);
    if (file.status !== FileStatus.RECYCLED) {
      throw new BadRequestException('只能彻底删除回收站中的文件。');
    }

    await this.purgeFile(file, user.id);

    return { success: true };
  }

  async listVersions(fileId: string, user: RequestUser) {
    await this.findFileForUser(fileId, user);
    const rows = await this.prisma.fileVersion.findMany({
      where: { fileId },
      orderBy: { version: 'desc' },
    });
    return rows.map((row) => ({
      id: row.id,
      version: row.version,
      size: Number(row.size),
      originalName: row.originalName,
      mimeType: row.mimeType,
      checksum: row.checksum,
      createdAt: row.createdAt,
      remark: row.remark,
    }));
  }

  async restoreVersion(fileId: string, version: number, user: RequestUser) {
    const file = await this.findFileForUser(fileId, user, true);
    if (!Number.isFinite(version) || version < 1) {
      throw new BadRequestException('版本号无效。');
    }
    const snapshot = await this.prisma.fileVersion.findUnique({
      where: { fileId_version: { fileId, version } },
    });
    if (!snapshot) {
      throw new NotFoundException('历史版本不存在。');
    }

    // Snapshot current HEAD before restoring.
    await this.snapshotCurrentVersion(file, user.id, 'restore-precheck');

    const updated = await this.prisma.managedFile.update({
      where: { id: fileId },
      data: {
        storageKey: snapshot.storageKey,
        cdnConfigId: snapshot.cdnConfigId,
        size: snapshot.size,
        checksum: snapshot.checksum,
        mimeType: snapshot.mimeType,
        originalName: snapshot.originalName,
        currentVersion: snapshot.version,
      },
      include: { cdnConfig: true },
    });

    await this.auditService.write({
      action: AuditAction.FILE_VERSION_RESTORE,
      actorId: user.id,
      projectId: file.projectId,
      detail: { fileId, version },
    });

    this.eventBus.emit(DOMAIN_EVENTS.FILE_UPDATED, {
      projectId: file.projectId,
      fileId,
      originalName: updated.originalName,
      actorId: user.id,
    });

    return this.toResponse(updated);
  }

  async snapshotCurrentVersion(
    file: Pick<
      ManagedFile,
      | 'id'
      | 'projectId'
      | 'storageKey'
      | 'cdnConfigId'
      | 'size'
      | 'checksum'
      | 'mimeType'
      | 'originalName'
      | 'currentVersion'
    >,
    actorId?: string,
    remark?: string,
  ): Promise<void> {
    const version = Math.max(1, Number(file.currentVersion || 1));
    await this.prisma.fileVersion.upsert({
      where: { fileId_version: { fileId: file.id, version } },
      create: {
        fileId: file.id,
        version,
        storageKey: file.storageKey,
        cdnConfigId: file.cdnConfigId,
        size: file.size,
        checksum: file.checksum,
        mimeType: file.mimeType,
        originalName: file.originalName,
        createdById: actorId,
        remark: remark?.slice(0, 256),
      },
      update: {},
    });
    await this.auditService.write({
      action: AuditAction.FILE_VERSION_CREATE,
      actorId,
      projectId: file.projectId,
      detail: { fileId: file.id, version },
    });
  }

  async batchRecycle(dto: BatchFileOperationDto, user: RequestUser): Promise<Record<string, unknown>> {
    const files = await this.findFilesForUser(dto.fileIds, user, true);
    if (files.some((file) => file.status !== FileStatus.ACTIVE)) {
      throw new BadRequestException('只能批量删除有效文件。');
    }

    const now = new Date();
    const retentionDays = await this.settingsService.getRecycleRetentionDays();
    const purgeAt = new Date(now.getTime() + retentionDays * 24 * 60 * 60 * 1000);

    await this.prisma.managedFile.updateMany({
      where: { id: { in: files.map((file) => file.id) }, status: FileStatus.ACTIVE },
      data: { status: FileStatus.RECYCLED, deletedAt: now, purgeAt },
    });
    const disabledShareCount = await this.disableFileShareLinks(files.map((file) => file.id));

    await this.writeBatchAudit(AuditAction.FILE_BATCH_DELETE, files, user.id, { disabledShareCount });
    for (const file of files) {
      this.eventBus.emit(DOMAIN_EVENTS.FILE_DELETED, {
        projectId: file.projectId,
        fileId: file.id,
        originalName: file.originalName,
        actorId: user.id,
      });
    }
    const task = await this.tasksService.create({
      type: 'FILE_BATCH_DELETE',
      title: '批量移入回收站',
      actorId: user.id,
      projectId: this.singleProjectId(files),
      result: { total: files.length, disabledShareCount },
    });

    return { success: true, total: files.length, task };
  }

  async batchRestore(dto: BatchFileOperationDto, user: RequestUser): Promise<Record<string, unknown>> {
    const files = await this.findFilesForUser(dto.fileIds, user, true);
    if (files.some((file) => file.status !== FileStatus.RECYCLED)) {
      throw new BadRequestException('只能批量恢复回收站中的文件。');
    }

    await this.prisma.managedFile.updateMany({
      where: { id: { in: files.map((file) => file.id) }, status: FileStatus.RECYCLED },
      data: { status: FileStatus.ACTIVE, deletedAt: null, purgeAt: null },
    });

    await this.writeBatchAudit(AuditAction.FILE_BATCH_RESTORE, files, user.id);
    for (const file of files) {
      this.eventBus.emit(DOMAIN_EVENTS.FILE_RESTORED, {
        projectId: file.projectId,
        fileId: file.id,
        originalName: file.originalName,
        actorId: user.id,
      });
    }
    const task = await this.tasksService.create({
      type: 'FILE_BATCH_RESTORE',
      title: '批量恢复文件',
      actorId: user.id,
      projectId: this.singleProjectId(files),
      result: { total: files.length },
    });

    return { success: true, total: files.length, task };
  }

  async batchPurge(dto: BatchFileOperationDto, user: RequestUser): Promise<Record<string, unknown>> {
    const files = await this.findFilesForUser(dto.fileIds, user, true);
    if (files.some((file) => file.status !== FileStatus.RECYCLED)) {
      throw new BadRequestException('只能批量彻底删除回收站中的文件。');
    }

    let purged = 0;
    let failed = 0;

    for (const file of files) {
      try {
        await this.purgeFile(file, user.id, 'batch');
        purged += 1;
      } catch {
        failed += 1;
      }
    }

    await this.writeBatchAudit(AuditAction.FILE_BATCH_PURGE, files, user.id, { purged, failed });
    const task = await this.tasksService.create({
      type: 'FILE_BATCH_PURGE',
      title: '批量彻底删除文件',
      actorId: user.id,
      projectId: this.singleProjectId(files),
      status: failed > 0 ? 'FAILED' : 'COMPLETED',
      result: { total: files.length, purged, failed },
      error: failed > 0 ? `${failed} 个文件删除失败` : undefined,
    });

    return { success: failed === 0, total: files.length, purged, failed, task };
  }

  async createShareLink(
    fileId: string,
    dto: CreateShareLinkDto,
    user: RequestUser,
    publicBaseUrl?: string,
  ): Promise<Record<string, unknown>> {
    const file = await this.findFileForUser(fileId, user);

    if (file.status !== FileStatus.ACTIVE) {
      throw new BadRequestException('只能分享有效文件。');
    }

    const token = randomBytes(24).toString('hex');
    const customPath = await this.resolveShareCustomPath(dto.customPath);
    const share = await this.prisma.shareLink.create({
      data: {
        fileId,
        token,
        customPath,
        passwordHash: dto.password ? await bcrypt.hash(dto.password, 10) : null,
        expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
        maxDownloads: dto.maxDownloads,
        previewOnly: dto.previewOnly ?? false,
        allowedIps: sanitizeIpAllowlist(dto.allowedIps ?? []),
        watermarkText: this.emptyToNull(dto.watermarkText ?? ''),
      },
      include: { file: { include: { cdnConfig: true } } },
    });

    await this.auditService.write({
      action: AuditAction.FILE_SHARE_CREATE,
      actorId: user.id,
      projectId: file.projectId,
      detail: { fileId, shareId: share.id, expiresAt: dto.expiresAt, maxDownloads: dto.maxDownloads, customPath },
    });

    return this.toShareResponse(share, publicBaseUrl);
  }

  async createShareLinkForProject(
    fileId: string,
    projectId: string,
    dto: CreateShareLinkDto,
    publicBaseUrl?: string,
  ): Promise<Record<string, unknown>> {
    const file = await this.findFileForProject(fileId, projectId);

    if (file.status !== FileStatus.ACTIVE) {
      throw new BadRequestException('只能分享有效文件。');
    }

    const token = randomBytes(24).toString('hex');
    const customPath = await this.resolveShareCustomPath(dto.customPath);
    const share = await this.prisma.shareLink.create({
      data: {
        fileId,
        token,
        customPath,
        passwordHash: dto.password ? await bcrypt.hash(dto.password, 10) : null,
        expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
        maxDownloads: dto.maxDownloads,
        previewOnly: dto.previewOnly ?? false,
        allowedIps: sanitizeIpAllowlist(dto.allowedIps ?? []),
        watermarkText: this.emptyToNull(dto.watermarkText ?? ''),
      },
      include: { file: { include: { cdnConfig: true, project: { select: { id: true, name: true } } } } },
    });

    await this.auditService.write({
      action: AuditAction.FILE_SHARE_CREATE,
      projectId,
      detail: { fileId, shareId: share.id, expiresAt: dto.expiresAt, maxDownloads: dto.maxDownloads, source: 'open-api' },
    });

    return this.toShareResponse(share, publicBaseUrl);
  }

  async listShareLinks(fileId: string, user: RequestUser, publicBaseUrl?: string): Promise<Record<string, unknown>[]> {
    await this.findFileForUser(fileId, user);
    const shares = await this.prisma.shareLink.findMany({
      where: { fileId },
      include: { file: { include: { cdnConfig: true, project: { select: { id: true, name: true } } } } },
      orderBy: { createdAt: 'desc' },
    });

    return shares.map((share) => this.toShareResponse(share, publicBaseUrl));
  }

  async listShareLinksForProject(
    fileId: string,
    projectId: string,
    publicBaseUrl?: string,
  ): Promise<Record<string, unknown>[]> {
    await this.findFileForProject(fileId, projectId);
    const shares = await this.prisma.shareLink.findMany({
      where: { fileId },
      include: { file: { include: { cdnConfig: true, project: { select: { id: true, name: true } } } } },
      orderBy: { createdAt: 'desc' },
    });

    return shares.map((share) => this.toShareResponse(share, publicBaseUrl));
  }

  async listAllShareLinks(
    query: ListShareLinksDto,
    user: RequestUser,
    publicBaseUrl?: string,
  ): Promise<{
    items: Record<string, unknown>[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    if (query.projectId) {
      await this.projectAccessService.assertProjectAccess(user, query.projectId);
    }

    const requestedPage = Math.max(1, Number(query.page ?? 1) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(query.pageSize ?? 20) || 20));
    const keyword = query.keyword?.trim();
    const where: Prisma.ShareLinkWhereInput = {
      ...(keyword
        ? {
            OR: [
              { token: { contains: keyword } },
              { customPath: { contains: keyword } },
              { file: { is: { originalName: { contains: keyword } } } },
            ],
          }
        : {}),
      ...this.shareStatusWhere(query.status),
      file: {
        is: {
          ...(query.projectId ? { projectId: query.projectId } : this.accessibleProjectWhere(user)),
          status: FileStatus.ACTIVE,
        },
      },
    };
    const total = await this.prisma.shareLink.count({ where });
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(requestedPage, totalPages);
    const shares = await this.prisma.shareLink.findMany({
      where,
      include: { file: { include: { cdnConfig: true, project: { select: { id: true, name: true } } } } },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });

    return {
      items: shares.map((share) => this.toShareResponse(share, publicBaseUrl)),
      total,
      page,
      pageSize,
    };
  }

  async disableShareLink(shareId: string, user: RequestUser): Promise<{ success: boolean }> {
    const share = await this.prisma.shareLink.findUnique({
      where: { id: shareId },
      include: { file: { include: { cdnConfig: true } } },
    });

    if (!share) {
      throw new NotFoundException('分享链接不存在。');
    }

    await this.projectAccessService.assertProjectAccess(user, share.file.projectId, true);
    await this.prisma.shareLink.update({
      where: { id: shareId },
      data: { enabled: false },
    });

    await this.auditService.write({
      action: AuditAction.FILE_SHARE_DELETE,
      actorId: user.id,
      projectId: share.file.projectId,
      detail: { fileId: share.fileId, shareId },
    });

    return { success: true };
  }

  async updateShareLink(
    shareId: string,
    dto: UpdateShareLinkDto,
    user: RequestUser,
    publicBaseUrl?: string,
  ): Promise<Record<string, unknown>> {
    const share = await this.prisma.shareLink.findUnique({
      where: { id: shareId },
      include: { file: { include: { cdnConfig: true } } },
    });

    if (!share) {
      throw new NotFoundException('分享链接不存在。');
    }

    await this.projectAccessService.assertProjectAccess(user, share.file.projectId, true);
    const customPath =
      dto.customPath === undefined
        ? undefined
        : await this.resolveShareCustomPath(dto.customPath, shareId);
    const updated = await this.prisma.shareLink.update({
      where: { id: shareId },
      data: {
        passwordHash: dto.clearPassword ? null : dto.password ? await bcrypt.hash(dto.password, 10) : undefined,
        expiresAt: dto.expiresAt === undefined ? undefined : dto.expiresAt ? new Date(dto.expiresAt) : null,
        maxDownloads: dto.maxDownloads === undefined ? undefined : dto.maxDownloads,
        enabled: dto.enabled,
        previewOnly: dto.previewOnly,
        allowedIps: dto.allowedIps === undefined ? undefined : sanitizeIpAllowlist(dto.allowedIps),
        watermarkText: dto.watermarkText === undefined ? undefined : this.emptyToNull(dto.watermarkText),
        customPath,
      },
      include: { file: { include: { cdnConfig: true } } },
    });

    await this.auditService.write({
      action: AuditAction.FILE_SHARE_UPDATE,
      actorId: user.id,
      projectId: share.file.projectId,
      detail: {
        fileId: share.fileId,
        shareId,
        source: 'share-update',
        passwordChanged: dto.clearPassword || Boolean(dto.password),
        expiresAt: dto.expiresAt,
        maxDownloads: dto.maxDownloads,
        enabled: dto.enabled,
        customPath,
      },
    });

    return this.toShareResponse(updated, publicBaseUrl);
  }

  async updateShareLinkForProject(
    shareId: string,
    projectId: string,
    dto: UpdateShareLinkDto,
    publicBaseUrl?: string,
  ): Promise<Record<string, unknown>> {
    const share = await this.prisma.shareLink.findFirst({
      where: { id: shareId, file: { projectId } },
      include: { file: { include: { cdnConfig: true, project: { select: { id: true, name: true } } } } },
    });

    if (!share) {
      throw new NotFoundException('分享链接不存在。');
    }

    const customPath =
      dto.customPath === undefined
        ? undefined
        : await this.resolveShareCustomPath(dto.customPath, shareId);
    const updated = await this.prisma.shareLink.update({
      where: { id: shareId },
      data: {
        passwordHash: dto.clearPassword ? null : dto.password ? await bcrypt.hash(dto.password, 10) : undefined,
        expiresAt: dto.expiresAt === undefined ? undefined : dto.expiresAt ? new Date(dto.expiresAt) : null,
        maxDownloads: dto.maxDownloads === undefined ? undefined : dto.maxDownloads,
        enabled: dto.enabled,
        previewOnly: dto.previewOnly,
        allowedIps: dto.allowedIps === undefined ? undefined : sanitizeIpAllowlist(dto.allowedIps),
        watermarkText: dto.watermarkText === undefined ? undefined : this.emptyToNull(dto.watermarkText),
        customPath,
      },
      include: { file: { include: { cdnConfig: true, project: { select: { id: true, name: true } } } } },
    });

    await this.auditService.write({
      action: AuditAction.FILE_SHARE_UPDATE,
      projectId,
      detail: { fileId: share.fileId, shareId, source: 'open-api' },
    });

    return this.toShareResponse(updated, publicBaseUrl);
  }

  async disableShareLinkForProject(shareId: string, projectId: string): Promise<{ success: boolean }> {
    const share = await this.prisma.shareLink.findFirst({
      where: { id: shareId, file: { projectId } },
      include: { file: true },
    });

    if (!share) {
      throw new NotFoundException('分享链接不存在。');
    }

    await this.prisma.shareLink.update({
      where: { id: shareId },
      data: { enabled: false },
    });
    await this.auditService.write({
      action: AuditAction.FILE_SHARE_DELETE,
      projectId,
      detail: { fileId: share.fileId, shareId, source: 'open-api' },
    });

    return { success: true };
  }

  async getPublicShareInfo(tokenOrPath: string): Promise<Record<string, unknown>> {
    const share = await this.findShareByAccessKey(tokenOrPath, {
      include: { file: { include: { cdnConfig: true } } },
    });

    if (!share || !share.enabled || !share.file || share.file.status !== FileStatus.ACTIVE) {
      throw new NotFoundException('分享链接不存在或已失效。');
    }

    if (share.expiresAt && share.expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException('分享链接已过期。');
    }

    const brand = await this.settingsService.getSharePageBrand();

    return {
      token: share.token,
      customPath: share.customPath,
      fileName: share.file.originalName,
      mimeType: share.file.mimeType,
      category: share.file.category,
      size: Number(share.file.size),
      previewable: isPreviewable(share.file.category, share.file.mimeType, share.file.originalName),
      previewOnly: share.previewOnly,
      hasWatermark: Boolean(share.watermarkText),
      hasPassword: Boolean(share.passwordHash),
      expiresAt: share.expiresAt,
      maxDownloads: share.maxDownloads,
      downloadCount: share.downloadCount,
      remainingDownloads:
        share.maxDownloads === null ? null : Math.max(0, share.maxDownloads - share.downloadCount),
      enabled: share.enabled,
      status: this.computeShareStatus(share),
      brand,
    };
  }

  async shareRequiresPassword(tokenOrPath: string): Promise<boolean> {
    const share = await this.findShareByAccessKey(tokenOrPath, {
      select: { enabled: true, passwordHash: true, expiresAt: true, file: { select: { status: true } } },
    });

    if (!share || !share.enabled || !share.file || share.file.status !== FileStatus.ACTIVE) {
      throw new NotFoundException('分享链接不存在或已失效。');
    }

    if (share.expiresAt && share.expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException('分享链接已过期。');
    }

    return Boolean(share.passwordHash);
  }

  async getShareDownloadTarget(
    tokenOrPath: string,
    password?: string,
    meta: {
      countDownload?: boolean;
      ip?: string;
      skipPassword?: boolean;
      /** When true, do not consume IP rate-limit budget (e.g. ticket path already limited at session issue). */
      skipRateLimit?: boolean;
    } = {},
  ) {
    const share = await this.findShareByAccessKey(tokenOrPath, {
      include: { file: { include: { cdnConfig: true } } },
    });

    this.assertShareExists(share);
    if (!share.file) {
      throw new NotFoundException('分享链接不存在或已失效。');
    }
    await this.assertShareUsable(share, share.token, password, meta.ip, meta.skipPassword);
    if (share.previewOnly && meta.countDownload !== false) {
      throw new ForbiddenException('该分享仅允许在线预览，禁止下载。');
    }
    if (meta.countDownload !== false) {
      // Rate-limit real download issuance. Ticket downloads skip here because
      // createShareDownloadSession already counted the same logical click.
      if (!meta.skipRateLimit) {
        await this.assertShareDownloadRateLimit({
          ip: meta.ip,
          shareId: share.id,
          fileId: share.fileId,
          projectId: share.file.projectId,
          originalName: share.file.originalName,
          kind: 'file-share',
        });
      }
      await this.incrementShareDownloadCount(share.id, share.maxDownloads);
      await this.auditService.write({
        action: AuditAction.FILE_SHARE_DOWNLOAD,
        projectId: share.file.projectId,
        detail: { fileId: share.fileId, shareId: share.id },
      });
    } else {
      this.assertShareDownloadAvailable(share.downloadCount, share.maxDownloads);
    }

    return {
      file: share.file,
      // Never 302 to a long-lived CDN URL for share downloads — that bypasses IP rate limits.
      // Always proxy/stream through the API so every hit is counted.
      target: await this.storageService.getDownloadTarget(share.file, 120, undefined, {
        preferRedirect: false,
      }),
      watermarkText: share.watermarkText,
    };
  }

  async createShareDownloadSession(
    tokenOrPath: string,
    password?: string,
    meta: { ip?: string } = {},
  ): Promise<{ url: string; expiresAt: Date }> {
    // Lightweight lookup: only fields needed for access checks (no CDN / stream setup).
    const share = await this.findShareByAccessKey(tokenOrPath, {
      include: {
        file: { select: { id: true, status: true, projectId: true, originalName: true } },
      },
    });
    this.assertShareExists(share);
    await this.assertShareUsable(share, share.token, password, meta.ip);
    if (share.previewOnly) {
      throw new ForbiddenException('该分享仅允许在线预览，禁止下载。');
    }
    this.assertShareDownloadAvailable(share.downloadCount, share.maxDownloads);
    // Rate-limit "getting a download link" so the SPA can surface 429 before iframe/nav.
    await this.assertShareDownloadRateLimit({
      ip: meta.ip,
      shareId: share.id,
      fileId: share.file?.id,
      projectId: share.file?.projectId,
      originalName: share.file?.originalName,
      kind: 'file-share',
    });
    // Short-lived ticket: reduces reuse window if a URL is copied out of DevTools.
    const expiresAt = new Date(Date.now() + 60 * 1000);
    const expires = Math.floor(expiresAt.getTime() / 1000);
    const ticket = this.storageService.signShareAccess(share.token, expires);

    // Use the dedicated download route so browsers stream the file immediately
    // (Content-Disposition: attachment) without buffering in the SPA.
    return {
      url: `/api/shares/${share.token}/download?ticket=${encodeURIComponent(ticket)}&expires=${expires}`,
      expiresAt,
    };
  }

  verifyShareDownloadSession(token: string, expires?: number, ticket?: string): boolean {
    return Boolean(expires && ticket && this.storageService.verifyShareAccess(token, expires, ticket));
  }

  async purgeExpiredRecycledFiles(batchSize = 100): Promise<{ scanned: number; purged: number; failed: number }> {
    const files = await this.prisma.managedFile.findMany({
      where: {
        status: FileStatus.RECYCLED,
        purgeAt: { lte: new Date() },
      },
      include: { cdnConfig: true },
      orderBy: { purgeAt: 'asc' },
      take: batchSize,
    });
    let purged = 0;
    let failed = 0;

    for (const file of files) {
      try {
        await this.purgeFile(file, undefined, 'auto-recycle-cleanup');
        purged += 1;
      } catch (error) {
        failed += 1;
        this.logger.warn(
          `回收站到期清理失败：fileId=${file.id} ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return { scanned: files.length, purged, failed };
  }

  async findFileForUser(fileId: string, user: RequestUser, requireAdmin = false): Promise<FileWithStorage> {
    const file = await this.prisma.managedFile.findUnique({
      where: { id: fileId },
      include: { cdnConfig: true },
    });

    if (!file) {
      throw new NotFoundException('文件不存在。');
    }

    await this.projectAccessService.assertProjectAccess(user, file.projectId, requireAdmin);
    return file;
  }

  private toResponse(file: FileWithStorage): Record<string, unknown> {
    const previewable = isPreviewable(file.category, file.mimeType, file.originalName);
    // Stable fileId-based path for ACTIVE files (overwrite-in-place keeps URL identical).
    // Access is enforced at GET /api/public/files/:id:
    // - isPublic / folder-public: open
    // - else: authorized Origin/Referer domain allowlist, or a signed temporary link
    // Private files must not be fetched without Referer or signature (no empty-header bypass).
    const accessUrl =
      file.status === FileStatus.ACTIVE ? this.storageService.buildPublicAccessUrl(file.id) : null;

    const progressiveUrl = this.resolveVideoDerivativeUrl(file, DerivativeKind.MP4_720, accessUrl);
    const hlsUrl = this.resolveVideoDerivativeUrl(file, DerivativeKind.HLS, accessUrl);

    return {
      id: file.id,
      projectId: file.projectId,
      projectName: file.project?.name ?? null,
      originalName: file.originalName,
      mimeType: file.mimeType,
      extension: file.extension,
      size: Number(file.size),
      category: file.category,
      status: file.status,
      scanStatus: file.scanStatus,
      scanDetail: file.scanDetail,
      scannedAt: file.scannedAt,
      isPublic: file.isPublic,
      checksum: file.checksum,
      publicUrl: accessUrl,
      accessUrl,
      remark: file.remark,
      tags: this.parseTags(file.tags),
      folderPath: file.folderPath,
      // Prefer persisted derivative thumbnail; fall back to access URL for images.
      thumbnailUrl: file.thumbnailUrl
        ? this.storageService.absolutizeIfNeeded(file.thumbnailUrl)
        : file.category === 'IMAGE'
          ? accessUrl
          : null,
      duplicateOfId: file.duplicateOfId,
      duplicate: Boolean(file.duplicateOfId),
      duplicateReused: Boolean(file._duplicateReused),
      currentVersion: Math.max(1, Number(file.currentVersion || 1)),
      previewable,
      progressiveUrl,
      hlsUrl,
      cdnProvider: file.cdnConfig?.provider ?? null,
      createdAt: file.createdAt,
      updatedAt: file.updatedAt,
      deletedAt: file.deletedAt,
      purgeAt: file.purgeAt,
    };
  }

  private resolveVideoDerivativeUrl(
    file: FileWithStorage,
    kind: DerivativeKind,
    accessUrl: string | null,
  ): string | null {
    if (file.category !== FileCategory.VIDEO || file.status !== FileStatus.ACTIVE) {
      return null;
    }
    const ready = file._videoDerivatives?.find(
      (item) => item.kind === kind && item.status === DerivativeStatus.READY && item.storageKey,
    );
    if (!ready) {
      return null;
    }
    // Prefer stored publicUrl (API derivative route or CDN); never fall back to original
    // accessUrl for HLS (m3u8 would be wrong). MP4 can fall back to source as last resort.
    if (ready.publicUrl) {
      return this.storageService.absolutizeIfNeeded(ready.publicUrl);
    }
    if (kind === DerivativeKind.HLS || kind === DerivativeKind.MP4_720) {
      return this.storageService.buildPublicDerivativeUrl(file.id, kind);
    }
    return accessUrl;
  }

  async getPublicDerivativeTarget(
    fileId: string,
    kindRaw: string,
    subPath?: string,
  ): Promise<{
    file: FileWithStorage;
    target: Awaited<ReturnType<StorageService['getDownloadTargetForKey']>>;
    mimeType: string;
    size: number;
  }> {
    const kind = this.parseDerivativeKind(kindRaw);
    const file = await this.prisma.managedFile.findFirst({
      where: {
        id: fileId,
        status: FileStatus.ACTIVE,
        project: { deletedAt: null, enabled: true },
      },
      include: { cdnConfig: true },
    });
    if (!file) {
      throw new NotFoundException('文件不存在。');
    }

    const derivative = await this.prisma.fileDerivative.findUnique({
      where: { fileId_kind: { fileId, kind } },
    });
    if (!derivative || derivative.status !== DerivativeStatus.READY || !derivative.storageKey) {
      throw new NotFoundException('派生资源不存在或未就绪。');
    }

    let storageKey = derivative.storageKey;
    let mimeType = derivative.mimeType || 'application/octet-stream';

    // HLS multi-file: master is storageKey; segments live under the same prefix.
    if (subPath && kind === DerivativeKind.HLS) {
      const cleaned = subPath
        .replace(/\\/g, '/')
        .split('/')
        .filter((part) => part && part !== '.' && part !== '..')
        .join('/');
      if (!cleaned) {
        throw new BadRequestException('派生路径无效。');
      }
      const meta = derivative.meta as { segmentPrefix?: string } | null;
      const prefix =
        meta?.segmentPrefix ||
        derivative.storageKey.replace(/\/[^/]+$/, '');
      storageKey = `${prefix}/${cleaned}`.replace(/\/+/g, '/');
      mimeType = cleaned.endsWith('.m3u8')
        ? 'application/vnd.apple.mpegurl'
        : cleaned.endsWith('.ts')
          ? 'video/mp2t'
          : 'application/octet-stream';
    }

    const target = await this.storageService.getDownloadTargetForKey(file, storageKey);
    return {
      file,
      target,
      mimeType,
      size: Number(derivative.size || 0),
    };
  }

  private parseDerivativeKind(raw: string): DerivativeKind {
    const value = String(raw || '').toUpperCase();
    if (value === 'HLS') return DerivativeKind.HLS;
    if (value === 'MP4_720') return DerivativeKind.MP4_720;
    if (value === 'COVER') return DerivativeKind.COVER;
    if (value === 'THUMB') return DerivativeKind.THUMB;
    throw new BadRequestException('不支持的派生类型。');
  }

  /**
   * Batch-load READY MP4_720 / HLS derivatives onto file objects for toResponse.
   */
  private async attachVideoDerivatives(files: FileWithStorage[]): Promise<void> {
    const videoIds = files
      .filter((file) => file.category === FileCategory.VIDEO && file.status === FileStatus.ACTIVE)
      .map((file) => file.id);
    if (videoIds.length === 0) {
      return;
    }

    const derivatives = await this.prisma.fileDerivative.findMany({
      where: {
        fileId: { in: videoIds },
        kind: { in: [DerivativeKind.MP4_720, DerivativeKind.HLS] },
        status: DerivativeStatus.READY,
      },
      select: {
        fileId: true,
        kind: true,
        status: true,
        publicUrl: true,
        storageKey: true,
      },
    });

    const byFile = new Map<string, FileWithStorage['_videoDerivatives']>();
    for (const row of derivatives) {
      const list = byFile.get(row.fileId) ?? [];
      list.push({
        kind: row.kind,
        status: row.status,
        publicUrl: row.publicUrl,
        storageKey: row.storageKey,
      });
      byFile.set(row.fileId, list);
    }

    for (const file of files) {
      file._videoDerivatives = byFile.get(file.id);
    }
  }

  private accessibleProjectWhere(_user?: RequestUser): Prisma.ManagedFileWhereInput {
    // Single super-admin product: console sessions are SUPER_ADMIN and can see all projects.
    return {
      project: {
        is: {
          deletedAt: null,
          enabled: true,
        },
      },
    };
  }

  private buildStorageKey(projectName: string, originalName: string, folderPath?: string | null): string {
    const date = new Date();
    const year = String(date.getFullYear());
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const safeName = originalName.replace(/[^\w.-]+/g, '_');
    const safeProjectName = this.sanitizeStorageSegment(projectName);
    const safeFolderPath = this.normalizeFolderPath(folderPath)
      ?.split('/')
      .map((segment) => this.sanitizeStorageSegment(segment))
      .join('/');
    const uniquePrefix = randomBytes(8).toString('hex');
    return [safeProjectName, safeFolderPath, year, month, day, `${uniquePrefix}-${safeName}`]
      .filter(Boolean)
      .join('/');
  }

  private sanitizeStorageSegment(value: string): string {
    const normalized = value
      .trim()
      .split('')
      .map((char) => (this.isForbiddenStorageChar(char) ? '_' : char))
      .join('')
      .replace(/\.+$/g, '')
      .slice(0, 128);

    return normalized || 'project';
  }

  private isForbiddenStorageChar(char: string): boolean {
    return char.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(char);
  }

  private async readUploadBuffer(file: Express.Multer.File): Promise<Buffer> {
    if (file.buffer) {
      return file.buffer;
    }

    if (file.path) {
      return readFile(file.path);
    }

    throw new BadRequestException('上传文件内容为空。');
  }

  private async cleanupUploadFiles(files: Express.Multer.File[]): Promise<void> {
    await Promise.all(
      files
        .filter((file) => Boolean(file.path))
        .map(async (file) => {
          try {
            await unlink(file.path);
          } catch {
            // The temp file may already have been removed by the OS or upload middleware.
          }
        }),
    );
  }

  private async purgeFile(file: FileWithStorage, actorId?: string, source?: string): Promise<void> {
    // Remove the stored object on a best-effort basis. A remote provider error
    // (network/auth/already-gone) must not strand the file in the recycle bin —
    // the record is still hard-deleted below so the file leaves every listing.
    let storageRemoved = true;
    let storageError: string | undefined;
    if (file.cdnConfig) {
      try {
        await this.storageService.remove(file.cdnConfig, file.storageKey);
      } catch (error) {
        storageRemoved = false;
        storageError = error instanceof Error && error.message ? error.message : String(error);
        this.logger.warn(`彻底删除时移除存储对象失败：fileId=${file.id} ${storageError}`);
      }
    }

    // Hard-delete the record so the file truly disappears from active and recycle
    // listings. Share links are removed by the ShareLink.fileId cascade; count them
    // first only for the audit detail.
    const disabledShareCount = await this.prisma.shareLink.count({ where: { fileId: file.id } });
    await this.prisma.managedFile.delete({ where: { id: file.id } });

    await this.auditService.write({
      action: AuditAction.FILE_PURGE,
      actorId,
      projectId: file.projectId,
      detail: {
        fileId: file.id,
        disabledShareCount,
        storageRemoved,
        ...(storageError ? { storageError } : {}),
        ...(source ? { source } : {}),
      },
    });

    this.eventBus.emit(DOMAIN_EVENTS.FILE_PURGED, {
      projectId: file.projectId,
      fileId: file.id,
      originalName: file.originalName,
      actorId,
    });
  }

  private async disableFileShareLinks(fileIds: string | string[]): Promise<number> {
    const ids = Array.isArray(fileIds) ? fileIds : [fileIds];
    if (ids.length === 0) {
      return 0;
    }

    const result = await this.prisma.shareLink.updateMany({
      where: { fileId: { in: ids }, enabled: true },
      data: { enabled: false },
    });

    return result.count;
  }

  private async copyFileToProject(
    file: FileWithStorage,
    targetProjectId: string,
    folderPathValue: string | null | undefined,
    actorId: string,
    source: string,
  ): Promise<FileWithStorage> {
    if (file.status !== FileStatus.ACTIVE) {
      throw new BadRequestException('只能复制有效文件。');
    }

    const targetProject = await this.prisma.project.findFirst({
      where: { id: targetProjectId, deletedAt: null, enabled: true },
      select: { name: true },
    });

    if (!targetProject) {
      throw new NotFoundException('目标项目不存在。');
    }

    const uploadLimits = await this.settingsService.getUploadLimits();
    if (file.size > BigInt(uploadLimits.maxFileSizeBytes)) {
      throw new BadRequestException(`文件超过当前单文件上限 ${uploadLimits.maxFileSizeMb} MB，无法复制。`);
    }

    await this.assertProjectQuota(targetProjectId, Number(file.size), actorId, { mode: 'create' });

    const target = await this.storageService.getDownloadTarget(file);
    if (!target.stream) {
      throw new BadRequestException('文件内容不可读取，无法复制。');
    }

    const buffer = await this.readStreamToBuffer(target.stream);
    const folderPath = this.normalizeFolderPath(folderPathValue ?? file.folderPath);
    const storageKey = this.buildStorageKey(targetProject.name, file.originalName, folderPath);
    const uploadResult = await this.storageService.upload(targetProjectId, {
      key: storageKey,
      buffer,
      mimeType: file.mimeType,
      originalName: file.originalName,
    });
    const copied = await this.prisma.managedFile.create({
      data: {
        projectId: targetProjectId,
        cdnConfigId: uploadResult.cdnConfigId,
        originalName: file.originalName,
        storageKey: uploadResult.storageKey,
        mimeType: file.mimeType,
        extension: file.extension,
        size: file.size,
        category: file.category,
        checksum: file.checksum,
        publicUrl: uploadResult.publicUrl,
        remark: file.remark,
        tags: file.tags,
        folderPath,
        thumbnailUrl: file.category === FileCategory.IMAGE ? uploadResult.publicUrl : null,
        scanStatus: 'SKIPPED',
        scannedAt: new Date(),
        scanDetail: null,
        duplicateOfId: file.duplicateOfId || file.id,
        uploadedById: actorId,
      },
      include: { cdnConfig: true, project: { select: { id: true, name: true } } },
    });

    await this.auditService.write({
      action: AuditAction.FILE_COPY,
      actorId,
      projectId: targetProjectId,
      detail: { sourceFileId: file.id, copiedFileId: copied.id, source },
    });

    this.eventBus.emit(DOMAIN_EVENTS.FILE_UPLOADED, {
      projectId: targetProjectId,
      fileId: copied.id,
      originalName: copied.originalName,
      size: Number(copied.size),
      mimeType: copied.mimeType,
      category: copied.category,
      folderPath: copied.folderPath,
      actorId,
    });

    return copied;
  }

  /**
   * Register a file that was already uploaded to storage (e.g. via presigned PUT).
   * Does not re-upload the buffer; creates the ManagedFile row and emits FILE_UPLOADED.
   *
   * When checksum is provided, applies the same content-dedupe policy as buffer upload:
   * - reject (default): throw if an ACTIVE/RECYCLED file with same project+checksum+size exists
   * - reuse: return (or restore) the existing content-matching file
   * - replace: overwrite same project+folder+name in-place (keeps fileId), else fall through
   */
  async registerUploadedObject(params: {
    projectId: string;
    storageKey: string;
    originalName: string;
    mimeType: string;
    size: number;
    folderPath?: string | null;
    publicUrl?: string | null;
    checksum?: string | null;
    actorId?: string;
    cdnConfigId?: string | null;
    duplicateStrategy?: DuplicateStrategy;
  }): Promise<Record<string, unknown>> {
    const project = await this.prisma.project.findFirst({
      where: { id: params.projectId, deletedAt: null, enabled: true },
      select: { id: true, name: true },
    });
    if (!project) {
      throw new NotFoundException('项目不存在。');
    }

    const storageKey = params.storageKey.trim().replace(/\\/g, '/');
    this.assertSafeStorageKey(storageKey, project.name, project.id);

    const originalName = basename(params.originalName.trim());
    if (!originalName) {
      throw new BadRequestException('文件名不能为空。');
    }

    const size = Math.floor(Number(params.size) || 0);
    if (!Number.isFinite(size) || size <= 0) {
      throw new BadRequestException('文件大小无效。');
    }

    const mimeType = (params.mimeType || 'application/octet-stream').slice(0, 128);
    const extension = resolveExtension(originalName);
    const category = resolveFileCategory(originalName, mimeType);
    const folderPath = this.normalizeFolderPath(params.folderPath);
    const checksum = params.checksum?.trim() || null;
    const strategy = params.duplicateStrategy ?? 'reject';
    const publicUrl = params.publicUrl?.trim() || null;

    let cdnConfigId = params.cdnConfigId ?? null;
    if (!cdnConfigId) {
      const active = await this.storageService.getActiveStorage(params.projectId);
      cdnConfigId = active.id;
    }

    // Verify the object actually landed in storage before registering metadata.
    const exists = await this.storageService.objectExists(params.projectId, storageKey, cdnConfigId);
    if (!exists) {
      throw new BadRequestException('存储中未找到已上传对象，请确认直传完成后再调用 complete-presign。');
    }

    // Name-based replace: keep fileId so public URLs / share links stay valid.
    if (strategy === 'replace') {
      const nameMatch =
        (await this.prisma.managedFile.findFirst({
          where: { projectId: params.projectId, originalName, folderPath, status: FileStatus.ACTIVE },
          include: { cdnConfig: true },
          orderBy: { createdAt: 'asc' },
        })) ??
        (await this.prisma.managedFile.findFirst({
          where: { projectId: params.projectId, originalName, folderPath, status: FileStatus.RECYCLED },
          include: { cdnConfig: true },
          orderBy: { createdAt: 'asc' },
        }));

      if (nameMatch) {
        // Content identical — no rewrite needed.
        if (
          nameMatch.status === FileStatus.ACTIVE &&
          checksum &&
          nameMatch.checksum === checksum &&
          nameMatch.size === BigInt(size)
        ) {
          await this.assertProjectQuota(params.projectId, size, params.actorId, { mode: 'reuse' });
          await this.auditService.write({
            action: AuditAction.FILE_UPLOAD,
            actorId: params.actorId,
            projectId: params.projectId,
            detail: {
              fileId: nameMatch.id,
              originalName,
              size,
              replaced: true,
              contentUnchanged: true,
              source: 'presign-complete',
            },
          });
          this.eventBus.emit(DOMAIN_EVENTS.FILE_UPLOADED, {
            projectId: params.projectId,
            fileId: nameMatch.id,
            originalName,
            size,
            mimeType,
            category,
            folderPath,
            actorId: params.actorId,
          });
          return this.toResponse(nameMatch);
        }

        await this.assertProjectQuota(params.projectId, size, params.actorId, {
          mode: 'replace',
          previousBytes: nameMatch.status === FileStatus.ACTIVE ? Number(nameMatch.size) : 0,
        });

        if (nameMatch.status === FileStatus.ACTIVE) {
          await this.snapshotCurrentVersion(nameMatch, params.actorId, 'before-replace');
        }

        const previousCdnConfig = nameMatch.cdnConfig;
        const previousStorageKey = nameMatch.storageKey;

        const updated = await this.prisma.managedFile.update({
          where: { id: nameMatch.id },
          data: {
            cdnConfigId,
            originalName,
            storageKey,
            mimeType,
            extension: extension || nameMatch.extension,
            size: BigInt(size),
            category,
            checksum,
            publicUrl: publicUrl ?? nameMatch.publicUrl,
            folderPath: folderPath ?? nameMatch.folderPath,
            thumbnailUrl: null,
            scanStatus: 'SKIPPED',
            scanDetail: null,
            scannedAt: new Date(),
            status: FileStatus.ACTIVE,
            deletedAt: null,
            purgeAt: null,
            duplicateOfId: null,
            currentVersion: Math.max(1, Number(nameMatch.currentVersion || 1)) + 1,
          },
          include: { cdnConfig: true },
        });

        if (previousCdnConfig && previousStorageKey && previousStorageKey !== storageKey) {
          try {
            await this.storageService.remove(previousCdnConfig, previousStorageKey);
          } catch (error) {
            this.logger.warn(
              `直传覆盖后清理旧对象失败：fileId=${nameMatch.id} key=${previousStorageKey} reason=${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }

        await this.auditService.write({
          action: AuditAction.FILE_UPLOAD,
          actorId: params.actorId,
          projectId: params.projectId,
          detail: {
            fileId: updated.id,
            originalName,
            size,
            storageKey,
            replaced: true,
            previousStorageKey,
            source: 'presign-complete',
          },
        });

        this.eventBus.emit(DOMAIN_EVENTS.FILE_UPLOADED, {
          projectId: params.projectId,
          fileId: updated.id,
          originalName,
          size,
          mimeType,
          category,
          folderPath,
          actorId: params.actorId,
        });

        return this.toResponse(updated);
      }
    }

    // Content-dedupe by projectId + checksum + size (mirrors persistFileBuffer).
    if (checksum) {
      const duplicateSource =
        (await this.prisma.managedFile.findFirst({
          where: {
            projectId: params.projectId,
            checksum,
            size: BigInt(size),
            status: FileStatus.ACTIVE,
          },
          include: { cdnConfig: true },
          orderBy: { createdAt: 'asc' },
        })) ??
        (await this.prisma.managedFile.findFirst({
          where: {
            projectId: params.projectId,
            checksum,
            size: BigInt(size),
            status: FileStatus.RECYCLED,
          },
          include: { cdnConfig: true },
          orderBy: { createdAt: 'asc' },
        }));

      if (duplicateSource) {
        if (strategy === 'reuse' && duplicateSource.status === FileStatus.ACTIVE) {
          await this.assertProjectQuota(params.projectId, size, params.actorId, { mode: 'reuse' });
          const reused =
            duplicateSource.duplicateOfId
              ? duplicateSource
              : await this.prisma.managedFile.update({
                  where: { id: duplicateSource.id },
                  data: { duplicateOfId: duplicateSource.id },
                  include: { cdnConfig: true },
                });
          await this.auditService.write({
            action: AuditAction.FILE_UPLOAD,
            actorId: params.actorId,
            projectId: params.projectId,
            detail: {
              fileId: reused.id,
              originalName,
              size,
              duplicateReused: true,
              source: 'presign-complete',
            },
          });
          this.eventBus.emit(DOMAIN_EVENTS.FILE_UPLOADED, {
            projectId: params.projectId,
            fileId: reused.id,
            originalName,
            size,
            mimeType,
            category,
            folderPath,
            actorId: params.actorId,
          });
          return this.toResponse({ ...reused, _duplicateReused: true });
        }

        if (strategy === 'reuse' && duplicateSource.status === FileStatus.RECYCLED) {
          await this.assertProjectQuota(params.projectId, size, params.actorId, { mode: 'create' });
          const restoredDuplicate = await this.prisma.managedFile.update({
            where: { id: duplicateSource.id },
            data: {
              status: FileStatus.ACTIVE,
              deletedAt: null,
              purgeAt: null,
              duplicateOfId: duplicateSource.duplicateOfId ?? duplicateSource.id,
            },
            include: { cdnConfig: true },
          });
          await this.auditService.write({
            action: AuditAction.FILE_UPLOAD,
            actorId: params.actorId,
            projectId: params.projectId,
            detail: {
              fileId: restoredDuplicate.id,
              originalName,
              size,
              duplicateReused: true,
              duplicateRestored: true,
              source: 'presign-complete',
            },
          });
          this.eventBus.emit(DOMAIN_EVENTS.FILE_UPLOADED, {
            projectId: params.projectId,
            fileId: restoredDuplicate.id,
            originalName,
            size,
            mimeType,
            category,
            folderPath,
            actorId: params.actorId,
          });
          return this.toResponse({ ...restoredDuplicate, _duplicateReused: true });
        }

        const location = duplicateSource.status === FileStatus.RECYCLED ? '回收站中' : '文件管理中';
        throw new BadRequestException(
          `文件 ${originalName} 与${location}的 ${duplicateSource.originalName} 内容重复，请先使用已有文件或处理原文件。`,
        );
      }
    }

    await this.assertProjectQuota(params.projectId, size, params.actorId, { mode: 'create' });

    const managedFile = await this.prisma.managedFile.create({
      data: {
        projectId: params.projectId,
        cdnConfigId,
        originalName,
        storageKey,
        mimeType,
        extension,
        size: BigInt(size),
        category,
        checksum,
        publicUrl,
        folderPath,
        thumbnailUrl: null,
        scanStatus: 'SKIPPED',
        scannedAt: new Date(),
        scanDetail: null,
        uploadedById: params.actorId,
      },
      include: { cdnConfig: true },
    });

    await this.auditService.write({
      action: AuditAction.FILE_UPLOAD,
      actorId: params.actorId,
      projectId: params.projectId,
      detail: {
        fileId: managedFile.id,
        originalName,
        size,
        storageKey,
        source: 'presign-complete',
      },
    });

    this.eventBus.emit(DOMAIN_EVENTS.FILE_UPLOADED, {
      projectId: params.projectId,
      fileId: managedFile.id,
      originalName,
      size,
      mimeType,
      category,
      folderPath,
      actorId: params.actorId,
    });

    return this.toResponse(managedFile);
  }

  private assertSafeStorageKey(storageKey: string, projectName: string, projectId: string): void {
    if (!storageKey || storageKey.length > 512) {
      throw new BadRequestException('storageKey 无效。');
    }
    if (storageKey.startsWith('/') || storageKey.includes('..') || storageKey.includes('\\') || storageKey.includes('\0')) {
      throw new BadRequestException('storageKey 包含非法路径片段。');
    }

    const safeProject = this.sanitizeStorageSegment(projectName);
    const firstSegment = storageKey.split('/').filter(Boolean)[0] ?? '';
    const allowedPrefixes = new Set(
      [safeProject, projectId, projectName.replace(/[^\w.-]+/g, '_').replace(/\.+$/g, '') || 'project'].filter(Boolean),
    );

    // Accept keys that start with a safe project segment OR contain the projectId as a path segment.
    const segments = storageKey.split('/').filter(Boolean);
    const matchesPrefix = allowedPrefixes.has(firstSegment);
    const containsProjectId = segments.includes(projectId);
    if (!matchesPrefix && !containsProjectId) {
      throw new BadRequestException('storageKey 与项目不匹配，已拒绝。');
    }
  }

  private async readStreamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
    const chunks: Buffer[] = [];

    for await (const rawChunk of stream) {
      const chunk: unknown = rawChunk;
      if (Buffer.isBuffer(chunk)) {
        chunks.push(chunk);
        continue;
      }

      if (chunk instanceof Uint8Array) {
        chunks.push(Buffer.from(chunk));
        continue;
      }

      chunks.push(Buffer.from(String(chunk)));
    }

    return Buffer.concat(chunks);
  }

  private async findFileForProject(fileId: string, projectId: string): Promise<FileWithStorage> {
    const file = await this.prisma.managedFile.findFirst({
      where: { id: fileId, projectId },
      include: { cdnConfig: true },
    });

    if (!file) {
      throw new NotFoundException('文件不存在。');
    }

    return file;
  }

  private async findFilesForProject(fileIds: string[], projectId: string): Promise<FileWithStorage[]> {
    if (!fileIds.length) {
      throw new BadRequestException('fileIds 不能为空。');
    }
    const uniqueIds = [...new Set(fileIds)];
    const files = await this.prisma.managedFile.findMany({
      where: { id: { in: uniqueIds }, projectId },
      include: { cdnConfig: true },
    });

    if (files.length !== uniqueIds.length) {
      throw new NotFoundException('部分文件不存在或不属于当前项目。');
    }

    return files;
  }

  private async findFilesForUser(fileIds: string[], user: RequestUser, requireAdmin: boolean): Promise<FileWithStorage[]> {
    const files = await this.prisma.managedFile.findMany({
      where: { id: { in: fileIds } },
      include: { cdnConfig: true },
    });

    if (files.length !== fileIds.length) {
      throw new NotFoundException('部分文件不存在。');
    }

    for (const file of files) {
      await this.projectAccessService.assertProjectAccess(user, file.projectId, requireAdmin);
    }

    return files;
  }

  private async writeBatchAudit(
    action: AuditAction,
    files: FileWithStorage[],
    actorId: string,
    extraDetail: Record<string, unknown> = {},
  ): Promise<void> {
    const projectIds = new Set(files.map((file) => file.projectId));

    for (const projectId of projectIds) {
      const projectFileIds = files.filter((file) => file.projectId === projectId).map((file) => file.id);
      await this.auditService.write({
        action,
        actorId,
        projectId,
        detail: { fileIds: projectFileIds, total: projectFileIds.length, ...extraDetail },
      });
    }
  }

  private singleProjectId(files: FileWithStorage[]): string | undefined {
    const projectIds = [...new Set(files.map((file) => file.projectId))];
    return projectIds.length === 1 ? projectIds[0] : undefined;
  }

  private normalizeFolderPath(value: string | null | undefined): string | null {
    const normalized = String(value ?? '')
      .trim()
      .replace(/\\/g, '/')
      .split('/')
      .map((part) => this.sanitizeStorageSegment(part))
      .filter(Boolean)
      .join('/');

    return normalized || null;
  }

  private normalizeExtension(value: string): string {
    return value.trim().replace(/^\./, '').toLowerCase();
  }

  private normalizeTag(value: string): string {
    return value.trim().replace(/[,\n\r]/g, ' ').slice(0, 48);
  }

  private serializeTags(tags: string[]): string | null {
    const normalized = [...new Set(tags.map((tag) => this.normalizeTag(tag)).filter(Boolean))].slice(0, 20);
    return normalized.length > 0 ? normalized.join(',') : null;
  }

  private parseTags(value: string | null): string[] {
    return value ? value.split(',').map((tag) => tag.trim()).filter(Boolean) : [];
  }

  private emptyToNull(value: string): string | null {
    const normalized = value.trim();
    return normalized || null;
  }

  private async resolveShareCustomPath(
    raw: string | null | undefined,
    excludeShareId?: string,
  ): Promise<string | null> {
    if (raw === null || raw === undefined) {
      return null;
    }
    const normalized = this.normalizeShareCustomPath(raw);
    if (!normalized) {
      return null;
    }

    const existing = await this.prisma.shareLink.findFirst({
      where: {
        customPath: normalized,
        ...(excludeShareId ? { id: { not: excludeShareId } } : {}),
      },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException('该分享后缀已被使用，请更换后重试。');
    }
    return normalized;
  }

  private normalizeShareCustomPath(raw: string): string | null {
    const trimmed = raw.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/');
    if (!trimmed) {
      return null;
    }
    if (trimmed.length > 200) {
      throw new BadRequestException('自定义分享后缀不能超过 200 个字符。');
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9/_-]*$/.test(trimmed)) {
      throw new BadRequestException(
        '自定义分享后缀仅允许字母、数字、下划线、中划线与 /，且需以字母或数字开头。',
      );
    }
    if (trimmed.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
      throw new BadRequestException('自定义分享后缀路径段不合法。');
    }
    const reserved = new Set([
      'api',
      'shares',
      'folder-shares',
      'library',
      'dashboard',
      'projects',
      'files',
      'settings',
      'console',
      'console-login',
      's',
      'login',
      'admin',
      'recycle-bin',
      'storage-configs',
      'cdn-configs',
      'tasks',
      'webhooks',
      'audit-logs',
      'share-ip-abuse',
      'system-health',
      'developer-integration',
    ]);
    // Reserve the first segment of ADMIN_LOGIN_PATH so pretty shares cannot collide.
    const adminLoginPath = String(this.configService.get<string>('ADMIN_LOGIN_PATH') || '/console-login')
      .trim()
      .replace(/^\/+/, '')
      .split('/')[0]
      ?.toLowerCase();
    if (adminLoginPath) {
      reserved.add(adminLoginPath);
    }
    const first = trimmed.split('/')[0]?.toLowerCase() || '';
    if (reserved.has(first)) {
      throw new BadRequestException(`自定义分享后缀不能以保留路径 “${first}” 开头。`);
    }
    return trimmed;
  }

  /**
   * Resolve a share by opaque token or by customPath (pretty URL suffix).
   * Prefer exact token match so random hex tokens are never confused with paths.
   */
  private async findShareByAccessKey(
    accessKey: string,
    args: Record<string, unknown> = {},
  ): Promise<any> {
    const key = decodeURIComponent(String(accessKey || '').trim()).replace(/^\/+|\/+$/g, '');
    if (!key) {
      return null;
    }
    // Always merge caller args after `where` so include/select are applied correctly.
    const byToken = await this.prisma.shareLink.findUnique({
      ...args,
      where: { token: key },
    } as any);
    if (byToken) {
      return byToken;
    }
    let customPath: string | null = null;
    try {
      customPath = this.normalizeShareCustomPath(key);
    } catch {
      return null;
    }
    if (!customPath) {
      return null;
    }
    return this.prisma.shareLink.findFirst({
      ...args,
      where: { customPath },
    } as any);
  }

  private toShareResponse(
    share: {
      id: string;
      token: string;
      customPath?: string | null;
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
      file: FileWithStorage;
    },
    publicBaseUrl?: string,
  ): Record<string, unknown> {
    // Prefer request Host (passed as publicBaseUrl) so IP/domain deploys work without PUBLIC_URL.
    // PUBLIC_URL, when set, overrides (fixed CDN/site domain).
    const siteUrl = resolvePublicBaseUrl(publicBaseUrl, this.configService.get<string>('PUBLIC_URL'));
    const appPublicUrl = siteUrl;
    const webPublicUrl = siteUrl;
    const sharePath = share.customPath ? `/s/${share.customPath}` : `/shares/${share.token}`;
    const downloadPath = `/api/shares/${share.token}`;

    return {
      id: share.id,
      fileId: share.file.id,
      projectId: share.file.projectId,
      projectName: share.file.project?.name ?? null,
      fileName: share.file.originalName,
      fileSize: Number(share.file.size),
      fileCategory: share.file.category,
      token: share.token,
      customPath: share.customPath ?? null,
      url: webPublicUrl ? `${webPublicUrl}${sharePath}` : sharePath,
      downloadUrl: appPublicUrl ? `${appPublicUrl}${downloadPath}` : downloadPath,
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
      status: this.computeShareStatus(share),
      createdAt: share.createdAt,
      updatedAt: share.updatedAt,
    };
  }

  private computeShareStatus(share: {
    enabled: boolean;
    expiresAt: Date | null;
    maxDownloads: number | null;
    downloadCount: number;
  }): ShareStatus {
    if (!share.enabled) {
      return 'DISABLED';
    }

    if (share.expiresAt && share.expiresAt.getTime() <= Date.now()) {
      return 'EXPIRED';
    }

    if (share.maxDownloads !== null && share.downloadCount >= share.maxDownloads) {
      return 'EXHAUSTED';
    }

    return 'ACTIVE';
  }

  private shareStatusWhere(status?: ShareStatus): Prisma.ShareLinkWhereInput {
    if (!status) {
      return {};
    }

    const now = new Date();
    const notExpired: Prisma.ShareLinkWhereInput = {
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    };

    if (status === 'DISABLED') {
      return { enabled: false };
    }

    if (status === 'EXPIRED') {
      return {
        enabled: true,
        expiresAt: { lte: now },
      };
    }

    if (status === 'EXHAUSTED') {
      return {
        AND: [
          { enabled: true },
          notExpired,
          { maxDownloads: { not: null } },
          { downloadCount: { gte: this.prisma.shareLink.fields.maxDownloads } },
        ],
      };
    }

    return {
      AND: [
        { enabled: true },
        notExpired,
        {
          OR: [
            { maxDownloads: null },
            { downloadCount: { lt: this.prisma.shareLink.fields.maxDownloads } },
          ],
        },
      ],
    };
  }

  private async incrementShareDownloadCount(shareId: string, maxDownloads: number | null): Promise<void> {
    if (maxDownloads === null) {
      await this.prisma.shareLink.update({
        where: { id: shareId },
        data: { downloadCount: { increment: 1 } },
      });
      return;
    }

    const result = await this.prisma.shareLink.updateMany({
      where: {
        id: shareId,
        enabled: true,
        downloadCount: { lt: maxDownloads },
      },
      data: { downloadCount: { increment: 1 } },
    });

    if (result.count === 0) {
      throw new BadRequestException('分享链接下载次数已用完。');
    }
  }

  /**
   * IP-based download anti-abuse for public share downloads.
   * Manual/DB ban → reject; >5 downloads within 60s → lock ~10 min + notify + DB stats.
   */
  private async assertShareDownloadRateLimit(meta: {
    ip?: string;
    shareId?: string;
    fileId?: string;
    projectId?: string | null;
    originalName?: string;
    kind: 'file-share' | 'folder-share' | 'public';
  }): Promise<void> {
    const ip = (meta.ip || 'unknown').trim().replace(/^::ffff:/i, '') || 'unknown';
    await this.shareIpAbuseService.assertNotBanned(ip);

    // Global per-IP bucket (all shares) so hammering any share page is limited.
    const key = `share-dl:${ip}`;
    this.shareDownloadRateLimiter.assertAllowed(
      key,
      '下载过于频繁，已临时限制访问（同一 IP 每分钟最多 5 次）',
    );
    const newlyLocked = this.shareDownloadRateLimiter.recordAttempt(key);
    await this.shareIpAbuseService.recordDownload(ip, {
      shareId: meta.shareId,
      originalName: meta.originalName,
    });
    if (newlyLocked) {
      this.logger.warn(
        `share download rate-limited ip=${ip} shareId=${meta.shareId || '-'} file=${meta.originalName || '-'}`,
      );
      await this.shareIpAbuseService.recordRateLimited(ip, {
        shareId: meta.shareId,
        originalName: meta.originalName,
        autoBanMinutes: 10,
      });
      this.eventBus.emit(DOMAIN_EVENTS.SHARE_DOWNLOAD_RATE_LIMITED, {
        projectId: meta.projectId ?? null,
        fileId: meta.fileId ?? null,
        shareId: meta.shareId ?? null,
        originalName: meta.originalName ?? null,
        ip,
        limit: 5,
        windowSeconds: 60,
        kind: meta.kind,
      });
    }
  }

  private assertShareDownloadAvailable(downloadCount: number, maxDownloads: number | null): void {
    if (maxDownloads !== null && downloadCount >= maxDownloads) {
      throw new BadRequestException('分享链接下载次数已用完。');
    }
  }

  private assertShareExists<T>(share: T | null): asserts share is T {
    if (!share) {
      throw new NotFoundException('分享链接不存在或已失效。');
    }
  }

  private async assertShareUsable(
    share: {
      enabled: boolean;
      passwordHash: string | null;
      expiresAt: Date | null;
      allowedIps: Prisma.JsonValue;
      file: { status: FileStatus };
    } | null,
    token: string,
    password?: string,
    ip?: string,
    skipPassword = false,
  ): Promise<void> {
    if (!share || !share.enabled || share.file.status !== FileStatus.ACTIVE) {
      throw new NotFoundException('分享链接不存在或已失效。');
    }

    if (share.expiresAt && share.expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException('分享链接已过期。');
    }

    if (!isIpAllowed(ip, Array.isArray(share.allowedIps) ? share.allowedIps.map((entry) => String(entry)) : [])) {
      throw new ForbiddenException('当前 IP 不在该分享的访问白名单内。');
    }

    const attemptKey = this.sharePasswordAttemptKey(token, ip);
    if (share.passwordHash && !skipPassword) {
      this.sharePasswordAttemptLimiter.assertAllowed(attemptKey, '分享密码错误次数过多');
    }

    if (share.passwordHash && !skipPassword && (!password || !(await bcrypt.compare(password, share.passwordHash)))) {
      this.sharePasswordAttemptLimiter.recordFailure(attemptKey);
      throw new BadRequestException('分享密码错误。');
    }

    this.sharePasswordAttemptLimiter.reset(attemptKey);
  }

  private sharePasswordAttemptKey(token: string, ip?: string): string {
    return `share:${token}:${ip ?? 'unknown'}`;
  }

  private async runRecycleCleanup(): Promise<void> {
    const batchSize = this.configService.get<number>('RECYCLE_CLEANUP_BATCH_SIZE', 100);
    const summary = await this.purgeExpiredRecycledFiles(Math.max(1, Number(batchSize) || 100));

    if (summary.scanned > 0) {
      this.logger.log(
        `回收站到期清理完成：scanned=${summary.scanned} purged=${summary.purged} failed=${summary.failed}`,
      );
    }
  }
}
