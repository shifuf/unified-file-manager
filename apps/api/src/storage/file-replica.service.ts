import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { CdnProvider, FileStatus, UserRole, type Prisma } from '@prisma/client';

import type { RequestUser } from '../common/types/request-user.type';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectAccessService } from '../projects/project-access.service';
import { ReplicaService } from './replica.service';

const CONFIG_SELECT = { id: true, name: true, provider: true, enabled: true, priority: true, projectId: true, createdAt: true } as const;
const FILE_SELECT = { id: true, projectId: true, storageKey: true, currentVersion: true, updatedAt: true,
  cdnConfigId: true, size: true, checksum: true } as const;
type MetadataClient = PrismaService | Prisma.TransactionClient;
type FileHead = Prisma.ManagedFileGetPayload<{ select: typeof FILE_SELECT }>;
type SafeConfig = Prisma.CdnConfigGetPayload<{ select: typeof CONFIG_SELECT }>;

export type FileStorageLocation = {
  configId: string; configName: string; provider: string; enabled: boolean; assigned: boolean;
  desired: boolean; priority: number; status: string; attempts: number; lastError: string | null;
  verifiedAt: Date | null; replicaId?: string;
};
export type FileReplicaDetail = {
  fileId: string; projectId: string; storageKey: string; currentVersion: number; canManage: boolean;
  updatedAt: Date; items: FileStorageLocation[];
};

@Injectable()
export class FileReplicaService {
  constructor(private readonly prisma: PrismaService, private readonly access: ProjectAccessService,
    private readonly replicas: ReplicaService) {}

  async list(fileIds: string, user: RequestUser): Promise<{ items: FileReplicaDetail[] }> {
    const observedAt = new Date();
    const ids = parseIdentifiers(fileIds);
    const files = await this.prisma.managedFile.findMany({
      where: { id: { in: ids }, status: { not: FileStatus.DELETED }, project: { deletedAt: null } }, select: FILE_SELECT,
    });
    if (files.length !== ids.length) throw new NotFoundException('文件不存在或已删除。');
    const byId = new Map(files.map(file => [file.id, file]));
    const ordered = ids.map(id => byId.get(id)!);
    for (const projectId of new Set(ordered.map(file => file.projectId))) await this.access.assertProjectAccess(user, projectId);
    return { items: await this.details(ordered, user, this.prisma, observedAt) };
  }

  async get(fileId: string, user: RequestUser): Promise<FileReplicaDetail> {
    const observedAt = new Date();
    const file = await this.fileHead(fileId, this.prisma);
    await this.access.assertProjectAccess(user, file.projectId);
    return (await this.details([file], user, this.prisma, observedAt))[0];
  }

  async sync(fileId: string, configIds: unknown, user: RequestUser): Promise<{
    queued: number; fileId: string; projectId: string; currentVersion: number; items: FileStorageLocation[];
  }> {
    const ids = parseConfigIds(configIds);
    const initial = await this.fileHead(fileId, this.prisma, true);
    await this.access.assertProjectAccess(user, initial.projectId, true);
    return this.prisma.$transaction(async tx => {
      // Serialize requests and concurrent revisions before selecting the current object.
      await tx.$queryRaw`SELECT id FROM Project WHERE id = ${initial.projectId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM ManagedFile WHERE id = ${fileId} FOR UPDATE`;
      const file = await this.fileHead(fileId, tx, true);
      if (file.projectId !== initial.projectId) await this.access.assertProjectAccess(user, file.projectId, true);
      const detail = (await this.details([file], user, tx))[0];
      const allowed = new Set(detail.items.filter(item => item.desired && item.enabled).map(item => item.configId));
      if (ids.some(id => !allowed.has(id))) throw new BadRequestException('只能同步该项目启用的云存储和选定的本地安全副本。');
      const { queued } = await this.replicas.enqueueFileTargets(file, ids, tx);
      const updated = (await this.details([file], user, tx))[0];
      return { queued, fileId: file.id, projectId: file.projectId, currentVersion: file.currentVersion, items: updated.items };
    });
  }

  private async fileHead(fileId: string, client: MetadataClient, requireActive = false): Promise<FileHead> {
    if (typeof fileId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(fileId)) throw new BadRequestException('文件 ID 无效。');
    const file = await client.managedFile.findFirst({
      where: { id: fileId, ...(requireActive ? { status: FileStatus.ACTIVE, deletedAt: null } : { status: { not: FileStatus.DELETED } }),
        project: { deletedAt: null, ...(requireActive ? { enabled: true } : {}) } }, select: FILE_SELECT,
    });
    if (!file) throw new NotFoundException('文件不存在或已删除。');
    return file;
  }

  private async details(files: FileHead[], user: RequestUser, client: MetadataClient, observedAt = new Date()): Promise<FileReplicaDetail[]> {
    // Keep the existing response field as the observation start time. A slow
    // earlier read must not acquire newer freshness when it finally completes.
    const projectIds = [...new Set(files.map(file => file.projectId))];
    const [bindings, rows, sources] = await Promise.all([
      client.projectStorageBinding.findMany({ where: { projectId: { in: projectIds } },
        select: { projectId: true, configId: true, config: { select: CONFIG_SELECT } } }),
      client.storageReplica.findMany({ where: { OR: files.map(file => ({ projectId: file.projectId, storageKey: file.storageKey })) },
        select: { id: true, projectId: true, storageKey: true, configId: true, status: true, attempts: true,
          lastError: true, verifiedAt: true, config: { select: CONFIG_SELECT } } }),
      client.cdnConfig.findMany({ where: { id: { in: [...new Set(files.flatMap(file => file.cdnConfigId ? [file.cdnConfigId] : []))] } },
        select: CONFIG_SELECT }),
    ]);
    const localByProject = new Map<string, SafeConfig>();
    for (const projectId of projectIds) {
      const local = bindings.filter(binding => binding.projectId === projectId && binding.config.enabled
        && binding.config.projectId === null && binding.config.provider === CdnProvider.LOCAL)
        .map(binding => binding.config).sort(localOrder)[0];
      if (local) localByProject.set(projectId, local);
    }
    if (localByProject.size < projectIds.length) {
      const fallback = await client.cdnConfig.findFirst({ where: { enabled: true, provider: CdnProvider.LOCAL, projectId: null },
        orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }], select: CONFIG_SELECT });
      if (fallback) for (const projectId of projectIds) if (!localByProject.has(projectId)) localByProject.set(projectId, fallback);
    }
    return files.map(file => {
      const assigned = bindings.filter(binding => binding.projectId === file.projectId);
      const indexed = rows.filter(row => row.projectId === file.projectId && row.storageKey === file.storageKey);
      const configs = new Map<string, SafeConfig>();
      for (const binding of assigned) configs.set(binding.configId, binding.config);
      for (const row of indexed) configs.set(row.configId, row.config);
      const source = sources.find(config => config.id === file.cdnConfigId);
      if (source) configs.set(source.id, source);
      const local = localByProject.get(file.projectId);
      if (local) configs.set(local.id, local);
      const items = [...configs.values()].sort((a, b) => Number(b.provider === CdnProvider.LOCAL) - Number(a.provider === CdnProvider.LOCAL)
        || a.priority - b.priority || a.id.localeCompare(b.id)).map(config => {
        const row = indexed.find(candidate => candidate.configId === config.id);
        const bound = assigned.some(binding => binding.configId === config.id);
        const desired = config.enabled && config.projectId === null
          && (config.provider === CdnProvider.LOCAL ? config.id === local?.id : bound);
        return { configId: config.id, configName: config.name, provider: config.provider, enabled: config.enabled,
          assigned: bound, desired, priority: config.priority,
          status: row ? row.status === 'READY' && !row.verifiedAt ? 'UNVERIFIED' : row.status
            : config.id === file.cdnConfigId ? 'UNVERIFIED' : 'NOT_SYNCED',
          attempts: row?.attempts ?? 0, lastError: row?.lastError ?? null, verifiedAt: row?.verifiedAt ?? null,
          ...(row ? { replicaId: row.id } : {}),
        };
      });
      return { fileId: file.id, projectId: file.projectId, storageKey: file.storageKey, currentVersion: file.currentVersion,
        canManage: user.role === UserRole.SUPER_ADMIN, updatedAt: observedAt, items };
    });
  }
}

function parseIdentifiers(value: string): string[] {
  if (typeof value !== 'string') throw new BadRequestException('请提供文件 ID 列表。');
  const ids = value.split(',').map(id => id.trim());
  if (!ids.length || ids.length > 100 || ids.some(id => !/^[A-Za-z0-9_-]{1,128}$/.test(id))) {
    throw new BadRequestException('每次查询须提供 1 至 100 个有效文件 ID。');
  }
  return [...new Set(ids)];
}

function parseConfigIds(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 100
    || value.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id))) {
    throw new BadRequestException('请选择 1 至 100 个有效目标存储。');
  }
  return [...new Set(value as string[])];
}

function localOrder(a: SafeConfig, b: SafeConfig): number {
  return a.priority - b.priority || a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id);
}
