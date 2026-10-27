import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { FileStatus, type ManagedFile } from '@prisma/client';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

import { resolveExtension, resolveFileCategory } from '../common/utils/file-category.util';
import { folderPathKey } from '../common/utils/folder-path.util';
import { DOMAIN_EVENTS } from '../events/domain-events';
import { EventBusService } from '../events/event-bus.service';
import { FilesService } from '../files/files.service';
import { FolderManagerService } from '../files/folder-manager.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import type { WebdavAccount } from './webdav-account.service';
import { davBaseName, parentDavPath } from './webdav.utils';

export type DavReadResult = {
  file: Pick<ManagedFile, 'id' | 'originalName' | 'mimeType' | 'size' | 'updatedAt'>;
  stream?: Readable;
  redirectUrl?: string;
  size: number;
};

/**
 * File-level DAV operations against the normal storage layer, so uploads keep
 * the same quota accounting, checksums and domain events as console uploads.
 */
@Injectable()
export class WebdavFileService {
  private readonly logger = new Logger(WebdavFileService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storageService: StorageService,
    private readonly folderManager: FolderManagerService,
    private readonly filesService: FilesService,
    private readonly eventBus: EventBusService,
  ) {}

  async readFile(account: WebdavAccount, davPath: string, range?: { start?: number; end?: number }): Promise<DavReadResult> {
    const file = await this.requireFile(account, davPath);
    const target = await this.storageService.getDownloadTarget(file, 120, range, { preferRedirect: !range });

    return {
      file: {
        id: file.id,
        originalName: file.originalName,
        mimeType: file.mimeType,
        size: file.size,
        updatedAt: file.updatedAt,
      },
      stream: target.type === 'stream' ? target.stream : undefined,
      redirectUrl: target.type === 'redirect' ? target.url : undefined,
      size: Number(file.size),
    };
  }
  /** PUT: write the body into the project's active storage and register metadata. */
  async writeFile(
    account: WebdavAccount,
    davPath: string,
    body: Buffer,
    mimeType: string,
    actorId: string,
  ): Promise<void> {
    const folderPath = folderPathKey(parentDavPath(davPath));
    const name = davBaseName(davPath);

    if (!name) {
      throw new BadRequestException('WebDAV 路径缺少文件名。');
    }

    const existing = await this.prisma.managedFile.findFirst({
      where: { projectId: account.projectId, originalName: name, folderPath: folderPath || null },
      select: { id: true, status: true, size: true, storageKey: true, cdnConfig: true },
    });

    const isOverwrite = Boolean(existing && existing.status === FileStatus.ACTIVE);

    // Same quota accounting as a console upload: overwrite only charges the delta.
    await this.filesService.assertProjectQuota(account.projectId, body.length, actorId, {
      mode: isOverwrite ? 'replace' : 'create',
      previousBytes: isOverwrite ? Number(existing?.size ?? 0) : 0,
    });

    await this.folderManager.ensure(account.projectId, folderPath, actorId);

    const stored = await this.storageService.upload(account.projectId, {
      key: await this.buildStorageKey(account, folderPath, name),
      buffer: body,
      mimeType,
      originalName: name,
    });
    const category = resolveFileCategory(name, mimeType);
    const checksum = createHash('sha256').update(body).digest('hex');

    if (isOverwrite && existing) {
      await this.prisma.managedFile.update({
        where: { id: existing.id },
        data: {
          cdnConfigId: stored.cdnConfigId,
          storageKey: stored.storageKey,
          size: BigInt(body.length),
          mimeType,
          extension: resolveExtension(name),
          category,
          checksum,
          publicUrl: stored.publicUrl,
          thumbnailUrl: category === 'IMAGE' ? stored.publicUrl : null,
          updatedAt: new Date(),
        },
      });
      // Best-effort cleanup of the replaced object (mirrors the console upload path).
      await this.storageService.remove(existing.cdnConfig, existing.storageKey).catch((error) => {
        this.logger.warn(
          `WebDAV 覆盖后清理旧对象失败 fileId=${existing.id}：${error instanceof Error ? error.message : String(error)}`,
        );
      });
      return;
    }

    const created = await this.prisma.managedFile.create({
      data: {
        projectId: account.projectId,
        cdnConfigId: stored.cdnConfigId,
        originalName: name,
        storageKey: stored.storageKey,
        mimeType,
        extension: resolveExtension(name),
        size: BigInt(body.length),
        category,
        checksum,
        publicUrl: stored.publicUrl,
        thumbnailUrl: category === 'IMAGE' ? stored.publicUrl : null,
        folderPath: folderPath || null,
        uploadedById: actorId,
      },
      select: { id: true },
    });

    this.eventBus.emit(DOMAIN_EVENTS.FILE_UPLOADED, {
      projectId: account.projectId,
      fileId: created.id,
      originalName: name,
      size: body.length,
      mimeType,
      category,
      folderPath: folderPath || null,
      actorId,
    });

    this.logger.log(`WebDAV PUT 新建文件 projectId=${account.projectId} fileId=${created.id} name=${name}`);
  }

  /** Delete a file: physically removes the object and the row (DAV semantics). */
  async getFileForDownload(account: WebdavAccount, davPath: string) {
    return this.requireFile(account, davPath);
  }

  async deleteFile(account: WebdavAccount, davPath: string): Promise<void> {
    const file = await this.requireFile(account, davPath);

    await this.storageService.remove(file.cdnConfig, file.storageKey).catch((error) => {
      this.logger.warn(
        `WebDAV 删除存储对象失败 fileId=${file.id}：${error instanceof Error ? error.message : String(error)}`,
      );
    });

    await this.prisma.managedFile.delete({ where: { id: file.id } });
  }

  /** Recursive delete for a collection. */
  async deleteCollection(account: WebdavAccount, davPath: string): Promise<number> {
    const folderPath = folderPathKey(davPath);
    const files = await this.prisma.managedFile.findMany({
      where: {
        projectId: account.projectId,
        status: FileStatus.ACTIVE,
        OR: [{ folderPath }, { folderPath: { startsWith: `${folderPath}/` } }],
      },
      include: { cdnConfig: true },
    });

    for (const file of files) {
      await this.storageService.remove(file.cdnConfig, file.storageKey).catch(() => undefined);
    }

    if (files.length > 0) {
      await this.prisma.managedFile.deleteMany({ where: { id: { in: files.map((file) => file.id) } } });
    }

    await this.folderManager.remove(account.projectId, folderPath);

    return files.length;
  }

  private async requireFile(account: WebdavAccount, davPath: string) {
    const normalized = folderPathKey(davPath);
    const name = davBaseName(normalized);
    const parent = folderPathKey(parentDavPath(normalized));

    const file = await this.prisma.managedFile.findFirst({
      where: {
        projectId: account.projectId,
        originalName: name,
        folderPath: parent || null,
        status: FileStatus.ACTIVE,
      },
      include: { cdnConfig: true },
    });

    if (!file) {
      throw new NotFoundException('WebDAV 文件不存在。');
    }

    return file;
  }

  private async buildStorageKey(account: WebdavAccount, folderPath: string, name: string): Promise<string> {
    const safeFolder = folderPath
      .split('/')
      .map((segment) => segment.replace(/[^\w.-]+/g, '_'))
      .filter(Boolean)
      .join('/');
    const safeName = name.replace(/[^\w.-]+/g, '_');
    const prefix = account.projectId;
    const date = new Date();
    const stamp = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    return [prefix, safeFolder, stamp, `${unique}-${safeName}`].filter(Boolean).join('/');
  }
  /** COPY / MOVE a file or collection to another DAV path in the same project. */
  async transferEntry(
    account: WebdavAccount,
    sourcePath: string,
    targetPath: string,
    isCollection: boolean,
    copy: boolean,
  ): Promise<void> {
    const targetParent = folderPathKey(parentDavPath(targetPath));
    const targetName = davBaseName(targetPath);
    if (!targetName) {
      throw new BadRequestException('目标路径无效。');
    }

    if (isCollection) {
      if (!copy) {
        await this.moveCollection(account, sourcePath, targetPath);
      }
      return;
    }

    const file = await this.requireFile(account, sourcePath);

    if (copy) {
      const stored = await this.storageService.upload(account.projectId, {
        key: await this.buildStorageKey(account, targetParent, targetName),
        buffer: await this.readFileBuffer(file),
        mimeType: file.mimeType,
        originalName: targetName,
      });

      await this.prisma.managedFile.create({
        data: {
          projectId: account.projectId,
          cdnConfigId: stored.cdnConfigId,
          originalName: targetName,
          storageKey: stored.storageKey,
          mimeType: file.mimeType,
          extension: file.extension,
          size: file.size,
          category: file.category,
          publicUrl: stored.publicUrl,
          folderPath: targetParent || null,
        },
      });
      return;
    }

    await this.prisma.managedFile.update({
      where: { id: file.id },
      data: { originalName: targetName, folderPath: targetParent || null },
    });
  }

  private async moveCollection(account: WebdavAccount, sourcePath: string, targetPath: string): Promise<void> {
    const source = folderPathKey(sourcePath);
    const target = folderPathKey(targetPath);

    const files = await this.prisma.managedFile.findMany({
      where: {
        projectId: account.projectId,
        OR: [{ folderPath: source }, { folderPath: { startsWith: `${source}/` } }],
      },
      select: { id: true, folderPath: true },
    });

    if (files.length > 0) {
      for (const file of files) {
        const folder = folderPathKey(file.folderPath);
        const nextFolder = target + folder.slice(source.length);
        await this.prisma.managedFile.update({ where: { id: file.id }, data: { folderPath: nextFolder } });
      }
    }

    await this.folderManager.renamePrefix(account.projectId, source, target);
  }

  private async readFileBuffer(file: { id: string }): Promise<Buffer> {
    const target = await this.storageService.getDownloadTarget(
      await this.requireFileById(file.id),
      120,
      undefined,
      { preferRedirect: false },
    );

    if (target.type === 'stream' && target.stream) {
      const chunks: Buffer[] = [];
      for await (const chunk of target.stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
      }
      return Buffer.concat(chunks);
    }

    throw new BadRequestException('无法读取源文件内容。');
  }

  private requireFileById(fileId: string) {
    return this.prisma.managedFile.findUniqueOrThrow({
      where: { id: fileId },
      include: { cdnConfig: true },
    });
  }
}
