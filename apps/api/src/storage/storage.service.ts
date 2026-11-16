import { ConflictException, Injectable, Logger, Optional, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CdnProvider, type CdnConfig } from '@prisma/client';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';

import { PrismaService } from '../prisma/prisma.service';
import { decryptText, getSigningSecret, hmacSha256Base64Url } from './crypto.util';
import { StorageAdapterRegistry } from './storage-registry.service';
import { storageIdentity } from './download-source.util';
import { ReplicaService, verifiedTarget } from './replica.service';
import { selectFailoverStorage } from './storage-policy.util';
import { StorageLimitsService } from './storage-limits.service';
import type {
  DirectUploadCredential,
  RuntimeCdnConfig,
  StorageDownloadTarget,
  StorageUploadParams,
} from './storage.types';

export type StorageFileInput = {
  id: string;
  projectId: string;
  storageKey: string;
  mimeType: string;
  originalName: string;
  size?: bigint | number;
  checksum?: string | null;
  cdnConfigId?: string | null;
  cdnConfig?: CdnConfig | null;
};

export type StorageTargetOptions = {
  preferRedirect?: boolean;
};

export type StorageUploadResult = {
  cdnConfigId: string;
  storageKey: string;
  publicUrl: string | null;
  checksum?: string;
  size?: number;
};

const VAULT_PREFIX = 'vault:';
const DEFAULT_URL_TTL_SECONDS = 3600;

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly limits: StorageLimitsService;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly registry: StorageAdapterRegistry,
    @Optional() private readonly replicas?: ReplicaService,
    @Optional() limits?: StorageLimitsService,
  ) { this.limits = limits ?? new StorageLimitsService(prisma, registry, configService); }

  async upload(projectId: string, params: StorageUploadParams): Promise<StorageUploadResult> {
    const replicas = this.replicas ?? new ReplicaService(this.configService, this.prisma, this.registry, this.limits);
    const config = await replicas.getLocalStorage(projectId);
    const storageKey = normalizeStorageKey(params.key);
    const checksum = createHash('sha256').update(params.buffer).digest('hex');
    await this.replicas?.assertImmutable(projectId, storageKey, BigInt(params.buffer.length), checksum);
    const result = await this.registry.adapter(config.provider).upload(config, { ...params, key: storageKey });
    if (result.storageKey !== storageKey) throw new Error('本地存储返回了不同的不可变 key。');
    await replicas.verifyLocalObject(config, storageKey, BigInt(params.buffer.length), checksum);
    await this.replicas?.recordLocalAndEnqueue(projectId, config.id, storageKey, BigInt(params.buffer.length), checksum);

    return {
      cdnConfigId: config.id,
      storageKey: result.storageKey,
      publicUrl: null,
      checksum,
      size: params.buffer.length,
    };
  }

  async remove(cdnConfig: CdnConfig | null, key: string): Promise<void> {
    if (!cdnConfig) {
      return;
    }

    const runtime = this.runtimeConfig(cdnConfig);
    await this.registry.adapter(runtime.provider).remove(runtime, normalizeStorageKey(key));
  }

  /** Freeze indexed copies before touching bytes. Keep the index on failure so retry
   * can finish even after some providers have already removed their objects. */
  async removeFileObjects(fileId: string): Promise<string[]> {
    const plan = await this.prisma.$transaction(async tx => {
      const initial = await tx.managedFile.findUnique({ where: { id: fileId } });
      if (!initial) return { projectId: '', keys: [] as string[], targets: [] as Array<{ config: CdnConfig; key: string }> };
      await tx.$queryRaw`SELECT id FROM Project WHERE id = ${initial.projectId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM ManagedFile WHERE id = ${fileId} FOR UPDATE`;
      const file = await tx.managedFile.findUnique({ where: { id: fileId }, include: {
        cdnConfig: true, versions: true, derivatives: true,
      } });
      if (!file || file.status !== 'RECYCLED') throw new ConflictException('文件状态已变化，请刷新回收站后重试。');
      const origins = new Map<string, CdnConfig[]>();
      const add = (key: string, config: CdnConfig | null) => {
        if (!key) return;
        const configs = origins.get(key) ?? [];
        if (config && !configs.some(c => c.id === config.id)) configs.push(config);
        origins.set(key, configs);
      };
      add(file.storageKey, file.cdnConfig);
      const versionConfigs = await tx.cdnConfig.findMany({ where: { id: { in: file.versions.flatMap(v => v.cdnConfigId ? [v.cdnConfigId] : []) } } });
      for (const version of file.versions) add(version.storageKey, versionConfigs.find(c => c.id === version.cdnConfigId) ?? null);
      for (const derivative of file.derivatives) {
        add(derivative.storageKey, file.cdnConfig);
        const meta = derivative.meta as { segmentPrefix?: string; files?: unknown[] } | null;
        if (derivative.kind === 'HLS' && typeof meta?.segmentPrefix === 'string' && Array.isArray(meta.files)) {
          for (const name of meta.files) if (typeof name === 'string') add(`${meta.segmentPrefix}/${name}`, file.cdnConfig);
        }
      }
      // Imported records and historical versions may share immutable keys. Retain
      // bytes until the last referencing record is permanently removed.
      for (const key of origins.keys()) {
        const shared = await tx.managedFile.findFirst({ where: { id: { not: fileId }, OR: [
          { storageKey: key }, { versions: { some: { storageKey: key } } }, { derivatives: { some: { storageKey: key } } },
        ] }, select: { id: true } });
        if (shared) origins.delete(key);
      }
      const keys = [...origins.keys()];
      await tx.$queryRaw`SELECT id FROM StorageReplica WHERE projectId = ${file.projectId} FOR UPDATE`;
      const rows = keys.length ? await tx.storageReplica.findMany({ where: { projectId: file.projectId, storageKey: { in: keys } }, include: { config: true } }) : [];
      if (rows.some(row => row.leaseOwner && row.leaseUntil && row.leaseUntil > new Date())) {
        throw new ConflictException('文件副本正在同步，请等待同步完成后重试彻底删除。');
      }
      const targets = new Map<string, { config: CdnConfig; key: string }>();
      for (const [key, configs] of origins) for (const config of configs) targets.set(`${config.id}\0${key}`, { config, key });
      for (const row of rows) targets.set(`${row.configId}\0${row.storageKey}`, { config: row.config, key: row.storageKey });
      // Legacy objects also need a durable deletion marker before the first
      // provider call; otherwise a failed partial delete could be restored.
      if (targets.size) await tx.storageReplica.createMany({ data: [...targets.values()].map(({ config, key }) => ({
        projectId: file.projectId, configId: config.id, storageKey: key, size: 0n, status: 'DELETING',
      })), skipDuplicates: true });
      if (keys.length) await tx.storageReplica.updateMany({ where: { projectId: file.projectId, storageKey: { in: keys } },
        data: { status: 'DELETING', leaseOwner: null, leaseUntil: null, lastError: '正在彻底删除；失败后请在回收站重试。' } });
      return { projectId: file.projectId, keys, targets: [...targets.values()] };
    });
    try {
      // Clouds first: a cloud outage should leave the local safety copy available.
      plan.targets.sort((a, b) => Number(a.config.provider === 'LOCAL') - Number(b.config.provider === 'LOCAL'));
      for (const { config, key } of plan.targets) {
        const runtime = this.runtimeConfig(config), adapter = this.registry.adapter(runtime.provider);
        try { await adapter.remove(runtime, normalizeStorageKey(key)); }
        catch (error) {
          // An already absent object is successful, but auth/network failures are
          // never treated as absence without an explicit provider probe.
          if (!adapter.objectExists || await adapter.objectExists(runtime, key) !== false) throw error;
        }
        if (adapter.objectExists && await adapter.objectExists(runtime, key)) throw new Error('Object remains after delete');
        await this.limits.releaseDeletedObject(config.id, key);
      }
    } catch {
      throw new ServiceUnavailableException('存储对象尚未全部删除，文件记录已保留，请检查存储连接、插件和删除权限后重试。');
    }
    return plan.keys;
  }

  async materializeUploadedObject(projectId: string, configId: string, key: string, size: bigint | number | undefined,
    checksum: string | null | undefined, mimeType: string, originalName: string): Promise<StorageUploadResult> {
    const replicas = this.replicas ?? new ReplicaService(this.configService, this.prisma, this.registry, this.limits);
    return replicas.materializeUploadedObject(projectId, configId, key, size, checksum, mimeType, originalName);
  }

  async getDownloadTarget(
    file: StorageFileInput,
    expiresSeconds = DEFAULT_URL_TTL_SECONDS,
    range?: { start?: number; end?: number },
    options: StorageTargetOptions = {},
  ): Promise<StorageDownloadTarget> {
    return this.getDownloadTargetForKey(file, file.storageKey, expiresSeconds, range, options);
  }

  async getDownloadTargetForKey(
    file: StorageFileInput,
    key: string,
    _expiresSeconds = DEFAULT_URL_TTL_SECONDS,
    range?: { start?: number; end?: number },
    _options: StorageTargetOptions = {},
  ): Promise<StorageDownloadTarget> {
    if (this.replicas) return this.replicas.getDownloadTargetForKey(file, key, range);
    const config = this.runtimeConfigForFile(file);
    const storageKey = normalizeStorageKey(key);
    const selected = storageIdentity(config);
    const storageSource = { strategy: 'CLOUD_PRIORITY' as const, selected,
      attempts: [{ ...selected, outcome: 'SELECTED' as const }] };

    const current = storageKey === normalizeStorageKey(file.storageKey);
    const reader = new ReplicaService(this.configService, this.prisma, this.registry, this.limits);
    const object = await reader.readVerified(config, storageKey, current ? file.size : undefined, current ? file.checksum : undefined);
    return { ...verifiedTarget(object, range, file.mimeType), storageSource };
  }

  /** Copy an object into a selected config without removing the source object. */
  async copyToConfig(file: StorageFileInput, targetConfigId: string): Promise<StorageUploadResult> {
    if (this.replicas) return this.replicas.copyToConfig(file, targetConfigId);
    if (!file.cdnConfig || file.cdnConfigId === targetConfigId) {
      throw new Error('源文件或目标存储配置无效。');
    }

    const source = await this.getDownloadTarget(file, 300, undefined, { preferRedirect: false });
    if (!source.stream) {
      throw new Error('源文件内容不可读取，无法复制。');
    }

    const buffer = await readStreamToBuffer(source.stream);
    if (file.size !== undefined && BigInt(buffer.byteLength) !== BigInt(file.size)) {
      throw new Error('源文件读取大小与文件记录不一致，已取消复制。');
    }

    const uploaded = await this.uploadToConfig(targetConfigId, {
      key: file.storageKey,
      buffer,
      mimeType: file.mimeType,
      originalName: file.originalName,
    });
    if (!(await this.objectExists(file.projectId, uploaded.storageKey, targetConfigId))) {
      throw new Error('目标存储未能确认复制后的文件，未更新文件归属。');
    }

    return uploaded;
  }

  /** Upload into a specific config (used by restores, which must target the original storage). */
  async uploadToConfig(configId: string, params: StorageUploadParams): Promise<StorageUploadResult> {
    const config = await this.findConfigById(configId);
    const storageKey = normalizeStorageKey(params.key);
    const reservation = await this.limits.reserveUpload(config, params.buffer.length, storageKey);
    try {
      const result = await this.registry
        .adapter(config.provider)
        .upload(config, { ...params, key: storageKey });

      if (config.provider !== CdnProvider.LOCAL) {
        const reader = this.replicas ?? new ReplicaService(this.configService, this.prisma, this.registry, this.limits);
        const checksum = createHash('sha256').update(params.buffer).digest('hex');
        await reader.verifyLocalObject(config, storageKey, BigInt(params.buffer.length), checksum, reservation.verification);
      }
      await this.limits.finishUpload(reservation, 'PRESENT');

      return {
        cdnConfigId: config.id,
        storageKey: result.storageKey,
        publicUrl: result.publicUrl ?? null,
      };
    } catch (error) {
      await this.limits.reconcileFailedUpload(reservation, config, storageKey);
      throw error;
    } finally { await this.limits.settleRead(reservation.verification, 0n); }
  }

  async getActiveStorage(projectId: string): Promise<RuntimeCdnConfig> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, deletedAt: null },
      include: { activeCdnConfig: true },
    });
    if (!project) throw new Error('项目不存在或已删除。');

    let current = project.activeCdnConfig;
    if (!current) {
      current = await this.prisma.cdnConfig.findFirst({
        where: { enabled: true, projectId: null, projectBindings: { some: { projectId } } },
        orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
      });
    }
    if (!current || !current.enabled) throw new Error('项目未配置可用的存储。');

    if (current.autoFailover && await this.configAtFailoverThreshold(current)) {
      const candidates = await this.prisma.cdnConfig.findMany({
        where: { enabled: true, id: { not: current.id }, projectId: null, projectBindings: { some: { projectId } } },
        orderBy: [{ priority: 'asc' }, { id: 'asc' }],
      });
      const candidateStates = await Promise.all(candidates.map(async (candidate) => ({
        ...candidate,
        atThreshold: await this.configAtFailoverThreshold(candidate),
      })));
      const target = selectFailoverStorage(candidateStates, current.id);
      if (!target) {
        const message = `存储“${current.name}”已达到切换阈值，且没有剩余可用目标；请在后台启用并配置下一个存储后重试上传。`;
        this.logger.error(`项目 ${projectId}: ${message}`);
        throw new Error(message);
      }

      const switched = await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM Project WHERE id = ${projectId} FOR UPDATE`;
        const binding = await tx.projectStorageBinding.findUnique({ where: { projectId_configId: { projectId, configId: target.id } } });
        if (!binding) return false;
        const changed = await tx.project.updateMany({
          where: { id: projectId, activeCdnConfigId: project.activeCdnConfigId },
          data: { activeCdnConfigId: target.id },
        });
        if (changed.count !== 1) return false;
        return true;
      });

      if (switched) return this.runtimeConfig(target);
      const latest = await this.prisma.project.findUnique({ where: { id: projectId }, include: { activeCdnConfig: true } });
      if (latest?.activeCdnConfig?.enabled && latest.activeCdnConfigId !== current.id) return this.runtimeConfig(latest.activeCdnConfig);
      throw new Error('存储目标刚刚被其他请求切换，请重试上传。');
    }
    return this.runtimeConfig(current);
  }

  private async configAtFailoverThreshold(config: CdnConfig): Promise<boolean | null> {
    return this.limits.uploadBlocked(config);
  }

  async objectExists(projectId: string, key: string, cdnConfigId?: string | null): Promise<boolean> {
    const config = cdnConfigId
      ? await this.findConfigById(cdnConfigId)
      : await this.getActiveStorage(projectId);
    const adapter = this.registry.adapter(config.provider);

    if (!adapter.objectExists) {
      return true;
    }

    return adapter.objectExists(config, normalizeStorageKey(key));
  }

  /**
   * Copy a LOCAL-backed object into the project's current active storage.
   *
   * The local copy is intentionally left on disk: the caller updates the DB row
   * afterwards, and deleting first would turn a failed update into data loss.
   */
  async migrateLocalFileToActiveStorage(file: StorageFileInput): Promise<StorageUploadResult> {
    const config = await this.getActiveStorage(file.projectId);

    if (config.provider === CdnProvider.LOCAL) {
      return { cdnConfigId: config.id, storageKey: file.storageKey, publicUrl: null };
    }

    const source = await this.getDownloadTargetForKey(file, file.storageKey, 300, undefined, {
      preferRedirect: false,
    });
    if (!source.stream) {
      throw new Error('本地文件内容不可读取，无法迁移。');
    }

    const buffer = await readStreamToBuffer(source.stream);
    return this.uploadToConfig(config.id, {
      key: normalizeStorageKey(file.storageKey),
      buffer,
      mimeType: file.mimeType,
      originalName: file.originalName,
    });

  }

  buildPublicAccessUrl(fileId: string): string {
    return `/api/public/files/${encodeURIComponent(fileId)}`;
  }

  buildPublicDerivativeUrl(fileId: string, kind: string, subPath?: string): string {
    return this.buildPublicDerivativePath(fileId, kind, subPath);
  }

  buildPublicDerivativePath(fileId: string, kind: string, subPath?: string): string {
    const base = `/api/public/files/${encodeURIComponent(fileId)}/derivatives/${encodeURIComponent(kind)}`;
    return subPath ? `${base}/${subPath.split('/').map(encodeURIComponent).join('/')}` : base;
  }

  absolutizeIfNeeded(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) {
      return trimmed;
    }
    if (/^https?:\/\//i.test(trimmed)) {
      return trimmed;
    }
    const base = (this.configService.get<string>('PUBLIC_URL') ?? '').trim().replace(/\/+$/, '');
    const path = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
    return base ? `${base}${path}` : path;
  }

  signShareAccess(token: string, expires: number): string {
    return hmacSha256Base64Url(getSigningSecret(), `ufm-share-download\n${token}\n${Math.floor(expires)}`);
  }

  verifyShareAccess(token: string, expires: number, signature: string): boolean {
    const expected = this.signShareAccess(token, expires);
    return expected === signature;
  }

  verifyPublicAccess(fileId: string, expires: number, signature: string): boolean {
    if (!Number.isSafeInteger(expires) || expires <= Math.floor(Date.now() / 1000)) return false;
    const expected = hmacSha256Base64Url(
      getSigningSecret(),
      `ufm-public-file\n${fileId}\n${Math.floor(expires)}`,
    );
    return expected === signature;
  }

  createPublicAccessUrl(fileId: string, expiresIn = 300): { url: string; expiresAt: string } {
    if (!Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > 300) throw new Error('访问链接有效期必须为 1 至 300 秒。');
    const expires = Math.floor(Date.now() / 1000) + expiresIn;
    const signature = hmacSha256Base64Url(getSigningSecret(), `ufm-public-file\n${fileId}\n${expires}`);
    return { url: `${this.buildPublicAccessUrl(fileId)}?expires=${expires}&signature=${encodeURIComponent(signature)}`, expiresAt: new Date(expires * 1000).toISOString() };
  }

  async createDirectUploadCredential(
    _projectId: string,
    _params: { fileName: string; mimeType: string; size: number; folderPath?: string | null },
  ): Promise<DirectUploadCredential | null> {
    return null;
  }

  private runtimeConfigForFile(file: StorageFileInput): RuntimeCdnConfig {
    if (file.cdnConfig) {
      return this.runtimeConfig(file.cdnConfig);
    }
    throw new Error('文件缺少存储配置，无法下载。');
  }

  runtimeConfig(config: CdnConfig): RuntimeCdnConfig {
    return {
      id: config.id,
      provider: config.provider,
      name: config.name,
      config: this.revealConfig(config),
    };
  }

  private revealConfig(config: CdnConfig): Record<string, unknown> {
    const raw = (config.config ?? {}) as Record<string, unknown>;
    const cryptoKey = (this.configService.get<string>('APP_CRYPTO_KEY') ?? '').trim() || 'local-development-crypto-key';

    return Object.fromEntries(
      Object.entries(raw).map(([key, value]) => {
        if (typeof value === 'string' && value.startsWith(VAULT_PREFIX)) {
          return [key, decryptText(value.slice(VAULT_PREFIX.length), cryptoKey)];
        }
        return [key, value];
      }),
    );
  }

  private async findConfigById(id: string): Promise<RuntimeCdnConfig> {
    const config = await this.prisma.cdnConfig.findFirst({ where: { id } });
    if (!config) {
      throw new Error('存储配置不存在。');
    }
    return this.runtimeConfig(config);
  }


}

function normalizeStorageKey(key: string): string {
  return key.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/{2,}/g, '/');
}

async function readStreamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

