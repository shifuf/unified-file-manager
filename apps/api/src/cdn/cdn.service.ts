import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';

import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditAction, CdnProvider, UserRole, type CdnConfig, type Prisma } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../common/types/request-user.type';
import { decryptText, encryptText } from '../common/utils/crypto.util';
import { getAppCryptoKey } from '../common/utils/security-config.util';
import { assertSafeOutboundUrl, normalizeOutboundUrl, safeFetch } from '../common/utils/ssrf-guard.util';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectAccessService } from '../projects/project-access.service';
import { AliyunOssAdapter } from '../storage/adapters/aliyun-oss.adapter';
import { QiniuAdapter } from '../storage/adapters/qiniu.adapter';
import { S3Adapter } from '../storage/adapters/s3.adapter';
import { UpyunAdapter } from '../storage/adapters/upyun.adapter';
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
  status: 'PASS' | 'WARN' | 'FAIL';
  message: string;
};

type StorageUsageResponse = {
  provider: CdnProvider;
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
};

@Injectable()
export class CdnService {
  private readonly usageCache = new Map<string, { expiresAt: number; value: StorageUsageResponse }>();

  constructor(
    private readonly auditService: AuditService,
    private readonly aliyunOssAdapter: AliyunOssAdapter,
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly projectAccessService: ProjectAccessService,
    private readonly qiniuAdapter: QiniuAdapter,
    private readonly s3Adapter: S3Adapter,
    private readonly upyunAdapter: UpyunAdapter,
  ) {}

  async list(user: RequestUser): Promise<Record<string, unknown>[]> {
    await this.assertCanManageStorage(user, true);
    const configs = await this.prisma.cdnConfig.findMany({
      where: { enabled: true, projectId: null },
      orderBy: [{ provider: 'asc' }, { createdAt: 'desc' }],
    });

    return this.dedupeConfigs(configs).map((config) => this.toResponse(config));
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
          OR: [{ projectId: null }, { projectId }],
        },
        orderBy: [{ provider: 'asc' }, { createdAt: 'desc' }],
      }),
    ]);

    const activeConfigId = project?.activeCdnConfigId ?? null;
    return this.dedupeConfigs(configs, activeConfigId).map((config) => this.toResponse(config, activeConfigId));
  }

  async create(dto: CreateCdnConfigDto, user: RequestUser): Promise<Record<string, unknown>> {
    await this.assertCanManageStorage(user, true);
    await this.assertRemoteConfigHostsSafe(dto.provider, dto.config);
    await this.assertConfigHealthy(dto.provider, dto.name, dto.config, user);
    const config = await this.prisma.cdnConfig.create({
      data: {
        provider: dto.provider,
        name: dto.name,
        config: this.secureConfig(dto.config),
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
    await this.assertRemoteConfigHostsSafe(dto.provider, dto.config);
    await this.assertConfigHealthy(dto.provider, dto.name, dto.config, user, projectId);
    const config = await this.prisma.cdnConfig.create({
      data: {
        projectId,
        provider: dto.provider,
        name: dto.name,
        config: this.secureConfig(dto.config),
        active: false,
        ...this.storagePolicyData(dto),
      },
    });

    await this.auditService.write({
      action: AuditAction.CDN_CREATE,
      actorId: user.id,
      projectId,
      detail: { provider: dto.provider, name: dto.name, storageConfigId: config.id, scope: 'project' },
    });

    return this.toResponse(config);
  }

  async update(configId: string, dto: UpdateCdnConfigDto, user: RequestUser): Promise<Record<string, unknown>> {
    await this.assertCanManageStorage(user, true);
    const existing = await this.findConfig(configId);
    const mergedConfig = dto.config
      ? this.mergeConfigPreservingSecrets(this.revealConfig(existing.config), dto.config)
      : undefined;

    if (mergedConfig) {
      const provider = dto.provider ?? existing.provider;
      await this.assertRemoteConfigHostsSafe(provider, mergedConfig);
      await this.assertConfigHealthy(provider, dto.name ?? existing.name, mergedConfig, user);
    }

    const config = await this.prisma.cdnConfig.update({
      where: { id: configId },
      data: {
        provider: dto.provider,
        name: dto.name,
        config: mergedConfig ? this.secureConfig(mergedConfig) : undefined,
        ...this.storagePolicyData(dto),
      },
    });

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
    const existing = await this.findProjectOwnedConfig(configId, projectId);
    const mergedConfig = dto.config
      ? this.mergeConfigPreservingSecrets(this.revealConfig(existing.config), dto.config)
      : undefined;

    if (mergedConfig) {
      const provider = dto.provider ?? existing.provider;
      await this.assertRemoteConfigHostsSafe(provider, mergedConfig);
      await this.assertConfigHealthy(provider, dto.name ?? existing.name, mergedConfig, user, projectId);
    }

    const config = await this.prisma.cdnConfig.update({
      where: { id: configId },
      data: {
        provider: dto.provider,
        name: dto.name,
        config: mergedConfig ? this.secureConfig(mergedConfig) : undefined,
        ...this.storagePolicyData(dto),
      },
    });

    await this.auditService.write({
      action: AuditAction.CDN_UPDATE,
      actorId: user.id,
      projectId,
      detail: { configId, provider: dto.provider, name: dto.name, scope: 'project' },
    });

    return this.toResponse(config);
  }

  async selectForProject(
    projectId: string,
    configId: string,
    user: RequestUser,
  ): Promise<Record<string, unknown>> {
    await this.projectAccessService.assertProjectAccess(user, projectId, true);
    const config = await this.findConfigForProject(configId, projectId);

    const project = await this.prisma.project.update({
      where: { id: projectId },
      data: { activeCdnConfigId: config.id },
      include: { activeCdnConfig: true },
    });

    await this.auditService.write({
      action: AuditAction.CDN_ACTIVATE,
      actorId: user.id,
      projectId,
      detail: { configId, provider: config.provider, name: config.name },
    });

    return this.toResponse(config, project.activeCdnConfigId);
  }

  async remove(configId: string, user: RequestUser, force = false): Promise<{ success: boolean }> {
    await this.assertCanManageStorage(user, true);
    const config = await this.findConfig(configId);
    const activeProjectCount = await this.prisma.project.count({
      where: { activeCdnConfigId: configId, deletedAt: null },
    });

    if (activeProjectCount > 0 && !force) {
      throw new BadRequestException(
        `该存储配置仍被 ${activeProjectCount} 个项目使用，请先切换项目存储，或选择“强制删除”自动解绑。`,
      );
    }

    await this.assertNotLastLocalConfig(config);

    if (activeProjectCount > 0) {
      // Detach first: projects fall back to the shared LOCAL config.
      await this.prisma.project.updateMany({
        where: { activeCdnConfigId: configId },
        data: { activeCdnConfigId: null },
      });
    }

    await this.prisma.cdnConfig.update({
      where: { id: configId },
      data: { enabled: false, active: false },
    });

    await this.auditService.write({
      action: AuditAction.CDN_DELETE,
      actorId: user.id,
      detail: { configId, detachedProjects: activeProjectCount, forced: force },
    });

    return { success: true };
  }

  async removeForProject(
    projectId: string,
    configId: string,
    user: RequestUser,
    force = false,
  ): Promise<{ success: boolean }> {
    await this.projectAccessService.assertProjectAccess(user, projectId, true);
    await this.findProjectOwnedConfig(configId, projectId);
    const activeProjectCount = await this.prisma.project.count({
      where: { id: projectId, activeCdnConfigId: configId, deletedAt: null },
    });

    if (activeProjectCount > 0 && !force) {
      throw new BadRequestException('该存储配置正在被当前项目使用，请先切换项目存储，或选择“强制删除”自动解绑。');
    }

    if (activeProjectCount > 0) {
      await this.prisma.project.updateMany({
        where: { id: projectId, activeCdnConfigId: configId },
        data: { activeCdnConfigId: null },
      });
    }

    await this.prisma.cdnConfig.update({
      where: { id: configId },
      data: { enabled: false, active: false },
    });

    await this.auditService.write({
      action: AuditAction.CDN_DELETE,
      actorId: user.id,
      projectId,
      detail: { configId, scope: 'project', forced: force },
    });

    return { success: true };
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
      ? await this.findProjectOwnedConfig(configId, projectId)
      : await this.findConfig(configId);
    const provider = dto.provider ?? existing.provider;
    const name = dto.name ?? existing.name;
    const merged = this.mergeConfigPreservingSecrets(
      this.revealConfig(existing.config),
      dto.config ?? {},
    );

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
  private async assertNotLastLocalConfig(config: CdnConfig): Promise<void> {
    if (config.provider !== CdnProvider.LOCAL) {
      return;
    }

    const remaining = await this.prisma.cdnConfig.count({
      where: { enabled: true, provider: CdnProvider.LOCAL, id: { not: config.id } },
    });

    if (remaining === 0) {
      throw new BadRequestException('这是最后一个可用的本地存储配置，删除后项目将无法上传，已阻止操作。');
    }
  }

  private async assertConfigHealthy(
    provider: CdnProvider,
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

  private async findProjectOwnedConfig(configId: string, projectId: string): Promise<CdnConfig> {
    const config = await this.prisma.cdnConfig.findFirst({
      where: {
        id: configId,
        projectId,
        enabled: true,
      },
    });

    if (!config) {
      throw new NotFoundException('项目存储配置不存在。');
    }

    return config;
  }

  private async findConfigForProject(configId: string, projectId: string): Promise<CdnConfig> {
    const config = await this.prisma.cdnConfig.findFirst({
      where: {
        id: configId,
        enabled: true,
        OR: [{ projectId: null }, { projectId }],
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

  private storagePolicyData(dto: CreateCdnConfigDto | UpdateCdnConfigDto): Pick<Prisma.CdnConfigUncheckedCreateInput, 'priority' | 'storageQuotaBytes' | 'manualStorageUsedBytes' | 'trafficQuotaBytes' | 'manualTrafficUsedBytes' | 'failoverThresholdPercent' | 'autoFailover' | 'manualUsageUpdatedAt'> {
    const data: Pick<Prisma.CdnConfigUncheckedCreateInput, 'priority' | 'storageQuotaBytes' | 'manualStorageUsedBytes' | 'trafficQuotaBytes' | 'manualTrafficUsedBytes' | 'failoverThresholdPercent' | 'autoFailover' | 'manualUsageUpdatedAt'> = {};
    if (dto.priority !== undefined) data.priority = dto.priority;
    if (dto.storageQuotaBytes !== undefined) data.storageQuotaBytes = dto.storageQuotaBytes === null ? null : BigInt(dto.storageQuotaBytes);
    if (dto.manualStorageUsedBytes !== undefined) data.manualStorageUsedBytes = dto.manualStorageUsedBytes === null ? null : BigInt(dto.manualStorageUsedBytes);
    if (dto.trafficQuotaBytes !== undefined) data.trafficQuotaBytes = dto.trafficQuotaBytes === null ? null : BigInt(dto.trafficQuotaBytes);
    if (dto.manualTrafficUsedBytes !== undefined) data.manualTrafficUsedBytes = dto.manualTrafficUsedBytes === null ? null : BigInt(dto.manualTrafficUsedBytes);
    if (dto.failoverThresholdPercent !== undefined) data.failoverThresholdPercent = dto.failoverThresholdPercent;
    if (dto.autoFailover !== undefined) data.autoFailover = dto.autoFailover;
    if (dto.manualStorageUsedBytes !== undefined || dto.manualTrafficUsedBytes !== undefined) data.manualUsageUpdatedAt = new Date();
    return data;
  }

  private secureConfig(config: Record<string, unknown>): Prisma.InputJsonObject {
    const cryptoKey = getAppCryptoKey(this.configService);
    return Object.fromEntries(
      Object.entries(config).map(([key, value]) => {
        if (typeof value === 'string' && isSensitiveConfigKey(key) && !value.startsWith(VAULT_PREFIX)) {
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
    provider: CdnProvider | undefined,
    config: Record<string, unknown>,
  ): Promise<void> {
    if (!provider || provider === CdnProvider.LOCAL) {
      return;
    }

    for (const field of ['endpoint', 'domain']) {
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
      provider: CdnProvider;
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
      createdAt: Date;
      updatedAt: Date;
    },
    activeConfigId?: string | null,
  ): Record<string, unknown> {
    return {
      id: config.id,
      projectId: config.projectId,
      provider: config.provider,
      name: config.name,
      config: this.maskConfig(config.config),
      active: activeConfigId ? config.id === activeConfigId : false,
      enabled: config.enabled,
      priority: config.priority,
      storageQuotaBytes: config.storageQuotaBytes?.toString() ?? null,
      manualStorageUsedBytes: config.manualStorageUsedBytes?.toString() ?? null,
      trafficQuotaBytes: config.trafficQuotaBytes?.toString() ?? null,
      manualTrafficUsedBytes: config.manualTrafficUsedBytes?.toString() ?? null,
      failoverThresholdPercent: config.failoverThresholdPercent,
      autoFailover: config.autoFailover,
      manualUsageUpdatedAt: config.manualUsageUpdatedAt,
      createdAt: config.createdAt,
      updatedAt: config.updatedAt,
    };
  }

  private maskConfig(config: Prisma.JsonValue): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(this.asRecord(config)).map(([key, value]) => [
        key,
        isSensitiveConfigKey(key) && value ? MASK_PLACEHOLDER : value,
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
      return cached.value;
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

  private usageAdapter(provider: CdnProvider): StorageAdapter | null {
    if (provider === CdnProvider.QINIU) {
      return this.qiniuAdapter;
    }
    if (provider === CdnProvider.UPYUN) {
      return this.upyunAdapter;
    }
    return null;
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

  private async testRemoteConfig(provider: CdnProvider, name: string, config: Record<string, unknown>): Promise<HealthCheck[]> {
    const requiredFields: Record<CdnProvider, string[]> = {
      [CdnProvider.LOCAL]: ['root'],
      [CdnProvider.QINIU]: ['accessKey', 'secretKey', 'bucket', 'domain'],
      [CdnProvider.UPYUN]: ['operator', 'password', 'bucket', 'domain'],
      [CdnProvider.ALIYUN]: ['accessKey', 'secretKey', 'bucket', 'endpoint', 'domain'],
      [CdnProvider.S3]: ['endpoint', 'region', 'bucket', 'accessKeyId', 'secretAccessKey'],
    };

    const checks: HealthCheck[] = requiredFields[provider].map((field) => {
      const value = config[field];
      return {
        name: field,
        status: typeof value === 'string' && value.trim() ? 'PASS' : 'FAIL',
        message: typeof value === 'string' && value.trim() ? '已配置' : '缺少配置',
      };
    });

    if (checks.some((check) => check.status === 'FAIL')) {
      return checks;
    }

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
      const url = await adapter.getDownloadUrl(runtimeConfig, key, 60);
      const timeoutMs = this.configService.get<number>('REMOTE_STORAGE_FETCH_TIMEOUT_MS', 30_000);
      const response = await safeFetch(url, {
        signal: AbortSignal.timeout(Math.max(1_000, Number(timeoutMs) || 30_000)),
      });
      checks.push({
        name: 'download',
        status: response.ok ? 'PASS' : 'FAIL',
        message: response.ok ? '探测对象可读取。' : `读取失败：${response.status} ${response.statusText}`,
      });
    } catch (error) {
      // Network-level failures (DNS / TLS / SSRF guard) are local environment issues,
      // not a credential problem — upload already succeeded, so warn instead of failing.
      checks.push({
        name: 'download',
        status: 'WARN',
        message: `当前网络无法读取探测对象（域名解析/证书/代理）：${this.errorMessage(error)}`,
      });
    }

    try {
      await adapter.remove(runtimeConfig, key);
      checks.push({ name: 'delete', status: 'PASS', message: '探测对象已删除。' });
    } catch (error) {
      checks.push({ name: 'delete', status: 'WARN', message: this.errorMessage(error) });
    }

    return checks;
  }
  private remoteAdapter(provider: CdnProvider): StorageAdapter {
    if (provider === CdnProvider.QINIU) {
      return this.qiniuAdapter;
    }

    if (provider === CdnProvider.UPYUN) {
      return this.upyunAdapter;
    }

    if (provider === CdnProvider.ALIYUN) {
      return this.aliyunOssAdapter;
    }

    if (provider === CdnProvider.S3) {
      return this.s3Adapter;
    }

    throw new BadRequestException('不支持的远程存储平台。');
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
