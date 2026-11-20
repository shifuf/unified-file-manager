import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';

import type { RequestUser } from '../common/types/request-user.type';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectAccessService } from '../projects/project-access.service';
import { ReplicaService } from './replica.service';
import { StorageAdapterRegistry } from './storage-registry.service';

type QueuedProject = { projectId: string; projectName: string; taskId: string; requeued: number };
export type StorageProjectSyncResult = { queuedProjects: number; projects: QueuedProject[] };
const ID_PATTERN = /^[A-Za-z0-9_-]{1,191}$/;

@Injectable()
export class StorageProjectSyncService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: StorageAdapterRegistry,
    private readonly access: ProjectAccessService,
    private readonly replicas: ReplicaService,
  ) {}

  async enqueue(configId: string, projectIds: string[], user: RequestUser): Promise<StorageProjectSyncResult> {
    if (user.role !== 'SUPER_ADMIN') throw new ForbiddenException('仅超级管理员可同步项目到云端。');
    if (typeof configId !== 'string' || !ID_PATTERN.test(configId) || !Array.isArray(projectIds) || projectIds.length < 1 || projectIds.length > 20 ||
      new Set(projectIds).size !== projectIds.length || projectIds.some(id => typeof id !== 'string' || !ID_PATTERN.test(id))) {
      throw new BadRequestException('请选择 1 至 20 个有效且不重复的项目。');
    }
    for (const projectId of projectIds) await this.access.assertProjectAccess(user, projectId, true);

    return this.prisma.$transaction(async tx => {
      // Match binding updates' project-before-config lock order. Check every
      // target under those locks before requeuing the first selected project.
      for (const projectId of [...projectIds].sort()) await tx.$queryRaw`SELECT id FROM Project WHERE id = ${projectId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM CdnConfig WHERE id = ${configId} FOR UPDATE`;
      const config = await tx.cdnConfig.findFirst({ where: { id: configId, enabled: true, projectId: null } });
      if (!config) throw new NotFoundException('存储配置不存在或已停用。');
      if (config.provider !== 'ALIYUN_DRIVE') throw new BadRequestException('当前仅支持将项目同步到阿里云盘。');
      this.assertPluginAvailable(config.provider);
      const projects = await tx.project.findMany({ where: { id: { in: projectIds }, enabled: true, deletedAt: null }, select: { id: true, name: true } });
      if (projects.length !== projectIds.length) throw new NotFoundException('所选项目不存在或已停用，请刷新后重试。');
      const bindings = await tx.projectStorageBinding.findMany({ where: { configId, projectId: { in: projectIds } }, select: { projectId: true } });
      const boundIds = new Set(bindings.map(binding => binding.projectId));
      if (projectIds.some(id => !boundIds.has(id))) throw new BadRequestException('请先将所选项目全部绑定到此存储。');
      const names = new Map(projects.map(project => [project.id, project.name]));
      const queued: QueuedProject[] = [];
      for (const projectId of projectIds) {
        const result = await this.replicas.enqueueProjectSync(projectId, configId, tx);
        queued.push({ projectId, projectName: names.get(projectId)!, ...result });
      }
      return { queuedProjects: queued.length, projects: queued };
    }, { timeout: 30_000 });
  }

  private assertPluginAvailable(provider: string): void {
    try {
      const manifest = this.registry.manifest(provider);
      const adapter = this.registry.adapter(provider);
      if (manifest?.capabilities.remoteFiles === true && typeof adapter.listRemoteFiles === 'function' && typeof adapter.readRemoteFile === 'function') return;
    } catch { /* expose one host-authored error for missing or unavailable plugins */ }
    throw new BadRequestException('阿里云盘插件未安装或不支持云端文件同步。');
  }
}
