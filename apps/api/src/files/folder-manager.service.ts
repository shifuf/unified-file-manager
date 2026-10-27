import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { FileStatus } from '@prisma/client';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

import { folderPathKey } from '../common/utils/folder-path.util';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectAccessService } from '../projects/project-access.service';
import type { RequestUser } from '../common/types/request-user.type';
import { StorageAdapterRegistry } from '../storage/storage-registry.service';
import { StorageService } from '../storage/storage.service';

/**
 * Folder creation/deletion shared by the admin API, the open API and WebDAV.
 *
 * Folders are still keyed by `ManagedFile.folderPath` for file placement, but an
 * explicit `ManagedFolder` row is also written so empty folders are visible in
 * the console tree and survive a WebDAV MKCOL -> PROPFIND round trip.
 */
@Injectable()
export class FolderManagerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projectAccessService: ProjectAccessService,
    private readonly registry: StorageAdapterRegistry,
    private readonly storageService: StorageService,
  ) {}

  async createForUser(
    projectId: string,
    folderPathRaw: string,
    user: RequestUser,
  ): Promise<{ folderPath: string }> {
    await this.projectAccessService.assertProjectAccess(user, projectId, true);
    return this.create(projectId, folderPathRaw, user.id);
  }

  /** Open-API variant: the signed project IS the scope, no extra ACL check. */
  createForProject(projectId: string, folderPathRaw: string): Promise<{ folderPath: string }> {
    return this.create(projectId, folderPathRaw);
  }

  async create(
    projectId: string,
    folderPathRaw: string,
    actorId?: string,
  ): Promise<{ folderPath: string }> {
    const folderPath = folderPathKey(folderPathRaw);
    if (!folderPath) {
      throw new NotFoundException('目录名不能为空。');
    }

    await this.assertNoFileCollision(projectId, folderPath);

    const created = await this.prisma.managedFolder.findFirst({
      where: { projectId, path: folderPath },
      select: { id: true },
    });
    if (created) {
      throw new ConflictException('目录已存在。');
    }

    await this.persistFolders(projectId, folderPath, actorId);
    await this.materializeLocalFolder(projectId, folderPath);

    return { folderPath };
  }

  /** Idempotent WebDAV/upload helper: register a folder plus its ancestors. */
  async ensure(projectId: string, folderPathRaw: string, actorId?: string): Promise<string> {
    const folderPath = folderPathKey(folderPathRaw);
    if (!folderPath) {
      return '';
    }

    await this.assertNoFileCollision(projectId, folderPath);
    await this.persistFolders(projectId, folderPath, actorId);
    await this.materializeLocalFolder(projectId, folderPath);
    return folderPath;
  }

  /** All explicitly registered folder paths for a project. */
  async listPaths(projectId: string): Promise<string[]> {
    const rows = await this.prisma.managedFolder.findMany({
      where: { projectId },
      select: { path: true },
      orderBy: { path: 'asc' },
    });
    return rows.map((row) => row.path);
  }

  /** Drop a folder and its descendants from the registry (files are untouched). */
  async remove(projectId: string, folderPathRaw: string): Promise<void> {
    const folderPath = folderPathKey(folderPathRaw);
    if (!folderPath) {
      return;
    }

    await this.prisma.managedFolder.deleteMany({
      where: {
        projectId,
        OR: [{ path: folderPath }, { path: { startsWith: `${folderPath}/` } }],
      },
    });

    await this.removeLocalFolder(projectId, folderPath);
  }

  /** Reparent a folder subtree (WebDAV MOVE of a collection). */
  async renamePrefix(projectId: string, fromPathRaw: string, toPathRaw: string): Promise<void> {
    const fromPath = folderPathKey(fromPathRaw);
    const toPath = folderPathKey(toPathRaw);
    if (!fromPath || !toPath) {
      return;
    }

    const folders = await this.prisma.managedFolder.findMany({
      where: {
        projectId,
        OR: [{ path: fromPath }, { path: { startsWith: `${fromPath}/` } }],
      },
      select: { id: true, path: true },
    });

    for (const folder of folders) {
      const nextPath = `${toPath}${folder.path.slice(fromPath.length)}`;
      await this.prisma.managedFolder.update({ where: { id: folder.id }, data: { path: nextPath } });
    }

    await this.ensure(projectId, toPath);
    await this.removeLocalFolder(projectId, fromPath);
  }

  private async persistFolders(projectId: string, folderPath: string, actorId?: string): Promise<void> {
    const segments = folderPath.split('/').filter(Boolean);
    for (let index = 1; index <= segments.length; index += 1) {
      const path = segments.slice(0, index).join('/');
      await this.prisma.managedFolder.upsert({
        where: { projectId_path: { projectId, path } },
        update: {},
        create: { projectId, path, createdById: actorId ?? null },
      });
    }
  }

  /** Reject a folder that collides with a same-named file in the same directory. */
  private async assertNoFileCollision(projectId: string, folderPath: string): Promise<void> {
    const name = folderPath.split('/').filter(Boolean).pop() as string;
    const parent = folderPath.slice(0, folderPath.length - name.length).replace(/\/$/, '');

    const conflict = await this.prisma.managedFile.count({
      where: {
        projectId,
        status: FileStatus.ACTIVE,
        originalName: name,
        folderPath: parent || null,
      },
    });

    if (conflict > 0) {
      throw new ConflictException('同名文件已存在，无法创建目录。');
    }
  }

  private async materializeLocalFolder(projectId: string, folderPath: string): Promise<void> {
    const root = await this.localRoot(projectId);
    if (!root) {
      return;
    }

    const target = resolve(root, folderPath);
    if (!this.isInsideRoot(root, target)) {
      throw new NotFoundException('目录路径越界，已拒绝。');
    }
    await mkdir(target, { recursive: true });
  }

  private async removeLocalFolder(projectId: string, folderPath: string): Promise<void> {
    const root = await this.localRoot(projectId);
    if (!root) {
      return;
    }

    const target = resolve(root, folderPath);
    if (target === resolve(root) || !this.isInsideRoot(root, target)) {
      return;
    }
    await rm(target, { recursive: true, force: true }).catch(() => undefined);
  }

  private async localRoot(projectId: string): Promise<string | null> {
    const active = await this.storageService.getActiveStorage(projectId);
    return this.registry.localRoot(active);
  }

  private isInsideRoot(root: string, target: string): boolean {
    const normalizedRoot = root.replace(/\\/g, '/').replace(/\/+$/, '');
    const normalizedTarget = target.replace(/\\/g, '/');
    return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}/`);
  }
}
