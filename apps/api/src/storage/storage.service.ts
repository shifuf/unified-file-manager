import { Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CdnProvider, type CdnConfig } from '@prisma/client';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';

import { PrismaService } from '../prisma/prisma.service';
import { decryptText, getSigningSecret, hmacSha256Base64Url } from './crypto.util';
import { StorageAdapterRegistry } from './storage-registry.service';
import { ReplicaService, spoolVerifiedStream, verifiedTarget } from './replica.service';
import { isAnyStorageUsageAtThreshold, resolveUsageValue, selectFailoverStorage } from './storage-policy.util';
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
  private readonly thresholdCache = new Map<string, { revision: string; value: boolean | null; expiresAt: number }>();

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly registry: StorageAdapterRegistry,
    @Optional() private readonly replicas?: ReplicaService,
  ) {}

  async upload(projectId: string, params: StorageUploadParams): Promise<StorageUploadResult> {
    const replicas = this.replicas ?? new ReplicaService(this.configService, this.prisma, this.registry);
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

  async materializeUploadedObject(projectId: string, configId: string, key: string, size: bigint | number | undefined,
    checksum: string | null | undefined, mimeType: string, originalName: string): Promise<StorageUploadResult> {
    const replicas = this.replicas ?? new ReplicaService(this.configService, this.prisma, this.registry);
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
    expiresSeconds = DEFAULT_URL_TTL_SECONDS,
    range?: { start?: number; end?: number },
    _options: StorageTargetOptions = {},
  ): Promise<StorageDownloadTarget> {
    if (this.replicas) return this.replicas.getDownloadTargetForKey(file, key, range);
    const config = this.runtimeConfigForFile(file);
    const adapter = this.registry.adapter(config.provider);
    const storageKey = normalizeStorageKey(key);

    if (config.provider === CdnProvider.LOCAL) {
      const target = await adapter.getDownloadTarget?.(config, storageKey);
      if (!target?.stream) throw new NotFoundException('存储对象不可读取。');
      const current = storageKey === normalizeStorageKey(file.storageKey);
      return verifiedTarget(await spoolVerifiedStream(target.stream, current ? file.size : undefined, current ? file.checksum : undefined), range, file.mimeType);
    }

    const url = await adapter.getDownloadUrl(config, storageKey, expiresSeconds);

    const target = await this.streamRemote(url);
    const current = storageKey === normalizeStorageKey(file.storageKey);
    return verifiedTarget(await spoolVerifiedStream(target.stream!, current ? file.size : undefined, current ? file.checksum : undefined), range, file.mimeType);
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
    const result = await this.registry
      .adapter(config.provider)
      .upload(config, { ...params, key: storageKey });

    return {
      cdnConfigId: config.id,
      storageKey: result.storageKey,
      publicUrl: result.publicUrl ?? null,
    };
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
    const revision = JSON.stringify([
      config.updatedAt?.getTime(), config.storageQuotaBytes?.toString(), config.manualStorageUsedBytes?.toString(),
      config.trafficQuotaBytes?.toString(), config.manualTrafficUsedBytes?.toString(), config.failoverThresholdPercent,
    ]);
    const cached = this.thresholdCache.get(config.id);
    if (cached?.revision === revision && cached.expiresAt > Date.now()) return cached.value;
    const runtime = this.runtimeConfig(config);
    let snapshot: { storageUsedBytes?: number | null; storageQuotaBytes?: number | null; trafficUsedBytes?: number | null; trafficQuotaBytes?: number | null } = {};
    try {
      const adapter = this.registry.adapter(config.provider);
      if (adapter.getUsage) snapshot = await adapter.getUsage(runtime);
    } catch {
      this.logger.warn(`获取存储用量失败 config=${config.id}。`);
    }
    const storageUsed = resolveUsageValue(snapshot.storageUsedBytes, config.manualStorageUsedBytes);
    const storageQuota = resolveUsageValue(snapshot.storageQuotaBytes, config.storageQuotaBytes);
    const trafficUsed = resolveUsageValue(snapshot.trafficUsedBytes, config.manualTrafficUsedBytes);
    const trafficQuota = resolveUsageValue(snapshot.trafficQuotaBytes, config.trafficQuotaBytes);
    const value = isAnyStorageUsageAtThreshold({
      thresholdPercent: config.failoverThresholdPercent,
      storageUsedBytes: storageUsed.value,
      storageQuotaBytes: storageQuota.value,
      trafficUsedBytes: trafficUsed.value,
      trafficQuotaBytes: trafficQuota.value,
    });
    this.thresholdCache.set(config.id, { revision, value, expiresAt: Date.now() + 30_000 });
    return value;
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
    const stored = await this.registry.adapter(config.provider).upload(config, {
      key: normalizeStorageKey(file.storageKey),
      buffer,
      mimeType: file.mimeType,
      originalName: file.originalName,
    });

    return {
      cdnConfigId: config.id,
      storageKey: stored.storageKey,
      publicUrl: stored.publicUrl ?? null,
    };
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
    const expected = hmacSha256Base64Url(
      getSigningSecret(),
      `ufm-public-file\n${fileId}\n${Math.floor(expires)}`,
    );
    return expected === signature;
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

  private runtimeConfig(config: CdnConfig): RuntimeCdnConfig {
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


  /** Proxy a signed remote URL, optionally honoring a single byte range. */
  private async streamRemote(
    url: string,
    range?: { start?: number; end?: number },
  ): Promise<StorageDownloadTarget> {
    const start = range?.start;
    const end = range?.end;
    const headers =
      start === undefined
        ? undefined
        : { Range: `bytes=${start}-${end === undefined ? '' : end}` };

    let response: Response;
    try {
      response = await fetch(url, { headers, signal: AbortSignal.timeout(60_000) });
    } catch {
      this.logger.warn('远程存储读取失败。');
      throw new NotFoundException('远程存储连接失败，文件不可读取。');
    }

    if (!response.ok || !response.body) {
      this.logger.warn(`远程存储返回 ${response.status}，无法转发文件流。`);
      await response.body?.cancel();
      throw new NotFoundException('远程存储对象不可读取。');
    }

    const rawLength = response.headers.get('content-length');
    const contentLength = rawLength === null ? Number.NaN : Number(rawLength);

    return {
      type: 'stream',
      stream: Readable.fromWeb(response.body as unknown as Parameters<typeof Readable.fromWeb>[0]),
      contentType: response.headers.get('content-type') ?? undefined,
      contentLength: Number.isFinite(contentLength) ? contentLength : undefined,
    };
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

