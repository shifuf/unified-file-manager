import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';

import { BadRequestException, ForbiddenException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditAction, CdnProvider, Prisma, UserRole, type CdnConfig } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../common/types/request-user.type';
import { decryptText, encryptText } from '../common/utils/crypto.util';
import { getAppCryptoKey } from '../common/utils/security-config.util';
import { assertSafeOutboundUrl, normalizeOutboundUrl, safeFetch } from '../common/utils/ssrf-guard.util';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectAccessService } from '../projects/project-access.service';
import { StorageAdapterRegistry } from '../storage/storage-registry.service';
import { validateConfig } from '@ufm/storage-plugin-sdk';
import { ReplicaService } from '../storage/replica.service';
import { StorageLimitsService } from '../storage/storage-limits.service';
import type { RuntimeCdnConfig, StorageAdapter, StorageUsageSnapshot } from '../storage/storage.types';
import { CreateCdnConfigDto } from './dto/create-cdn-config.dto';
import { UpdateCdnConfigDto } from './dto/update-cdn-config.dto';
import { resolveUsageValue } from '../storage/storage-policy.util';

/**
 * Identity and secret fields that must be encrypted at rest and masked in API
 * responses. Matched as a whitelist (separators stripped, case-insensitive) plus
 * a broad pattern as a safety net, so credential fields such as `accessKey` /
 * `accessKeyId` / `operator` are never stored or returned in plaintext. Non-secret
 * fields like `bucket`, `endpoint`, `domain`, and `root` are intentionally excluded
 * so the UI can still display them.
 */
const SENSITIVE_CONFIG_FIELDS = new Set([
  'accesskey',
  'accesskeyid',
  'accesskeysecret',
  'secretkey',
  'secret',
  'password',
  'token',
  'privatekey',
  'operator',
]);
const SENSITIVE_CONFIG_PATTERN = /(secret|password|token|privatekey|accesskey|access_key|operator)/i;
const MASK_PLACEHOLDER = '******';
const VAULT_PREFIX = 'vault:';
const USAGE_CACHE_TTL_MS = 5 * 60 * 1000;

function isSensitiveConfigKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return SENSITIVE_CONFIG_FIELDS.has(normalized) || SENSITIVE_CONFIG_PATTERN.test(key);
}

type HealthCheck = {
  name: string;
  status: 'PASS' | 'WARN' | 'FAIL' | 'SKIP';
  message: string;
};

type StorageUsageResponse = {
  provider: string;
  name: string;
  configId: string;
  supported: boolean;
  storageUsedBytes: number | null;
  storageQuotaBytes: number | null;
  trafficUsedBytes: number | null;
  trafficQuotaBytes: number | null;
  storageUsedSource?: string;
  storageQuotaSource?: string;
  trafficUsedSource?: string;
  trafficQuotaSource?: string;
  policy?: { priority: number; failoverThresholdPercent: number; autoFailover: boolean; manualUsageUpdatedAt: string | null };
  checkedAt: string;
  message?: string;
  limits?: ReturnType<StorageLimitsService['describe']>;
};

@Injectable()
export class CdnService {
  private readonly usageCache = new Map<string, { expiresAt: number; value: StorageUsageResponse }>();

  constructor(
    private readonly auditService: AuditService,
    private readonly registry: StorageAdapterRegistry,
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly projectAccessService: ProjectAccessService,
    @Optional() private readonly replicaService?: ReplicaService,
    @Optional() private readonly storageLimits?: StorageLimitsService,
  ) {}

  async list(user: RequestUser): Promise<Record<string, unknown>[]> {
    await this.assertCanManageStorage(user, true);
    const configs = await this.prisma.cdnConfig.findMany({
      where: { enabled: true, projectId: null },
      orderBy: [{ provider: 'asc' }, { createdAt: 'desc' }],
      include: { projectBindings: { where: { project: { deletedAt: null } }, include: { project: { select: { id: true, name: true, activeCdnConfigId: true } } } } },
    });

    return configs.map((config) => this.toResponse(config));
  }

  async listForProject(projectId: string, user: RequestUser): Promise<Record<string, unknown>[]> {
    await this.projectAccessService.assertProjectAccess(user, projectId);
    const [project, configs] = await Promise.all([
      this.prisma.project.findUnique({
        where: { id: projectId },
        select: { activeCdnConfigId: true },
      }),
      this.prisma.cdnConfig.findMany({
        where: {
          enabled: true,
          projectId: null,
          projectBindings: { some: { projectId } },
        },
        orderBy: [{ provider: 'asc' }, { createdAt: 'desc' }],
      }),
    ]);

    const activeConfigId = project?.activeCdnConfigId ?? null;
    return configs.map((config) => this.toResponse(config, activeConfigId));
  }

  async create(dto: CreateCdnConfigDto, user: RequestUser): Promise<Record<string, unknown>> {
    await this.assertCanManageStorage(user, true);
    await this.assertRemoteConfigHostsSafe(dto.provider, dto.config);
    await this.assertConfigHealthy(dto.provider, dto.name, dto.config, user);
    const config = await this.prisma.cdnConfig.create({
      data: {
        provider: dto.provider,
        name: dto.name,
        config: this.secureConfig(dto.config, dto.provider),
        active: false,
        ...this.storagePolicyData(dto),
      },
    });

    await this.auditService.write({
      action: AuditAction.CDN_CREATE,
      actorId: user.id,
      detail: { provider: dto.provider, name: dto.name, storageConfigId: config.id },
    });

    return this.toResponse(config);
  }

  async createForProject(
    projectId: string,
    dto: CreateCdnConfigDto,
    user: RequestUser,
  ): Promise<Record<string, unknown>> {
    await this.projectAccessService.assertProjectAccess(user, projectId, true);
    const config = await this.create(dto, user);
    await this.prisma.projectStorageBinding.create({ data: { projectId, configId: String(config.id) } });
    if (dto.active) return this.selectForProject(projectId, String(config.id), user);
    return config;
  }

  async update(configId: string, dto: UpdateCdnConfigDto, user: RequestUser): Promise<Record<string, unknown>> {
    await this.assertCanManageStorage(user, true);
    const existing = await this.findConfig(configId);
    const mergedConfig = dto.config || (dto.provider && dto.provider !== existing.provider)
      ? this.mergeConfigPreservingSecrets(this.revealConfig(existing.config), dto.config ?? {})
      : undefined;

    if (mergedConfig) {
      const provider = dto.provider ?? existing.provider;
      this.assertImmutablePluginConfig(existing, provider, mergedConfig);
      await this.assertRemoteConfigHostsSafe(provider, mergedConfig);
      await this.assertConfigHealthy(provider, dto.name ?? existing.name, mergedConfig, user);
    }

    const save = async (db: Prisma.TransactionClient, current: CdnConfig) => {
      if (dto.manualStorageUsedBytes !== undefined) await db.storageSpaceReservation.deleteMany({ where: { configId } });
      return db.cdnConfig.update({
      where: { id: configId },
      data: { provider: dto.provider, name: dto.name,
        config: mergedConfig ? this.secureConfig(mergedConfig, dto.provider ?? existing.provider) : undefined,
        ...this.storagePolicyData(dto, current) },
      });
    };
    const quotaKeys = ['storageLimitEnabled', 'trafficLimitEnabled', 'trafficQuotaMode', 'storageQuotaBytes',
      'manualStorageUsedBytes', 'trafficQuotaBytes', 'manualTrafficUsedBytes', 'failoverThresholdPercent'] as const;
    const config = quotaKeys.some(key => dto[key] !== undefined)
      ? await this.prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM CdnConfig WHERE id = ${configId} FOR UPDATE`;
        const current = await tx.cdnConfig.findFirst({ where: { id: configId, enabled: true } });
        if (!current) throw new NotFoundException('存储配置不存在或已停用。');
        return save(tx, current);
      })
      : await save(this.prisma, existing);
    this.usageCache.delete(configId);

    await this.auditService.write({
      action: AuditAction.CDN_UPDATE,
      actorId: user.id,
      detail: { configId, provider: dto.provider, name: dto.name },
    });

    return this.toResponse(config);
  }

  async updateForProject(
    projectId: string,
    configId: string,
    dto: UpdateCdnConfigDto,
    user: RequestUser,
  ): Promise<Record<string, unknown>> {
    await this.projectAccessService.assertProjectAccess(user, projectId, true);
    await this.findConfigForProject(configId, projectId);
    return this.update(configId, dto, user);
  }

  async selectForProject(
    projectId: string,
    configId: string,
    user: RequestUser,
  ): Promise<Record<string, unknown>> {
    await this.projectAccessService.assertProjectAccess(user, projectId, true);
    const config = await this.findConfigForProject(configId, projectId);
    const project = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM Project WHERE id = ${projectId} FOR UPDATE`;
      const binding = await tx.projectStorageBinding.findUnique({ where: { projectId_configId: { projectId, configId } } });
      if (!binding) throw new BadRequestException('请先在全局存储页面为此项目分配该存储。');
      return tx.project.update({
        where: { id: projectId },
        data: { activeCdnConfigId: config.id },
        include: { activeCdnConfig: true },
      });
    });

    await this.auditService.write({
      action: AuditAction.CDN_ACTIVATE,
      actorId: user.id,
      projectId,
      detail: { configId, provider: config.provider, name: config.name },
    });

    return this.toResponse(config, project.activeCdnConfigId);
  }

  async listAssignments(configId: string, user: RequestUser) {
    await this.assertCanManageStorage(user, true);
    await this.findConfig(configId);
    const rows = await this.prisma.projectStorageBinding.findMany({
      where: { configId, project: { deletedAt: null } },
      include: { project: { select: { id: true, name: true, activeCdnConfigId: true } } },
      orderBy: { projectId: 'asc' },
    });
    return rows.map(({ project }) => ({ id: project.id, name: project.name, current: project.activeCdnConfigId === configId }));
  }

  async assignProjects(configId: string, projectIds: string[], user: RequestUser) {
    await this.assertCanManageStorage(user, true);
    await this.findConfig(configId);
    const ids = [...new Set(projectIds)];
    await this.runBindingTransaction(async (tx) => {
      await this.replaceAssignments(tx, configId, ids);
      if (this.replicaService) {
        for (const projectId of ids) await this.replicaService.enqueueProject(projectId, '', tx);
      }
    });
    await this.auditService.write({ action: AuditAction.CDN_UPDATE, actorId: user.id, detail: { configId, projectIds: ids, operation: 'assign-projects' } });
    return this.listAssignments(configId, user);
  }

  async remove(configId: string, user: RequestUser, force = false): Promise<{ success: boolean }> {
    await this.assertCanManageStorage(user, true);
    const activeProjectCount = await this.runBindingTransaction((tx) => this.replaceAssignments(tx, configId, [], true, force));
    this.usageCache.delete(configId);

    await this.auditService.write({
      action: AuditAction.CDN_DELETE,
      actorId: user.id,
      detail: { configId, detachedProjects: activeProjectCount, forced: force },
    });

    return { success: true };
  }

  private async runBindingTransaction<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.prisma.$transaction(operation);
      } catch (error) {
        const deadlock = error instanceof Prisma.PrismaClientKnownRequestError
          && (error.code === 'P2034' || (error.code === 'P2010' && String(error.meta?.code) === '1213'));
        if (!deadlock || attempt >= 3) throw error;
      }
    }
  }

  private async replaceAssignments(
    tx: Prisma.TransactionClient,
    configId: string,
    ids: string[],
    removing = false,
    force = false,
  ): Promise<number> {
    // A locking read serializes this config's binding range without opening a
    // repeatable-read snapshot before waiting for the affected project locks.
    const current = await tx.$queryRaw<Array<{ projectId: string }>>`
      SELECT projectId FROM ProjectStorageBinding WHERE configId = ${configId} FOR UPDATE
    `;
    const affected = [...new Set([...ids, ...current.map((binding) => binding.projectId)])].sort();
    for (const id of affected) await tx.$queryRaw`SELECT id FROM Project WHERE id = ${id} FOR UPDATE`;
    // Selection and failover lock Project before the CdnConfig foreign key.
    await tx.$queryRaw`SELECT id FROM CdnConfig WHERE id = ${configId} FOR UPDATE`;
    const config = await tx.cdnConfig.findFirst({ where: { id: configId, enabled: true, projectId: null } });
    if (!config) throw new NotFoundException('存储配置不存在。');
    const activeProjectCount = removing
      ? await tx.project.count({ where: { activeCdnConfigId: configId, deletedAt: null } })
      : 0;
    if (activeProjectCount > 0 && !force) {
      throw new BadRequestException(`该存储配置仍被 ${activeProjectCount} 个项目使用，请先切换项目存储，或选择“强制删除”自动解绑。`);
    }
    if (removing) await this.assertNotLastLocalConfig(config, tx);
    const projects = await tx.project.findMany({ where: { id: { in: ids }, deletedAt: null } });
    if (projects.length !== ids.length) throw new BadRequestException('包含不存在或已删除的项目。');
    const removed = current.map((binding) => binding.projectId).filter((id) => !ids.includes(id));
    for (const projectId of removed) {
      const project = await tx.project.findUnique({ where: { id: projectId } });
      if (project?.deletedAt || project?.activeCdnConfigId !== configId) continue;
      const replacement = await tx.cdnConfig.findFirst({
        where: { id: { not: configId }, enabled: true, projectId: null, projectBindings: { some: { projectId } } },
        orderBy: [{ priority: 'asc' }, { id: 'asc' }],
      });
      if (!replacement) throw new BadRequestException(`项目“${project.name}”没有其他已分配存储，请先分配后再解绑。`);
      await tx.project.update({ where: { id: projectId }, data: { activeCdnConfigId: replacement.id } });
    }
    await tx.projectStorageBinding.deleteMany({ where: { configId, projectId: { notIn: ids } } });
    if (ids.length) await tx.projectStorageBinding.createMany({ data: ids.map((projectId) => ({ projectId, configId })), skipDuplicates: true });
    if (removing) await tx.cdnConfig.update({ where: { id: configId }, data: { enabled: false, active: false } });
    return activeProjectCount;
  }

  async removeForProject(
    projectId: string,
    configId: string,
    user: RequestUser,
    _force = false,
  ): Promise<{ success: boolean }> {
    await this.projectAccessService.assertProjectAccess(user, projectId, true);
    await this.findConfigForProject(configId, projectId);
    throw new BadRequestException('存储配置由多个项目共享，请在全局存储管理中解除项目绑定或删除配置。');
  }

  /** Dry-run a configuration that has not been saved yet (create dialog gate). */
  async testDraft(
    dto: CreateCdnConfigDto,
    user: RequestUser,
    projectId?: string,
  ): Promise<Record<string, unknown>> {
    if (projectId) {
      await this.projectAccessService.assertProjectAccess(user, projectId, true);
    } else {
      await this.assertCanManageStorage(user, true);
    }

    await this.assertRemoteConfigHostsSafe(dto.provider, dto.config);
    const checks =
      dto.provider === CdnProvider.LOCAL
        ? await this.testLocalConfig(dto.config)
        : await this.testRemoteConfig(dto.provider, dto.name, dto.config);
    const success = checks.every((check) => check.status !== 'FAIL');

    await this.auditService.write({
      action: AuditAction.CDN_HEALTH_CHECK,
      actorId: user.id,
      projectId,
      detail: { provider: dto.provider, name: dto.name, success, draft: true },
    });

    return {
      provider: dto.provider,
      name: dto.name,
      success,
      checks,
      checkedAt: new Date().toISOString(),
    };
  }

  /**
   * Dry-run an edit: masked secrets in the dialog are replaced with the stored
   * values so the probe tests what will actually be saved.
   */
  async testDraftForConfig(
    configId: string,
    dto: UpdateCdnConfigDto,
    user: RequestUser,
    projectId?: string,
  ): Promise<Record<string, unknown>> {
    if (projectId) {
      await this.projectAccessService.assertProjectAccess(user, projectId, true);
    } else {
      await this.assertCanManageStorage(user, true);
    }

    const existing = projectId
      ? await this.findConfigForProject(configId, projectId)
      : await this.findConfig(configId);
    const provider = dto.provider ?? existing.provider;
    const name = dto.name ?? existing.name;
    const merged = this.mergeConfigPreservingSecrets(
      this.revealConfig(existing.config),
      dto.config ?? {},
    );

    this.assertImmutablePluginConfig(existing, provider, merged);

    await this.assertRemoteConfigHostsSafe(provider, merged);

    const checks =
      provider === CdnProvider.LOCAL
        ? await this.testLocalConfig(merged)
        : await this.testRemoteConfig(provider, name, merged);
    const success = checks.every((check) => check.status !== 'FAIL');

    await this.auditService.write({
      action: AuditAction.CDN_HEALTH_CHECK,
      actorId: user.id,
      projectId,
      detail: { configId, provider, name, success, draft: true },
    });

    return {
      provider,
      name,
      success,
      checks,
      checkedAt: new Date().toISOString(),
    };
  }

  async test(configId: string, user: RequestUser): Promise<Record<string, unknown>> {
    await this.assertCanManageStorage(user, true);
    const config = await this.findConfig(configId);
    return this.testConfig(config, user);
  }

  private assertImmutablePluginConfig(existing: CdnConfig, provider: string, next: Record<string, unknown>) {
    const manifest = this.registry?.manifest(existing.provider);
    if (!manifest?.capabilities.authentication) return;
    const previous = this.revealConfig(existing.config);
    if (provider !== existing.provider || manifest.fields.some(field => field.immutable &&
      (previous[field.key] ?? field.default) !== (next[field.key] ?? field.default))) {
      throw new BadRequestException('已有网盘配置不能更换账号、云盘或对象根目录。请新建存储配置并迁移文件。');
    }
  }

  async testForProject(projectId: string, configId: string, user: RequestUser): Promise<Record<string, unknown>> {
    await this.projectAccessService.assertProjectAccess(user, projectId, true);
    const config = await this.findConfigForProject(configId, projectId);
    return this.testConfig(config, user, projectId);
  }

  async getUsage(configId: string, user: RequestUser, forceRefresh = false): Promise<StorageUsageResponse> {
    await this.assertCanManageStorage(user, true);
    const config = await this.findConfig(configId);
    return this.fetchUsage(config, forceRefresh);
  }

  async getUsageForProject(
    projectId: string,
    configId: string,
    user: RequestUser,
    forceRefresh = false,
  ): Promise<StorageUsageResponse> {
    await this.projectAccessService.assertProjectAccess(user, projectId);
    const config = await this.findConfigForProject(configId, projectId);
    return this.fetchUsage(config, forceRefresh);
  }

  revealConfig(config: Prisma.JsonValue): Record<string, unknown> {
    const cryptoKey = getAppCryptoKey(this.configService);
    const source = this.asRecord(config);
    return Object.fromEntries(
      Object.entries(source).map(([key, value]) => {
        if (typeof value === 'string' && value.startsWith(VAULT_PREFIX)) {
          return [key, decryptText(value.slice(VAULT_PREFIX.length), cryptoKey)];
        }

        return [key, value];
      }),
    );
  }

  /**
   * Hard gate for writes: a configuration is only persisted after its own
   * connectivity probe (upload + read + delete) has passed.
   */
  /** The shared LOCAL fallback must survive: without it uploads have nowhere to go. */
  private async assertNotLastLocalConfig(config: CdnConfig, client: Prisma.TransactionClient = this.prisma): Promise<void> {
    if (config.provider !== CdnProvider.LOCAL) {
      return;
    }

    const remaining = await client.cdnConfig.count({
      where: { enabled: true, provider: CdnProvider.LOCAL, id: { not: config.id } },
    });

    if (remaining === 0) {
      throw new BadRequestException('这是最后一个可用的本地存储配置，删除后项目将无法上传，已阻止操作。');
    }
  }

  private async assertConfigHealthy(
    provider: string,
    name: string,
    config: Record<string, unknown>,
    user: RequestUser,
    projectId?: string,
  ): Promise<void> {
    const checks =
      provider === CdnProvider.LOCAL
        ? await this.testLocalConfig(config)
        : await this.testRemoteConfig(provider, name, config);
    const failed = checks.filter((check) => check.status === 'FAIL');

    await this.auditService.write({
      action: AuditAction.CDN_HEALTH_CHECK,
      actorId: user.id,
      projectId,
      detail: { provider, name, success: failed.length === 0, gate: 'create-or-update' },
    });

    if (failed.length > 0) {
      throw new BadRequestException(
        `存储测试未通过，无法保存：${failed.map((check) => `${check.name} - ${check.message}`).join('；')}`,
      );
    }
  }

  private async assertCanManageStorage(user: RequestUser, requireSuperAdmin: boolean): Promise<void> {
    if (requireSuperAdmin && user.role !== UserRole.SUPER_ADMIN) {
      throw new ForbiddenException('只有超级管理员可以维护公共存储配置。');
    }
  }

  private async findConfig(configId: string): Promise<CdnConfig> {
    const config = await this.prisma.cdnConfig.findFirst({
      where: { id: configId, enabled: true, projectId: null },
    });

    if (!config) {
      throw new NotFoundException('存储配置不存在。');
    }

    return config;
  }

  private async findConfigForProject(configId: string, projectId: string): Promise<CdnConfig> {
    const config = await this.prisma.cdnConfig.findFirst({
      where: {
        id: configId,
        enabled: true,
        projectId: null,
        projectBindings: { some: { projectId } },
      },
    });

    if (!config) {
      throw new NotFoundException('存储配置不存在。');
    }

    return config;
  }

  private dedupeConfigs(configs: CdnConfig[], activeConfigId: string | null = null): CdnConfig[] {
    const selected = new Map<string, CdnConfig>();

    for (const config of configs) {
      const key = this.getConfigDedupeKey(config);
      const existing = selected.get(key);

      if (!existing || this.shouldReplaceDuplicateConfig(existing, config, activeConfigId)) {
        selected.set(key, config);
      }
    }

    return Array.from(selected.values());
  }

  private shouldReplaceDuplicateConfig(existing: CdnConfig, candidate: CdnConfig, activeConfigId: string | null): boolean {
    if (candidate.id === activeConfigId) {
      return true;
    }

    if (existing.id === activeConfigId) {
      return false;
    }

    return existing.projectId === null && candidate.projectId !== null;
  }

  private getConfigDedupeKey(config: CdnConfig): string {
    if (config.provider !== CdnProvider.LOCAL) {
      return config.id;
    }

    const localConfig = this.asRecord(config.config);
    const root = this.normalizeConfigValue(localConfig.root);
    const domain = this.normalizeConfigValue(localConfig.domain);
    return `${config.provider}:${root}:${domain}`;
  }

  private normalizeConfigValue(value: unknown): string {
    return String(value ?? '').trim().replace(/\\/g, '/').replace(/\/+$/g, '').toLowerCase();
  }

  private storagePolicyData(dto: CreateCdnConfigDto | UpdateCdnConfigDto, current?: CdnConfig) {
    const data: Partial<Pick<CdnConfig, 'priority' | 'storageQuotaBytes' | 'manualStorageUsedBytes' | 'trafficQuotaBytes' |
      'manualTrafficUsedBytes' | 'failoverThresholdPercent' | 'autoFailover' | 'manualUsageUpdatedAt' |
      'storageLimitEnabled' | 'trafficLimitEnabled' | 'trafficQuotaMode' | 'trafficPeriodKey' | 'quotaRevision' | 'trackedStorageBytes' | 'storageBaselineBytes'>> = {};
    const quotaKeys = ['storageLimitEnabled', 'trafficLimitEnabled', 'trafficQuotaMode', 'storageQuotaBytes',
      'manualStorageUsedBytes', 'trafficQuotaBytes', 'manualTrafficUsedBytes', 'failoverThresholdPercent'] as const;
    if (current && !quotaKeys.some(key => dto[key] !== undefined)) {
      return { ...(dto.priority === undefined ? {} : { priority: dto.priority }),
        ...(dto.autoFailover === undefined ? {} : { autoFailover: dto.autoFailover }) };
    }
    for (const key of ['storageQuotaBytes', 'manualStorageUsedBytes', 'trafficQuotaBytes', 'manualTrafficUsedBytes'] as const) {
      const value = dto[key];
      if (value !== undefined && value !== null && (!Number.isSafeInteger(value) || value < 0)) {
        throw new BadRequestException('额度和已用字节数必须为非负安全整数。');
      }
    }
    for (const key of ['storageLimitEnabled', 'trafficLimitEnabled'] as const) {
      if (dto[key] !== undefined && typeof dto[key] !== 'boolean') throw new BadRequestException('限额开关必须为布尔值。');
      if (dto[key] !== undefined) data[key] = dto[key];
    }
    if (dto.trafficQuotaMode !== undefined) {
      if (!['MONTHLY', 'FIXED'].includes(dto.trafficQuotaMode)) throw new BadRequestException('请选择每月或固定流量额度。');
      data.trafficQuotaMode = dto.trafficQuotaMode;
    }
    const enabled = dto.trafficLimitEnabled ?? current?.trafficLimitEnabled ?? false;
    const quota = dto.trafficQuotaBytes !== undefined ? dto.trafficQuotaBytes : current?.trafficQuotaBytes;
    if (enabled && quota == null) throw new BadRequestException('启用流量限制时必须填写流量额度。');
    if (dto.priority !== undefined) data.priority = dto.priority;
    if (dto.storageQuotaBytes !== undefined) data.storageQuotaBytes = dto.storageQuotaBytes === null ? null : BigInt(dto.storageQuotaBytes);
    if (dto.manualStorageUsedBytes !== undefined) data.manualStorageUsedBytes = dto.manualStorageUsedBytes === null ? null : BigInt(dto.manualStorageUsedBytes);
    if (dto.trafficQuotaBytes !== undefined) data.trafficQuotaBytes = dto.trafficQuotaBytes === null ? null : BigInt(dto.trafficQuotaBytes);
    if (dto.manualTrafficUsedBytes !== undefined) data.manualTrafficUsedBytes = dto.manualTrafficUsedBytes === null ? null : BigInt(dto.manualTrafficUsedBytes);
    if (dto.failoverThresholdPercent !== undefined) data.failoverThresholdPercent = dto.failoverThresholdPercent;
    if (dto.autoFailover !== undefined) data.autoFailover = dto.autoFailover;
    if (dto.manualStorageUsedBytes !== undefined || dto.manualTrafficUsedBytes !== undefined) data.manualUsageUpdatedAt = new Date();
    if (dto.manualStorageUsedBytes !== undefined) { data.trackedStorageBytes = 0n; data.storageBaselineBytes = null; }
    const changed = Object.entries(data).some(([key, value]) => !['priority', 'autoFailover'].includes(key) && value !== current?.[key as keyof CdnConfig]);
    if (changed && current) data.quotaRevision = (current.quotaRevision ?? 0) + 1;
    const mode = dto.trafficQuotaMode ?? current?.trafficQuotaMode ?? 'FIXED';
    const period = this.storageLimits?.currentPeriodKey() ?? new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 7);
    const modeChanged = dto.trafficQuotaMode !== undefined && dto.trafficQuotaMode !== current?.trafficQuotaMode;
    const monthlyReset = enabled && mode === 'MONTHLY' && current?.trafficPeriodKey !== period;
    if (modeChanged || monthlyReset || dto.manualTrafficUsedBytes !== undefined || !current) {
      data.trafficPeriodKey = mode === 'MONTHLY' ? period : null;
      if (dto.manualTrafficUsedBytes === undefined && current) {
        data.manualTrafficUsedBytes = monthlyReset && current.trafficQuotaMode === 'MONTHLY' ? 0n
          : BigInt(this.storageLimits?.describe(current).trafficUsedBytes ?? current.manualTrafficUsedBytes ?? 0n);
      }
      if (current) data.quotaRevision = (current.quotaRevision ?? 0) + 1;
    }
    return data;
  }

  private secureConfig(config: Record<string, unknown>, provider?: string): Prisma.InputJsonObject {
    const cryptoKey = getAppCryptoKey(this.configService);
    return Object.fromEntries(
      Object.entries(config).map(([key, value]) => {
        if (typeof value === 'string' && this.sensitive(key, provider) && !value.startsWith(VAULT_PREFIX)) {
          return [key, `${VAULT_PREFIX}${encryptText(value, cryptoKey)}`];
        }

        return [key, value as Prisma.InputJsonValue];
      }),
    );
  }

  /**
   * Merge an incoming config update over the existing (decrypted) config without
   * letting a masked placeholder overwrite a real secret. The list/detail endpoints
   * return secret fields as `******`; if the client submits that value back on save
   * we must keep the stored secret instead of encrypting the literal `******`.
   */
  private mergeConfigPreservingSecrets(
    existing: Record<string, unknown>,
    incoming: Record<string, unknown>,
  ): Record<string, unknown> {
    const merged: Record<string, unknown> = { ...existing };

    for (const [key, value] of Object.entries(incoming)) {
      if (value === MASK_PLACEHOLDER) {
        continue;
      }

      merged[key] = value;
    }

    return merged;
  }

  /**
   * Reject remote storage configs whose `endpoint` / `domain` point at internal
   * addresses, so a project admin cannot turn the server's storage health check or
   * object fetch into an SSRF probe of the internal network (e.g. cloud metadata).
   * On-prem S3-compatible gateways can opt out via STORAGE_ALLOW_PRIVATE_ENDPOINTS.
   */
  private async assertRemoteConfigHostsSafe(
    provider: string | undefined,
    config: Record<string, unknown>,
  ): Promise<void> {
    if (!provider || provider === CdnProvider.LOCAL) {
      return;
    }

    const manifest = this.registry?.manifest(provider);
    if (!manifest) throw new BadRequestException(`存储插件 ${provider} 未安装。`);
    let normalized: Record<string, unknown>;
    try { normalized = validateConfig(manifest, config); } catch (error) { throw new BadRequestException(this.errorMessage(error)); }
    Object.assign(config, normalized);
    for (const field of new Set(['endpoint', 'domain', ...manifest.fields.filter(field => field.url).map(field => field.key)])) {
      const raw = config[field];
      if (typeof raw !== 'string' || !raw.trim()) {
        continue;
      }

      try {
        await assertSafeOutboundUrl(normalizeOutboundUrl(raw));
      } catch (error) {
        const reason = error instanceof Error && error.message ? error.message : '地址不安全';
        throw new BadRequestException(`存储配置的 ${field} 不可用：${reason}`);
      }
    }
  }

  private toResponse(
    config: {
      id: string;
      projectId: string | null;
      provider: string;
      name: string;
      config: Prisma.JsonValue;
      active: boolean;
      enabled: boolean;
      priority: number;
      storageQuotaBytes: bigint | null;
      manualStorageUsedBytes: bigint | null;
      trafficQuotaBytes: bigint | null;
      manualTrafficUsedBytes: bigint | null;
      failoverThresholdPercent: number;
      autoFailover: boolean;
      manualUsageUpdatedAt: Date | null;
      storageLimitEnabled?: boolean;
      trafficLimitEnabled?: boolean;
      trafficQuotaMode?: string;
      trafficPeriodKey?: string | null;
      trackedStorageBytes?: bigint;
      storageBaselineBytes?: bigint | null;
      createdAt: Date;
      updatedAt: Date;
      projectBindings?: Array<{ project: { id: string; name: string; activeCdnConfigId: string | null } }>;
    },
    activeConfigId?: string | null,
  ): Record<string, unknown> {
    return {
      id: config.id,
      projectId: config.projectId,
      provider: config.provider,
      name: config.name,
      config: this.maskConfig(config.config, config.provider),
      pluginAvailable: config.provider === 'LOCAL' || Boolean(this.registry?.list().some(p => p.id === config.provider && p.available)),
      active: activeConfigId ? config.id === activeConfigId : false,
      enabled: config.enabled,
      priority: config.priority,
      storageQuotaBytes: config.storageQuotaBytes?.toString() ?? null,
      manualStorageUsedBytes: config.manualStorageUsedBytes?.toString() ?? null,
      trafficQuotaBytes: config.trafficQuotaBytes?.toString() ?? null,
      manualTrafficUsedBytes: config.manualTrafficUsedBytes?.toString() ?? null,
      ...this.storageLimits?.describe(config),
      storageBaselineBytes: config.storageBaselineBytes?.toString() ?? null,
      failoverThresholdPercent: config.failoverThresholdPercent,
      autoFailover: config.autoFailover,
      manualUsageUpdatedAt: config.manualUsageUpdatedAt,
      createdAt: config.createdAt,
      updatedAt: config.updatedAt,
      projects: config.projectBindings?.map(({ project }) => ({ id: project.id, name: project.name, current: project.activeCdnConfigId === config.id })) ?? [],
    };
  }

  private sensitive(key: string, provider?: string): boolean {
    return isSensitiveConfigKey(key) || Boolean(provider && this.registry?.manifest(provider)?.fields.some(field => field.key === key && field.secret));
  }

  private maskConfig(config: Prisma.JsonValue, provider?: string): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(this.asRecord(config)).map(([key, value]) => [
        key,
        (this.sensitive(key, provider) || (typeof value === 'string' && value.startsWith(VAULT_PREFIX))) && value ? MASK_PLACEHOLDER : value,
      ]),
    );
  }

  private asRecord(config: Prisma.JsonValue): Record<string, unknown> {
    if (!config || Array.isArray(config) || typeof config !== 'object') {
      return {};
    }

    return config as Record<string, unknown>;
  }

  private async testConfig(
    config: CdnConfig,
    user: RequestUser,
    projectId?: string,
  ): Promise<Record<string, unknown>> {
    const revealedConfig = this.revealConfig(config.config);
    const checks =
      config.provider === CdnProvider.LOCAL
        ? await this.testLocalConfig(revealedConfig)
        : await this.testRemoteConfig(config.provider, config.name, revealedConfig);
    const success = checks.every((check) => check.status !== 'FAIL');

    await this.auditService.write({
      action: AuditAction.CDN_HEALTH_CHECK,
      actorId: user.id,
      projectId,
      detail: { configId: config.id, provider: config.provider, success },
    });

    let usage: StorageUsageResponse | null = null;
    try {
      usage = await this.fetchUsage(config, true);
    } catch {
      usage = null;
    }

    return {
      success,
      provider: config.provider,
      name: config.name,
      checkedAt: new Date(),
      checks,
      usage,
    };
  }

  private async fetchUsage(config: CdnConfig, forceRefresh: boolean): Promise<StorageUsageResponse> {
    const cached = this.usageCache.get(config.id);
    if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
      return { ...cached.value, limits: this.storageLimits?.describe(config) };
    }

    const adapter = this.usageAdapter(config.provider);
    if (!adapter?.getUsage) {
      const unsupported: StorageUsageResponse = {
        provider: config.provider,
        name: config.name,
        configId: config.id,
        supported: false,
        storageUsedBytes: null,
        storageQuotaBytes: null,
        trafficUsedBytes: null,
        trafficQuotaBytes: null,
        checkedAt: new Date().toISOString(),
        message: '当前平台不支持云用量查询。',
      };
      const result = this.applyUsagePolicy(config, unsupported);
      this.usageCache.set(config.id, { expiresAt: Date.now() + USAGE_CACHE_TTL_MS, value: result });
      return result;
    }

    const runtimeConfig: RuntimeCdnConfig = {
      id: config.id,
      provider: config.provider,
      name: config.name,
      config: this.revealConfig(config.config),
    };

    let snapshot: StorageUsageSnapshot;
    try {
      snapshot = await adapter.getUsage(runtimeConfig);
    } catch (error) {
      const failed: StorageUsageResponse = {
        provider: config.provider,
        name: config.name,
        configId: config.id,
        supported: true,
        storageUsedBytes: null,
        storageQuotaBytes: null,
        trafficUsedBytes: null,
        trafficQuotaBytes: null,
        checkedAt: new Date().toISOString(),
        message: error instanceof Error ? error.message : String(error),
      };
      const result = this.applyUsagePolicy(config, failed);
      this.usageCache.set(config.id, { expiresAt: Date.now() + 60_000, value: result });
      return result;
    }

    const value: StorageUsageResponse = {
      provider: config.provider,
      name: config.name,
      configId: config.id,
      supported: true,
      storageUsedBytes: snapshot.storageUsedBytes ?? null,
      storageQuotaBytes: snapshot.storageQuotaBytes ?? null,
      trafficUsedBytes: snapshot.trafficUsedBytes ?? null,
      trafficQuotaBytes: snapshot.trafficQuotaBytes ?? null,
      checkedAt: snapshot.checkedAt || new Date().toISOString(),
      message: snapshot.message,
    };
    const result = this.applyUsagePolicy(config, value);
    this.usageCache.set(config.id, { expiresAt: Date.now() + USAGE_CACHE_TTL_MS, value: result });
    return result;
  }

  private applyUsagePolicy(config: CdnConfig, reported: StorageUsageResponse): StorageUsageResponse {
    const storageUsed = resolveUsageValue(reported.storageUsedBytes, config.manualStorageUsedBytes);
    const storageQuota = resolveUsageValue(reported.storageQuotaBytes, config.storageQuotaBytes);
    const trafficUsed = resolveUsageValue(reported.trafficUsedBytes, config.manualTrafficUsedBytes);
    const trafficQuota = resolveUsageValue(reported.trafficQuotaBytes, config.trafficQuotaBytes);
    return {
      ...reported,
      limits: this.storageLimits?.describe(config),
      storageUsedBytes: storageUsed.value,
      storageQuotaBytes: storageQuota.value,
      trafficUsedBytes: trafficUsed.value,
      trafficQuotaBytes: trafficQuota.value,
      storageUsedSource: storageUsed.source,
      storageQuotaSource: storageQuota.source,
      trafficUsedSource: trafficUsed.source,
      trafficQuotaSource: trafficQuota.source,
      policy: {
        priority: config.priority,
        failoverThresholdPercent: config.failoverThresholdPercent,
        autoFailover: config.autoFailover,
        manualUsageUpdatedAt: config.manualUsageUpdatedAt?.toISOString() ?? null,
      },
    };
  }

  private usageAdapter(provider: string): StorageAdapter | null {
    try { return this.registry?.manifest(provider)?.capabilities.usage ? this.registry.adapter(provider) : null; }
    catch { return null; }
  }

  private async testLocalConfig(config: Record<string, unknown>): Promise<HealthCheck[]> {
    const root = String(config.root ?? './storage');
    const storageRoot = resolve(isAbsolute(root) ? root : resolve(this.workspaceRoot(), root));
    const probePath = resolve(storageRoot, `.healthcheck-${Date.now()}-${randomBytes(4).toString('hex')}.tmp`);
    const checks: HealthCheck[] = [
      {
        name: 'root',
        status: 'PASS',
        message: storageRoot,
      },
    ];

    try {
      await mkdir(storageRoot, { recursive: true });
      await access(storageRoot, constants.R_OK | constants.W_OK);
      await writeFile(probePath, 'ok');
      await rm(probePath, { force: true });
      checks.push({ name: 'write', status: 'PASS', message: '本地目录可读写。' });
    } catch (error) {
      checks.push({
        name: 'write',
        status: 'FAIL',
        message: error instanceof Error && error.message ? error.message : '本地目录不可读写。',
      });
    }

    if (!String(config.domain ?? '').trim()) {
      checks.push({ name: 'domain', status: 'WARN', message: '未配置访问域名，公开 URL 可能不可用。' });
    } else {
      checks.push({ name: 'domain', status: 'PASS', message: String(config.domain) });
    }

    return checks;
  }

  private async testRemoteConfig(provider: string, name: string, config: Record<string, unknown>): Promise<HealthCheck[]> {
    const manifest = this.registry.manifest(provider);
    if (!manifest) throw new BadRequestException(`存储插件 ${provider} 未安装。`);
    config = validateConfig(manifest, config);
    const checks: HealthCheck[] = [{ name: 'config', status: 'PASS', message: '插件配置校验通过。' }];

    const adapter = this.remoteAdapter(provider);
    const key = `.healthcheck/${Date.now()}-${randomBytes(4).toString('hex')}.txt`;
    const runtimeConfig: RuntimeCdnConfig = {
      id: 'health-check',
      provider,
      name,
      config,
    };

    // Upload is the hard requirement: it proves the credentials, bucket and endpoint.
    try {
      await adapter.upload(runtimeConfig, {
        key,
        buffer: Buffer.from('ok'),
        mimeType: 'text/plain',
        originalName: 'healthcheck.txt',
      });
      checks.push({ name: 'upload', status: 'PASS', message: '探测对象上传成功。' });
    } catch (error) {
      checks.push({ name: 'upload', status: 'FAIL', message: this.errorMessage(error) });
      return checks;
    }

    try {
      if (manifest.capabilities.backupOnly) {
        if (!adapter.verifyBackup) throw new Error('备份插件缺少元数据确认能力。');
        const checksum = createHash('sha256').update('ok').digest('hex');
        await adapter.verifyBackup(runtimeConfig, { key, size: 2, checksum });
        checks.push({ name: 'backup', status: 'PASS', message: '备份已上传并通过云端元数据确认。' });
        checks.push({ name: 'download', status: 'SKIP', message: '仅上传备份，不执行内容下载。' });
      } else {
      let content: Buffer;
      const target = await adapter.getDownloadTarget?.(runtimeConfig, key);
      if (target?.type === 'stream' && target.stream) {
        const chunks: Buffer[] = []; let size = 0;
        try { for await (const chunk of target.stream) { const bytes = Buffer.from(chunk as Uint8Array); size += bytes.length; if (size > 1024) throw new Error('探测对象内容超过预期。'); chunks.push(bytes); } }
        finally { target.stream.destroy(); }
        content = Buffer.concat(chunks);
      } else {
        const url = await adapter.getDownloadUrl(runtimeConfig, key, 60);
        const timeoutMs = this.configService.get<number>('REMOTE_STORAGE_FETCH_TIMEOUT_MS', 30_000);
        const response = await safeFetch(url, { signal: AbortSignal.timeout(Math.max(1_000, Number(timeoutMs) || 30_000)) });
        if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`读取失败：${response.status}`); }
        const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
        try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 1024) throw new Error('探测对象内容超过预期。'); chunks.push(value); } }
        finally { await reader.cancel(); }
        content = Buffer.concat(chunks);
      }
      if (!content.equals(Buffer.from('ok'))) throw new Error('探测对象内容校验失败。');
      checks.push({
        name: 'download',
        status: 'PASS',
        message: '探测对象读取与内容校验成功。',
      });
      }
    } catch (error) {
      // Network-level failures (DNS / TLS / SSRF guard) are local environment issues,
      // not a credential problem — upload already succeeded, so warn instead of failing.
      if (manifest.capabilities.backupOnly) checks.push({ name: 'backup', status: 'FAIL', message: this.errorMessage(error) });
      else checks.push({
        name: 'download', status: 'FAIL',
        message: `当前网络无法读取探测对象（域名解析/证书/代理）：${this.errorMessage(error)}`,
      });
    }

    try {
      await adapter.remove(runtimeConfig, key);
      checks.push({ name: 'delete', status: 'PASS', message: '探测对象已删除。' });
    } catch (error) {
      checks.push({ name: 'delete', status: 'FAIL', message: this.errorMessage(error) });
    }

    return checks;
  }
  private remoteAdapter(provider: string): StorageAdapter {
    try { return this.registry.adapter(provider); }
    catch { throw new BadRequestException(`存储插件 ${provider} 未安装或不可用。`); }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error && error.message ? error.message : String(error);
  }

  private workspaceRoot(): string {
    const cwd = process.cwd();

    if (basename(cwd) === 'api' && basename(dirname(cwd)) === 'apps') {
      return resolve(cwd, '../..');
    }

    return cwd;
  }
}
