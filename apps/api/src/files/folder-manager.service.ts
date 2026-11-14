import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { FileStatus, Prisma } from '@prisma/client';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

import { folderPathKey } from '../common/utils/folder-path.util';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectAccessService } from '../projects/project-access.service';
import type { RequestUser } from '../common/types/request-user.type';
import { StorageAdapterRegistry } from '../storage/storage-registry.service';
import { StorageService } from '../storage/storage.service';

export type FolderTreeNode = { name: string; path: string; fileCount: number; children: FolderTreeNode[] };

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
    const folderPath = this.validateAdminPath(folderPathRaw);
    await this.prisma.$transaction(async (tx) => {
      const created = await tx.managedFolder.findUnique({
        where: { projectId_path: { projectId, path: folderPath } },
        select: { id: true },
      });
      if (created) throw new ConflictException('目录已存在。');
      const segments = folderPath.split('/');
      for (let index = 1; index <= segments.length; index += 1) {
        await this.assertNoFileCollision(projectId, segments.slice(0, index).join('/'), tx);
      }
      await this.persistFolders(projectId, folderPath, actorId, tx);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
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

  async listForUser(projectId: string, user: RequestUser, status: 'ACTIVE' | 'RECYCLED' = 'ACTIVE'): Promise<string[]> {
    await this.projectAccessService.assertProjectAccess(user, projectId);
    return (await this.folderSnapshot(projectId, status)).paths;
  }

  async listTreeForUser(projectId: string, user: RequestUser, status: 'ACTIVE' | 'RECYCLED' = 'ACTIVE'): Promise<FolderTreeNode[]> {
    await this.projectAccessService.assertProjectAccess(user, projectId);
    const { paths, counts } = await this.folderSnapshot(projectId, status);
    const root: FolderTreeNode[] = [];
    const index = new Map<string, FolderTreeNode>();
    for (const path of paths) {
      const segments = path.split('/');
      const node: FolderTreeNode = { name: segments[segments.length - 1], path, fileCount: counts.get(path) ?? 0, children: [] };
      index.set(path, node);
      const parent = index.get(segments.slice(0, -1).join('/'));
      if (parent) parent.children.push(node);
      else root.push(node);
    }
    const sort = (nodes: FolderTreeNode[]): void => {
      nodes.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
      nodes.forEach(node => sort(node.children));
    };
    sort(root);
    return root;
  }

  /** Admin removal affects the registry only; recovery objects and in-flight uploads keep their bytes. */
  async removeEmptyForUser(projectId: string, folderPathRaw: string, user: RequestUser): Promise<{ success: boolean }> {
    await this.projectAccessService.assertProjectAccess(user, projectId, true);
    const folderPath = this.validateAdminPath(folderPathRaw);
    try {
      await this.prisma.$transaction(async (tx) => {
        const folder = await tx.managedFolder.findUnique({
          where: { projectId_path: { projectId, path: folderPath } },
          select: { id: true },
        });
        const fileCount = await tx.managedFile.count({
          where: { projectId, status: FileStatus.ACTIVE, OR: [{ folderPath }, { folderPath: { startsWith: `${folderPath}/` } }] },
        });
        if (fileCount) throw new ConflictException('目录中存在文件，请先删除目录及子目录中的文件。');
        const childCount = await tx.managedFolder.count({
          where: { projectId, path: { startsWith: `${folderPath}/` } },
        });
        if (childCount) throw new ConflictException('目录中存在子目录，请先删除子目录。');
        if (!folder) throw new NotFoundException('目录不存在。');
        await tx.managedFolder.delete({ where: { id: folder.id } });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if ((error as { code?: string }).code === 'P2034') {
        throw new ConflictException('目录内容正在变化，请刷新后重试。');
      }
      throw error;
    }
    return { success: true };
  }

  private validateAdminPath(raw: string): string {
    if (typeof raw !== 'string' || !raw.trim() || raw.length > 512) throw new BadRequestException('目录路径无效，不能操作项目根目录。');
    const input = raw.trim().replace(/\\/g, '/');
    if (input.startsWith('/') || [...input].some(character => character.charCodeAt(0) < 32) || /[<>:"|?*]/.test(input) || input.split('/').some(segment => segment === '.' || segment === '..')) {
      throw new BadRequestException('目录路径越界或包含非法字符，已拒绝。');
    }
    const path = folderPathKey(input);
    if (!path) throw new BadRequestException('不能操作项目根目录。');
    return path;
  }

  private async folderSnapshot(projectId: string, status: 'ACTIVE' | 'RECYCLED') {
    if (status !== 'ACTIVE' && status !== 'RECYCLED') throw new BadRequestException('目录文件状态无效。');
    return this.prisma.$transaction(async (tx) => {
      const registered = status === 'ACTIVE' ? await tx.managedFolder.findMany({ where: { projectId }, select: { path: true } }) : [];
      const grouped = await tx.managedFile.groupBy({ by: ['folderPath'], where: { projectId, status }, _count: { _all: true } });
      const counts = new Map(grouped.map(row => [row.folderPath ?? '', row._count._all]));
      const paths = new Set<string>();
      for (const value of [...registered.map(row => row.path), ...grouped.map(row => row.folderPath)]) {
        if (!value) continue;
        const segments = folderPathKey(value).split('/').filter(Boolean);
        for (let length = 1; length <= segments.length; length += 1) paths.add(segments.slice(0, length).join('/'));
      }
      return { paths: [...paths].sort(), counts };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
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

  private async persistFolders(projectId: string, folderPath: string, actorId?: string, client: Prisma.TransactionClient = this.prisma): Promise<void> {
    const segments = folderPath.split('/').filter(Boolean);
    for (let index = 1; index <= segments.length; index += 1) {
      const path = segments.slice(0, index).join('/');
      await client.managedFolder.upsert({
        where: { projectId_path: { projectId, path } },
        update: {},
        create: { projectId, path, createdById: actorId ?? null },
      });
    }
  }

  /** Reject a folder that collides with a same-named file in the same directory. */
  private async assertNoFileCollision(projectId: string, folderPath: string, client: Prisma.TransactionClient = this.prisma): Promise<void> {
    const name = folderPath.split('/').filter(Boolean).pop() as string;
    const parent = folderPath.slice(0, folderPath.length - name.length).replace(/\/$/, '');

    const conflict = await client.managedFile.count({
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
