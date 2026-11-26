import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CdnProvider, type CdnConfig, type Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { PrismaService } from '../prisma/prisma.service';
import { decryptText } from './crypto.util';
import { StorageAdapterRegistry } from './storage-registry.service';
import { storageIdentity } from './download-source.util';
import { StorageLimitError, StorageLimitsService, type ReadReservation, type UploadReservation } from './storage-limits.service';
import type { StorageFileInput, StorageTargetOptions, StorageUploadResult } from './storage.service';
import type { DownloadStorageSource, RuntimeCdnConfig, StorageByteRange, StorageDownloadTarget, StorageObjectFingerprint, StorageUploadFileParams } from './storage.types';

type ReplicaRow = {
  id: string; projectId: string; configId: string; storageKey: string; size: bigint;
  checksum: string | null; status: string; attempts: number; nextAttemptAt: Date;
  leaseOwner: string | null; leaseUntil: Date | null; lastError: string | null;
  verifiedAt: Date | null; createdAt: Date; updatedAt: Date; config?: CdnConfig;
};
/** Structural bridge also permits an additive schema deployment before regeneration. */
type ReplicaDelegate = {
  count(args: Record<string, unknown>): Promise<number>;
  findMany(args: Record<string, unknown>): Promise<ReplicaRow[]>;
  findUnique(args: Record<string, unknown>): Promise<ReplicaRow | null>;
  findFirst(args: Record<string, unknown>): Promise<ReplicaRow | null>;
  upsert(args: Record<string, unknown>): Promise<ReplicaRow>;
  createMany(args: Record<string, unknown>): Promise<{ count: number }>;
  updateMany(args: Record<string, unknown>): Promise<{ count: number }>;
  groupBy(args: Record<string, unknown>): Promise<Array<{ status: string; _count: { _all: number } }>>;
};
type VerifiedReadAttempt = { outcome: 'SELECTED' | 'FAILED'; route: 'CDN' | 'ORIGIN'; reason?: string };
type VerifiedObject = { path: string; size: number; checksum: string; cleanup: () => Promise<void>; readAttempts?: VerifiedReadAttempt[] };
type ReplicaUploadMetadata = Pick<StorageUploadFileParams, 'mimeType' | 'originalName' | 'project' | 'folderPath'>;
const RETRY_STATES = ['PENDING', 'FAILED', 'MISSING'];
const LEASE_MS = 5 * 60_000;
const BUFFER_LIMIT = 32 * 1024 * 1024;

@Injectable()
export class ReplicaService {
  private readonly logger = new Logger(ReplicaService.name);
  private readonly limits: StorageLimitsService;
  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly registry: StorageAdapterRegistry,
    @Optional() limits?: StorageLimitsService,
  ) { this.limits = limits ?? new StorageLimitsService(prisma, registry, configService); }

  private table(client: unknown = this.prisma): ReplicaDelegate {
    const table = (client as { storageReplica?: ReplicaDelegate }).storageReplica;
    if (!table) throw new Error('存储副本索引未部署，请先执行新增迁移并生成 Prisma 客户端。');
    return table;
  }

  async getLocalStorage(projectId: string): Promise<RuntimeCdnConfig> {
    const project = await this.prisma.project.findFirst({ where: { id: projectId, deletedAt: null } });
    if (!project) throw new NotFoundException('项目不存在或已删除。');
    const orderBy = [{ priority: 'asc' as const }, { createdAt: 'asc' as const }];
    let local = await this.prisma.cdnConfig.findFirst({
      where: { enabled: true, provider: CdnProvider.LOCAL, projectId: null, projectBindings: { some: { projectId } } }, orderBy,
    });
    if (!local) {
      local = await this.prisma.cdnConfig.findFirst({ where: { enabled: true, provider: CdnProvider.LOCAL, projectId: null }, orderBy });
      if (local) await this.prisma.projectStorageBinding.upsert({
        where: { projectId_configId: { projectId, configId: local.id } },
        create: { projectId, configId: local.id }, update: {},
      });
    }
    if (!local) throw new Error('未配置启用的全局本地存储，无法保存安全副本。');
    return this.runtime(local);
  }

  async assertImmutable(projectId: string, storageKey: string, size: bigint, checksum: string): Promise<void> {
    const existing = await this.table().findFirst({ where: { projectId, storageKey } });
    if (existing && (existing.size !== size || (existing.checksum && existing.checksum !== checksum))) {
      throw new ConflictException('不可变存储对象内容冲突，请使用新的存储 key。');
    }
  }

  async verifyLocalObject(config: RuntimeCdnConfig, storageKey: string, size: bigint, checksum: string, reservation?: ReadReservation): Promise<void> {
    const object = await this.readVerified(config, storageKey, size, checksum, reservation);
    await object.cleanup();
  }

  async recordLocalAndEnqueue(projectId: string, localConfigId: string, storageKey: string, size: bigint, checksum: string, targetConfigId?: string): Promise<void> {
    await this.assertImmutable(projectId, storageKey, size, checksum);
    const clouds = await this.prisma.cdnConfig.findMany({
      where: { enabled: true, provider: { not: CdnProvider.LOCAL }, projectId: null, projectBindings: { some: { projectId } },
        ...(targetConfigId ? { id: targetConfigId } : {}) },
      orderBy: [{ priority: 'asc' }, { id: 'asc' }],
    });
    await this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM Project WHERE id = ${projectId} FOR UPDATE`;
      const table = this.table(tx);
      if (await table.findFirst({ where: { projectId, storageKey, status: 'DELETING' } })) return;
      await table.upsert({
        where: { projectId_storageKey_configId: { projectId, storageKey, configId: localConfigId } },
        create: { projectId, storageKey, configId: localConfigId, size, checksum, status: 'READY', verifiedAt: new Date() },
        update: { status: 'READY', verifiedAt: new Date(), checksum, lastError: null, leaseOwner: null, leaseUntil: null },
      });
      if (clouds.length) await table.createMany({
        data: clouds.map(c => ({ projectId, storageKey, configId: c.id, size, checksum, status: 'PENDING' })), skipDuplicates: true,
      });
    });
  }

  async materializeUploadedObject(projectId: string, configId: string, key: string, size: bigint | number | undefined,
    checksum: string | null | undefined, mimeType: string, originalName: string, targetConfigId?: string): Promise<StorageUploadResult> {
    const config = await this.prisma.cdnConfig.findFirst({ where: { id: configId } });
    if (!config) throw new NotFoundException('原存储配置不存在。');
    const storageKey = normalizeKey(key);
    const object = await this.readVerified(this.runtime(config), storageKey, size, checksum);
    try {
      await this.assertImmutable(projectId, storageKey, BigInt(object.size), object.checksum);
      const local = await this.getLocalStorage(projectId);
      if (local.id !== configId) {
        await this.uploadDisk(local, storageKey, object, mimeType, originalName);
        const verified = await this.readVerified(local, storageKey, BigInt(object.size), object.checksum);
        await verified.cleanup();
      }
      await this.recordLocalAndEnqueue(projectId, local.id, storageKey, BigInt(object.size), object.checksum, targetConfigId);
      return { cdnConfigId: local.id, storageKey, publicUrl: null, checksum: object.checksum, size: object.size };
    } finally { await object.cleanup(); }
  }

  async getDownloadTargetForKey(file: StorageFileInput, key: string, range?: StorageByteRange, options: StorageTargetOptions = {}, expiresSeconds = 3600): Promise<StorageDownloadTarget> {
    if (file.status === 'RECYCLED' && file.purgeAt?.getTime() === 0) throw new ConflictException('文件正在彻底删除，请在回收站重试删除。');
    const storageKey = normalizeKey(key);
    const rows = await this.table().findMany({ where: { projectId: file.projectId, storageKey }, include: { config: true } });
    if (rows.some(row => row.status === 'DELETING')) throw new ConflictException('文件正在彻底删除，请在回收站完成删除。');
    const attempts: DownloadStorageSource['attempts'] = [];
    const allowed = await this.boundCloudIds(file.projectId);
    // Order all states together: a pending cloud may already contain valid
    // bytes and must be tried before a ready local safety copy.
    const ordered = rows.filter(row => row.config).sort((a, b) =>
      Number(a.config!.provider === CdnProvider.LOCAL) - Number(b.config!.provider === CdnProvider.LOCAL)
      || a.config!.priority - b.config!.priority || a.configId.localeCompare(b.configId));
    for (const row of ordered) {
      const config = row.config!;
      let skipped: string | undefined;
      if (this.isBackupOnly(config.provider)) skipped = '该存储仅用于上传备份，不参与下载。';
      if (!skipped && config.provider !== CdnProvider.LOCAL) {
        if (!config.enabled) skipped = '存储已停用。';
        else if (!allowed.has(row.configId)) skipped = '存储未绑定当前项目。';
      }
      if (row.status === 'SKIPPED') skipped = skipped || '该副本已跳过同步。';
      if (skipped) { attempts.push({ ...storageIdentity(config), outcome: 'SKIPPED', reason: skipped }); continue; }
      try {
        const object = await this.readVerified(this.runtime(config), storageKey, row.size, row.checksum, undefined, { allowCdn: true });
        if (row.status !== 'READY') await this.recoverRead(file, this.runtime(config), storageKey, object);
        attempts.push(...(object.readAttempts ?? [{ outcome: 'SELECTED' as const }]).map(attempt => ({ ...storageIdentity(config), ...attempt })));
        return { ...await this.verifiedDownloadTarget(this.runtime(config), storageKey, object, range, file.mimeType, options, expiresSeconds), storageSource: {
          strategy: 'CLOUD_PRIORITY', selected: storageIdentity(config), attempts,
        } };
      } catch (error) {
        attempts.push({ ...storageIdentity(config), outcome: error instanceof StorageLimitError ? 'SKIPPED' : 'FAILED', reason: safeError(error) });
        // A failed status update must not prevent the next cloud/local read.
        if (row.status === 'READY') await this.markUnreadable(row, error).catch(() => undefined);
      }
    }
    // Unindexed versions/derivatives use their original location, with only the
    // current object's metadata applied to the current key.
    if (rows.length === 0 && file.cdnConfig && !this.isBackupOnly(file.cdnConfig.provider) && (file.cdnConfig.provider === CdnProvider.LOCAL ||
      (file.cdnConfig.enabled && (await this.boundCloudIds(file.projectId)).has(file.cdnConfig.id)))) {
      try {
        const current = storageKey === normalizeKey(file.storageKey);
        const object = await this.readVerified(this.runtime(file.cdnConfig), storageKey, current ? file.size : undefined, current ? file.checksum : undefined, undefined, { allowCdn: true });
        await this.recoverRead(file, this.runtime(file.cdnConfig), storageKey, object);
        const selected = storageIdentity(file.cdnConfig);
        return { ...await this.verifiedDownloadTarget(this.runtime(file.cdnConfig), storageKey, object, range, file.mimeType, options, expiresSeconds), storageSource: {
          strategy: 'CLOUD_PRIORITY', selected, attempts: [...attempts, ...(object.readAttempts ?? [{ outcome: 'SELECTED' as const }]).map(attempt => ({ ...selected, ...attempt }))],
        } };
      } catch { /* continue to an explicit unavailable-object response */ }
    }
    // Legacy imports can have cloud indexes without a LOCAL row. Verify the
    // safety copy before declaring the object unavailable, then repair its index.
    if (!rows.some(row => row.config?.provider === CdnProvider.LOCAL)) {
      try {
        const local = await this.getLocalStorage(file.projectId);
        const current = storageKey === normalizeKey(file.storageKey);
        const reference = rows.find(row => row.checksum);
        const object = await this.readVerified(local, storageKey, current ? file.size ?? reference?.size : reference?.size,
          current ? file.checksum ?? reference?.checksum : reference?.checksum);
        await this.recoverRead(file, local, storageKey, object);
        const selected = storageIdentity(local);
        return { ...await this.verifiedDownloadTarget(local, storageKey, object, range, file.mimeType, options, expiresSeconds),
          storageSource: { strategy: 'CLOUD_PRIORITY', selected, attempts: [...attempts, { ...selected, outcome: 'SELECTED' }] } };
      } catch { /* retain an explicit unavailable response if no verified copy exists */ }
    }
    throw new NotFoundException('文件存储副本均不可读取，文件可能缺失或损坏。');
  }

  /** Metadata-only forecast of the same read policy; listing shares must never
   * download every object or expose the original, possibly retired, source. */
  async describeDownloadStorages(files: StorageFileInput[]): Promise<Map<string, CdnConfig | null>> {
    const result = new Map<string, CdnConfig | null>();
    if (!files.length) return result;
    const projects = [...new Set(files.map(file => file.projectId))];
    const allowed = new Map(await Promise.all(projects.map(async id => [id, await this.boundCloudIds(id)] as const)));
    const rows = await this.table().findMany({ where: { OR: files.map(file => ({ projectId: file.projectId, storageKey: normalizeKey(file.storageKey) })) }, include: { config: true } });
    const local = await this.prisma.cdnConfig.findFirst({ where: { enabled: true, provider: CdnProvider.LOCAL, projectId: null }, orderBy: [{ priority: 'asc' }, { id: 'asc' }] });
    for (const file of files) {
      const indexed = rows.filter(row => row.projectId === file.projectId && row.storageKey === normalizeKey(file.storageKey));
      if (indexed.some(row => row.status === 'DELETING') || (file.status === 'RECYCLED' && file.purgeAt?.getTime() === 0)) {
        result.set(file.id, null); continue;
      }
      const eligible = indexed.filter(row => row.config && row.status === 'READY' && row.verifiedAt && !this.isBackupOnly(row.config.provider)
        && (row.config.provider === CdnProvider.LOCAL || (row.config.enabled && allowed.get(file.projectId)?.has(row.configId))))
        .sort((a, b) => Number(a.config!.provider === CdnProvider.LOCAL) - Number(b.config!.provider === CdnProvider.LOCAL)
          || a.config!.priority - b.config!.priority || a.configId.localeCompare(b.configId));
      const origin = file.cdnConfig;
      const legacy = !indexed.length && origin && !this.isBackupOnly(origin.provider)
        && (origin.provider === CdnProvider.LOCAL || (origin.enabled && allowed.get(file.projectId)?.has(origin.id))) ? origin : null;
      result.set(file.id, eligible[0]?.config ?? legacy ?? local ?? null);
    }
    return result;
  }

  async verifiedDownloadTarget(config: RuntimeCdnConfig, key: string, object: VerifiedObject, range: StorageByteRange | undefined,
    contentType: string, options: StorageTargetOptions = {}, expiresSeconds = 3600): Promise<StorageDownloadTarget> {
    // An origin fallback certifies only origin bytes. Never redirect it back to
    // the failed CDN, and never use the adapter's generic/private download URL.
    if (options.preferRedirect === true && !range && object.readAttempts?.some(attempt => attempt.outcome === 'SELECTED' && attempt.route === 'CDN')) {
      let url: string | null | undefined;
      try { url = await this.registry.adapter(config.provider).getCdnDownloadUrl?.(config, key, expiresSeconds, options.downloadName); }
      catch { /* URL generation is optional; keep the already verified stream. */ }
      if (url) {
        await object.cleanup();
        return { type: 'redirect', url, verified: true, checksum: object.checksum, contentLength: object.size, contentType };
      }
    }
    return verifiedTarget(object, range, contentType);
  }

  private async recoverRead(file: StorageFileInput, source: RuntimeCdnConfig, key: string, object: VerifiedObject): Promise<void> {
    try {
      if (source.provider === CdnProvider.LOCAL) {
        await this.recordLocalAndEnqueue(file.projectId, source.id, key, BigInt(object.size), object.checksum);
        return;
      }
      // The response already has verified cloud bytes. Schedule any missing
      // safety copy without reading LOCAL on the cloud download request.
      const local = await this.getLocalStorage(file.projectId);
      await this.table().upsert({
        where: { projectId_storageKey_configId: { projectId: file.projectId, storageKey: key, configId: source.id } },
        create: { projectId: file.projectId, storageKey: key, configId: source.id,
          size: BigInt(object.size), checksum: object.checksum, status: 'READY', verifiedAt: new Date() },
        update: { checksum: object.checksum, status: 'READY', verifiedAt: new Date(), lastError: null },
      });
      const clouds = await this.prisma.cdnConfig.findMany({
        where: { enabled: true, provider: { not: CdnProvider.LOCAL }, projectId: null, projectBindings: { some: { projectId: file.projectId } } },
      });
      await this.table().createMany({ data: [local.id, ...clouds.map(config => config.id)]
        .filter(id => id !== source.id).map(configId => ({ projectId: file.projectId, storageKey: key, configId,
          size: BigInt(object.size), checksum: object.checksum, status: 'PENDING' })), skipDuplicates: true });
    } catch {
      // Verified original bytes remain downloadable if a queue/checkpoint write
      // fails. A subsequent worker or read retries the local safety copy.
      this.logger.warn('旧对象补齐本地副本排队失败，将在后续同步或读取时重试。');
    }
  }

  private async boundCloudIds(projectId: string): Promise<Set<string>> {
    const configs = await this.prisma.cdnConfig.findMany({ where: { enabled: true, provider: { not: CdnProvider.LOCAL }, projectId: null, projectBindings: { some: { projectId } } }, select: { id: true } });
    return new Set(configs.map(c => c.id));
  }

  isBackupOnly(provider: string): boolean { return this.registry.manifest?.(provider)?.capabilities.backupOnly === true; }

  async confirmStoredObject(config: RuntimeCdnConfig, key: string, size: number, checksum: string, reservation?: ReadReservation): Promise<void> {
    if (this.isBackupOnly(config.provider)) {
      const adapter = this.registry.adapter(config.provider);
      if (!adapter.verifyBackup) throw new Error('备份插件缺少元数据确认能力。');
      await adapter.verifyBackup(config, { key, size, checksum });
    } else {
      const verified = await this.readVerified(config, key, size, checksum, reservation);
      await verified.cleanup();
    }
  }

  private async readableRows(rows: ReplicaRow[], localFirst = false, projectId?: string): Promise<ReplicaRow[]> {
    const allowed = projectId ? await this.boundCloudIds(projectId) : null;
    const eligible = rows.filter(r => r.config && !this.isBackupOnly(r.config.provider) && (r.config.provider === CdnProvider.LOCAL || (r.config.enabled && (!allowed || allowed.has(r.configId)))));
    return eligible.sort((a, b) => {
      const al = a.config!.provider === CdnProvider.LOCAL, bl = b.config!.provider === CdnProvider.LOCAL;
      if (al !== bl) return al === localFirst ? -1 : 1;
      return (a.config!.priority - b.config!.priority) || a.configId.localeCompare(b.configId);
    });
  }

  private async markUnreadable(row: ReplicaRow, error: unknown): Promise<void> {
    if (error instanceof StorageLimitError) return;
    await this.table().updateMany({ where: { id: row.id, status: { not: 'DELETING' } }, data: {
      status: error instanceof NotFoundException ? 'MISSING' : 'FAILED', verifiedAt: null,
      lastError: safeError(error), nextAttemptAt: new Date(Date.now() + 30_000),
    } });
  }

  async runBatch(owner: string, requestedBatchSize = 10): Promise<{ scanned: number; ready: number; failed: number }> {
    const batchSize = Math.min(50, Math.max(1, Math.floor(requestedBatchSize) || 10));
    const now = new Date();
    const claimable = { status: { in: RETRY_STATES }, nextAttemptAt: { lte: now }, OR: [
      { leaseOwner: null }, { leaseOwner: owner }, { leaseUntil: { lte: now } },
    ] };
    const rows = await this.table().findMany({ where: { ...claimable, config: { OR: [{ enabled: true }, { provider: CdnProvider.LOCAL }] } }, orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }], take: batchSize, include: { config: true } });
    const summary = { scanned: 0, ready: 0, failed: 0 };
    const allowedByProject = new Map<string, Set<string>>();
    for (const row of rows) {
      if (!row.config || (!row.config.enabled && row.config.provider !== CdnProvider.LOCAL)) continue;
      if (row.config.provider !== CdnProvider.LOCAL) {
        let allowed = allowedByProject.get(row.projectId);
        if (!allowed) { allowed = await this.boundCloudIds(row.projectId); allowedByProject.set(row.projectId, allowed); }
        if (!allowed.has(row.configId)) {
          await this.table().updateMany({ where: { id: row.id, ...claimable }, data: {
            status: 'SKIPPED', lastError: '存储已不再绑定到此项目，已停止补齐。', leaseOwner: null, leaseUntil: null,
          } });
          continue;
        }
      }
      const claimed = await this.table().updateMany({ where: { id: row.id, ...claimable }, data: {
        leaseOwner: owner, leaseUntil: new Date(Date.now() + LEASE_MS), attempts: { increment: 1 },
      } });
      if (claimed.count !== 1) continue;
      summary.scanned++;
      const heartbeat = setInterval(() => { void this.renewLease(row.id, owner); }, 30_000);
      heartbeat.unref?.();
      let source: VerifiedObject | undefined;
      let corrupt: StorageObjectFingerprint | undefined;
      let uploadReservation: UploadReservation | undefined;
      try {
        // Only a known digest can identify a previously uploaded target. Legacy
        // objects first derive their digest from the original/local source.
        if (row.checksum && !this.isBackupOnly(row.config.provider)) {
          try { source = await this.readVerified(this.runtime(row.config), row.storageKey, row.size, row.checksum); } catch { /* copy a verified source */ }
          if (!source && row.config.provider === CdnProvider.LOCAL) {
            const adapter = this.registry.adapter(CdnProvider.LOCAL);
            const fingerprint = await adapter.getObjectFingerprint?.(this.runtime(row.config), row.storageKey);
            if (fingerprint && (BigInt(fingerprint.size) !== row.size || fingerprint.checksum !== row.checksum)) corrupt = fingerprint;
          }
        }
        if (!source) {
          try { source = await this.sourceForReplica(row); }
          catch (error) {
            if (row.checksum) throw error;
            // The original may be the sole readable copy of a pre-index object.
            source = await this.readVerified(this.runtime(row.config), row.storageKey, row.size);
          }
          const adapter = this.registry.adapter(row.config.provider);
          const metadata = await this.metadataForReplica(row);
          if (corrupt && adapter.repairFile) {
            if (source.checksum !== row.checksum) throw new Error('对象 SHA256 校验失败。');
            const stored = await adapter.repairFile(this.runtime(row.config), { key: row.storageKey, path: source.path, size: source.size,
              checksum: source.checksum, ...metadata }, corrupt);
            if (normalizeKey(stored.storageKey) !== normalizeKey(row.storageKey)) throw new Error('复制目标返回了不同的不可变 key。');
          } else {
            uploadReservation = await this.uploadDisk(this.runtime(row.config), row.storageKey, source, metadata.mimeType, metadata.originalName, metadata);
          }
          await this.confirmStoredObject(this.runtime(row.config), row.storageKey, Number(row.size), source.checksum, uploadReservation?.verification);
          if (uploadReservation) await this.limits.finishUpload(uploadReservation, 'PRESENT');
        }
        const updated = await this.table().updateMany({ where: { id: row.id, leaseOwner: owner, leaseUntil: { gt: new Date() } }, data: {
          status: 'READY', checksum: source.checksum, verifiedAt: new Date(), lastError: null, leaseOwner: null, leaseUntil: null,
        } });
        if (updated.count === 1) summary.ready++;
      } catch (error) {
        if (uploadReservation) await this.limits.reconcileFailedUpload(uploadReservation, this.runtime(row.config), row.storageKey);
        const attempts = row.attempts + 1;
        const delay = Math.min(6 * 3600_000, 30_000 * 2 ** Math.min(10, attempts - 1));
        await this.table().updateMany({ where: { id: row.id, leaseOwner: owner }, data: {
          status: error instanceof NotFoundException ? 'MISSING' : 'FAILED', verifiedAt: null,
          lastError: safeError(error), nextAttemptAt: new Date(Date.now() + delay), leaseOwner: null, leaseUntil: null,
        } });
        summary.failed++;
      } finally {
        clearInterval(heartbeat);
        await source?.cleanup();
      }
    }
    return summary;
  }

  private async renewLease(id: string, owner: string): Promise<void> {
    try { await this.table().updateMany({ where: { id, leaseOwner: owner }, data: { leaseUntil: new Date(Date.now() + LEASE_MS) } }); }
    catch { this.logger.warn('副本队列续租失败，将由后续批次接管。'); }
  }

  private async metadataForReplica(target: Pick<ReplicaRow, 'projectId' | 'storageKey'>): Promise<ReplicaUploadMetadata> {
    const project = await this.prisma.project.findFirst({ where: { id: target.projectId }, select: { id: true, name: true } });
    if (!project || typeof project.name !== 'string' || !project.name.trim()) {
      throw new Error('副本所属项目资料不完整，等待修复后重试。');
    }
    const fallback = { mimeType: 'application/octet-stream', originalName: target.storageKey.split('/').pop() || 'object',
      project: { id: target.projectId, name: project.name } };
    // An immutable key may belong to the current head, an older version, or a
    // derivative. Keep every lookup scoped to the replica's project and key.
    const file = await this.prisma.managedFile.findFirst({
      where: { projectId: target.projectId, storageKey: target.storageKey },
      select: { mimeType: true, originalName: true, folderPath: true },
    });
    if (file) return { ...fallback, mimeType: file.mimeType || fallback.mimeType, originalName: file.originalName || fallback.originalName,
      ...(typeof file.folderPath === 'string' ? { folderPath: file.folderPath } : {}) };
    const version = await this.prisma.fileVersion.findFirst({
      where: { storageKey: target.storageKey, file: { projectId: target.projectId } },
      select: { mimeType: true, originalName: true, file: { select: { folderPath: true } } },
    });
    if (version) return { ...fallback, mimeType: version.mimeType || fallback.mimeType, originalName: version.originalName || fallback.originalName,
      ...(typeof version.file?.folderPath === 'string' ? { folderPath: version.file.folderPath } : {}) };
    const derivative = await this.prisma.fileDerivative.findFirst({
      where: { storageKey: target.storageKey, file: { projectId: target.projectId } },
      select: { mimeType: true, file: { select: { folderPath: true } } },
    });
    // Derivatives have no originalName; their source's MIME/name describe
    // different bytes and must not be copied onto generated objects.
    return { ...fallback, mimeType: derivative?.mimeType || fallback.mimeType,
      ...(typeof derivative?.file?.folderPath === 'string' ? { folderPath: derivative.file.folderPath } : {}) };
  }

  private async sourceForReplica(target: ReplicaRow): Promise<VerifiedObject> {
    const rows = await this.table().findMany({ where: { projectId: target.projectId, storageKey: target.storageKey, configId: { not: target.configId } }, include: { config: true } });
    // Backfill source rows start PENDING too. Actual bytes must pass verification
    // before they are used; status alone never grants trust.
    for (const row of await this.readableRows(rows, true)) {
      try { return await this.readVerified(this.runtime(row.config!), row.storageKey, target.size, target.checksum || row.checksum); }
      catch (error) { if (row.status === 'READY') await this.markUnreadable(row, error); }
    }
    // A current legacy head may predate the replica index. Use its existing
    // source as bytes only; it must verify and must never become a queue target.
    const legacy = await this.prisma.managedFile.findFirst({
      where: { projectId: target.projectId, storageKey: target.storageKey, status: 'ACTIVE', deletedAt: null },
      include: { cdnConfig: true },
    });
    if (legacy?.cdnConfig && legacy.cdnConfigId !== target.configId && !this.isBackupOnly(legacy.cdnConfig.provider)) {
      return this.readVerified(this.runtime(legacy.cdnConfig), target.storageKey, target.size, target.checksum || legacy.checksum);
    }
    // A targeted scan intentionally omits the old account from queue targets.
    // Resolve historical/generated object origins as read-only byte sources.
    const version = await this.prisma.fileVersion.findFirst({
      where: { storageKey: target.storageKey, file: { projectId: target.projectId, status: 'ACTIVE', deletedAt: null } },
      select: { cdnConfigId: true, checksum: true },
    });
    if (version?.cdnConfigId && version.cdnConfigId !== target.configId) {
      const config = await this.prisma.cdnConfig.findFirst({ where: { id: version.cdnConfigId } });
      if (config && !this.isBackupOnly(config.provider)) {
        return this.readVerified(this.runtime(config), target.storageKey, target.size, target.checksum || version.checksum);
      }
    }
    const derivative = await this.prisma.fileDerivative.findFirst({
      where: { storageKey: target.storageKey, status: 'READY', file: { projectId: target.projectId, status: 'ACTIVE', deletedAt: null } },
      select: { file: { select: { cdnConfig: true } } },
    });
    const origin = derivative?.file.cdnConfig;
    if (origin && origin.id !== target.configId && !this.isBackupOnly(origin.provider)) {
      return this.readVerified(this.runtime(origin), target.storageKey, target.size, target.checksum);
    }
    // Segment keys are members of an HLS manifest, rather than derivative rows
    // of their own. A prefix match alone cannot establish ownership.
    const parts = target.storageKey.split('/').slice(0, -1);
    const prefixes = parts.map((_, index) => parts.slice(0, index + 1).join('/'));
    if (prefixes.length) {
      let cursor = '';
      do {
        const manifests = await this.prisma.fileDerivative.findMany({ where: {
          kind: 'HLS', status: 'READY', file: { projectId: target.projectId, status: 'ACTIVE', deletedAt: null },
          OR: prefixes.map(prefix => ({ meta: { path: '$.segmentPrefix', equals: prefix } })),
          ...(cursor ? { id: { gt: cursor } } : {}),
        }, orderBy: { id: 'asc' }, take: 100, select: { id: true, meta: true, file: { select: { cdnConfig: true } } } });
        for (const manifest of manifests) {
          const meta = (manifest.meta && typeof manifest.meta === 'object' && !Array.isArray(manifest.meta) ? manifest.meta : {}) as Record<string, unknown>;
          if (typeof meta.segmentPrefix !== 'string' || !Array.isArray(meta.files) ||
            !meta.files.some(name => typeof name === 'string' && `${meta.segmentPrefix as string}/${name}` === target.storageKey)) continue;
          const config = manifest.file.cdnConfig;
          if (config && config.id !== target.configId && !this.isBackupOnly(config.provider)) {
            return this.readVerified(this.runtime(config), target.storageKey, target.size, target.checksum);
          }
        }
        cursor = manifests.length === 100 ? manifests[manifests.length - 1].id : '';
      } while (cursor);
    }
    throw new NotFoundException('没有可验证的源副本，无法补齐目标对象。');
  }

  async enqueueFileTargets(file: { projectId: string; storageKey: string; size: bigint; checksum: string | null },
    configIds: string[], client: Prisma.TransactionClient): Promise<{ queued: number }> {
    const table = this.table(client);
    const created = await table.createMany({ data: configIds.map(configId => ({ projectId: file.projectId,
      storageKey: file.storageKey, configId, size: file.size, checksum: file.checksum, status: 'PENDING' })), skipDuplicates: true });
    const now = new Date();
    const retried = await table.updateMany({ where: { projectId: file.projectId, storageKey: file.storageKey,
      configId: { in: configIds }, AND: [
        { OR: [{ status: { in: ['FAILED', 'MISSING', 'SKIPPED', 'UNVERIFIED'] } }, { status: 'READY', verifiedAt: null }] },
        { OR: [{ leaseOwner: null }, { leaseUntil: { lte: now } }] },
      ] },
      data: { status: 'PENDING', nextAttemptAt: now, lastError: null, leaseOwner: null, leaseUntil: null } });
    return { queued: created.count + retried.count };
  }

  async readVerified(config: RuntimeCdnConfig, key: string, size?: bigint | number, checksum?: string | null, reservation?: ReadReservation, options: { allowCdn?: boolean } = {}): Promise<VerifiedObject> {
    if (this.isBackupOnly(config.provider)) throw new Error('该存储仅用于上传备份，不提供下载。');
    const adapter = this.registry.adapter(config.provider);
    const attempts: VerifiedReadAttempt[] = [];
    // Only a known digest can certify CDN bytes. Keep origin reads for legacy
    // objects without a checksum and for adapters that expose no CDN candidate.
    const tryCdn = Boolean(options.allowCdn && checksum && typeof adapter.getCdnDownloadTarget === 'function');
    for (let attempt = 0; attempt < (tryCdn ? 2 : 1); attempt++) {
      const ticket = (attempt === 0 ? reservation : undefined) ?? await this.limits.reserveRead(config, size);
      let route: 'CDN' | 'ORIGIN' = tryCdn && attempt === 0 ? 'CDN' : 'ORIGIN';
      try {
        const object = await this.readVerifiedAttempt(config, key, size, checksum, ticket, async () => {
          if (route === 'CDN') {
            const candidate = await adapter.getCdnDownloadTarget!(config, key);
            if (candidate) return candidate;
            route = 'ORIGIN';
          }
          return adapter.getDownloadTarget?.(config, key);
        });
        if (tryCdn) object.readAttempts = [...attempts, { route, outcome: 'SELECTED' }];
        return object;
      } catch (error) {
        if (route !== 'CDN' || error instanceof StorageLimitError) throw error;
        attempts.push({ route, outcome: 'FAILED', reason: safeError(error) });
      } finally { await this.limits.settleRead(ticket, 0n); }
    }
    throw new Error('存储对象无法读取。');
  }

  private async readVerifiedAttempt(config: RuntimeCdnConfig, key: string, size: bigint | number | undefined,
    checksum: string | null | undefined, ticket: ReadReservation,
    getTarget: () => Promise<StorageDownloadTarget | undefined>): Promise<VerifiedObject> {
      let target: StorageDownloadTarget;
      const range = ticket.bytes !== null && ticket.bytes > 0n ? { start: 0, end: Number(ticket.bytes - 1n) } : undefined;
      // Adapter streams do not expose Content-Range totals. Read their full object
      // so an unknown-size range cannot silently certify a truncated prefix.
      const provided = await getTarget();
      if (provided) target = provided;
      else {
        const url = await this.registry.adapter(config.provider).getDownloadUrl(config, key, 600);
        let response: Response;
        try { response = await fetch(url, { signal: AbortSignal.timeout(120_000),
          headers: range ? { Range: `bytes=0-${range.end}` } : undefined }); }
        catch { throw new Error('远程存储连接失败。'); }
        if (!response.ok || !response.body) {
          await response.body?.cancel();
          if (response.status === 404) throw new NotFoundException('远程对象不存在。');
          throw new Error(`远程存储返回不可读取状态 ${response.status}。`);
        }
        const total = response.headers.get('content-range')?.match(/\/(\d+)$/)?.[1];
        if (size !== undefined && total && BigInt(total) !== BigInt(size)) {
          await response.body.cancel();
          throw new Error('对象大小与记录不一致。');
        }
        if (ticket.bytes !== null && total && BigInt(total) > ticket.bytes) {
          await response.body.cancel();
          throw new StorageLimitError('云存储流量额度不足以读取完整对象。');
        }
        const length = response.headers.get('content-length');
        target = { type: 'stream', stream: Readable.fromWeb(response.body as unknown as Parameters<typeof Readable.fromWeb>[0]),
          contentLength: length === null ? undefined : Number(length) };
      }
      if (!target.stream || target.type !== 'stream') throw new Error('存储适配器未提供可验证的文件流。');
      if (target.contentLength !== undefined && Number.isSafeInteger(target.contentLength) && target.contentLength >= 0) {
        if (size !== undefined && BigInt(target.contentLength) !== BigInt(size)) {
          target.stream.destroy(); throw new Error('对象大小与记录不一致。');
        }
        if (ticket.bytes !== null && BigInt(target.contentLength) > ticket.bytes) {
          target.stream.destroy(); throw new StorageLimitError('云存储流量额度不足以读取完整对象。');
        }
      }
      return await this.limits.consumeRead(ticket, target.stream, stream => spoolVerifiedStream(stream, size, checksum));
  }

  private async uploadDisk(config: RuntimeCdnConfig, key: string, object: VerifiedObject, mimeType: string, originalName: string,
    context: Pick<StorageUploadFileParams, 'project' | 'folderPath'> = {}): Promise<UploadReservation> {
    const adapter = this.registry.adapter(config.provider);
    if (!adapter.uploadFile && object.size > BUFFER_LIMIT) throw new Error('存储适配器未支持流式复制，超过 32MiB 的对象已保留本地等待重试。');
    const reservation = await this.limits.reserveUpload(config, object.size, key);
    try {
      const { project, folderPath } = context;
      const identity = { ...(project ? { project } : {}), ...(folderPath !== undefined ? { folderPath } : {}) };
      const params: StorageUploadFileParams = { key, path: object.path, size: object.size, checksum: object.checksum, mimeType, originalName, ...identity };
      const stored = adapter.uploadFile
        ? await adapter.uploadFile(config, params)
        : await adapter.upload(config, { key, buffer: await readFile(object.path), mimeType, originalName, ...identity });
      if (normalizeKey(stored.storageKey) !== normalizeKey(key)) throw new Error('复制目标返回了不同的不可变 key。');
      return reservation;
    } catch (error) {
      await this.limits.reconcileFailedUpload(reservation, config, key);
      throw error;
    }
  }

  async copyToConfig(file: StorageFileInput, targetConfigId: string): Promise<StorageUploadResult> {
    const target = await this.prisma.cdnConfig.findFirst({ where: { id: targetConfigId } });
    if (!target?.enabled) throw new NotFoundException('目标存储配置不存在或已停用。');
    const owner = `copy:${randomUUID()}`;
    const claimed = await this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM Project WHERE id = ${file.projectId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM ManagedFile WHERE id = ${file.id} FOR UPDATE`;
      const head = await tx.managedFile.findUnique({ where: { id: file.id } });
      if (!head || head.projectId !== file.projectId || head.storageKey !== file.storageKey || head.status !== 'ACTIVE') {
        throw new ConflictException('文件内容或状态已变化，请刷新后重试迁移。');
      }
      await tx.$queryRaw`SELECT id FROM StorageReplica WHERE projectId = ${file.projectId} AND storageKey = ${file.storageKey} FOR UPDATE`;
      const table = this.table(tx);
      if (await table.findFirst({ where: { projectId: file.projectId, storageKey: file.storageKey,
        OR: [{ status: 'DELETING' }, { leaseUntil: { gt: new Date() } }] } })) {
        throw new ConflictException('文件正在删除或同步，请稍后重试迁移。');
      }
      return table.upsert({ where: { projectId_storageKey_configId: { projectId: file.projectId, storageKey: file.storageKey, configId: target.id } },
        create: { projectId: file.projectId, storageKey: file.storageKey, configId: target.id, size: BigInt(file.size ?? 0),
          checksum: file.checksum ?? null, status: 'PENDING', leaseOwner: owner, leaseUntil: new Date(Date.now() + LEASE_MS) },
        update: { leaseOwner: owner, leaseUntil: new Date(Date.now() + LEASE_MS) },
      });
    });
    const heartbeat = setInterval(() => { void this.renewLease(claimed.id, owner); }, 30_000);
    heartbeat.unref?.();
    let object: VerifiedObject | undefined;
    let reservation: UploadReservation | undefined;
    try {
      const downloaded = await this.getDownloadTargetForKey(file, file.storageKey);
      object = await spoolVerifiedStream(downloaded.stream!, file.size, file.checksum);
      const metadata = await this.metadataForReplica(file);
      reservation = await this.uploadDisk(this.runtime(target), file.storageKey, object, file.mimeType, file.originalName, metadata);
      await this.confirmStoredObject(this.runtime(target), file.storageKey, object.size, object.checksum, reservation.verification);
      await this.limits.finishUpload(reservation, 'PRESENT');
      const published = await this.table().updateMany({ where: { id: claimed.id, leaseOwner: owner,
        leaseUntil: { gt: new Date() }, status: { not: 'DELETING' } }, data: { size: BigInt(object.size), status: 'READY',
        checksum: object.checksum, verifiedAt: new Date(), lastError: null, leaseOwner: null, leaseUntil: null } });
      if (published.count !== 1) throw new ConflictException('迁移租约已失效，未覆盖删除状态，请检查副本后重试。');
      return { cdnConfigId: target.id, storageKey: file.storageKey, publicUrl: null };
    } catch (error) {
      if (reservation) await this.limits.reconcileFailedUpload(reservation, this.runtime(target), file.storageKey);
      await this.table().updateMany({ where: { id: claimed.id, leaseOwner: owner, status: { not: 'DELETING' } },
        data: { status: 'FAILED', verifiedAt: null, lastError: safeError(error), nextAttemptAt: new Date(Date.now() + 30_000), leaseOwner: null, leaseUntil: null } });
      throw error;
    } finally { clearInterval(heartbeat); await object?.cleanup(); }
  }

  async listProject(projectId: string, cursor?: string, requestedLimit = 100,
    pagination?: { page?: string | number; pageSize?: string | number }): Promise<Record<string, unknown>> {
    if (pagination) {
      const requestedPage = paginationInteger(pagination.page, 1);
      const pageSize = paginationInteger(pagination.pageSize, 20);
      if (![10, 20, 50, 100].includes(pageSize)) throw new BadRequestException('每页数量必须为 10、20、50 或 100。');
      const where = { projectId };
      const [total, initialCounts] = await Promise.all([
        this.table().count({ where }),
        this.table().groupBy({ by: ['status'], where, _count: { _all: true } }),
      ]);
      let counts = initialCounts;
      let page = Math.min(requestedPage, Math.max(1, Math.ceil(total / pageSize)));
      let rows = await this.table().findMany({ where, orderBy: { id: 'asc' }, skip: (page - 1) * pageSize,
        take: pageSize, include: { config: true } });
      // A concurrent purge can remove the old last page after the count query.
      let currentTotal = total;
      if (page > 1 && !rows.length) {
        [currentTotal, counts] = await Promise.all([
          this.table().count({ where }),
          this.table().groupBy({ by: ['status'], where, _count: { _all: true } }),
        ]);
        page = Math.min(page, Math.max(1, Math.ceil(currentTotal / pageSize)));
        rows = await this.table().findMany({ where, orderBy: { id: 'asc' }, skip: (page - 1) * pageSize,
          take: pageSize, include: { config: true } });
      }
      return {
        total: currentTotal, page, pageSize,
        items: rows.map(({ config, ...row }) => ({ ...row, size: row.size.toString(), configName: config?.name, provider: config?.provider,
          ...(config && this.isBackupOnly(config.provider) ? { backupOnly: true } : {}) })),
        counts: Object.fromEntries(counts.map(c => [c.status, c._count._all])),
        nextCursor: page * pageSize < currentTotal && rows.length ? rows[rows.length - 1].id : null,
      };
    }
    const take = Math.min(200, Math.max(1, Math.floor(requestedLimit) || 100));
    const [rows, counts] = await Promise.all([
      this.table().findMany({ where: { projectId, ...(cursor ? { id: { gt: cursor } } : {}) }, orderBy: { id: 'asc' }, take, include: { config: true } }),
      this.table().groupBy({ by: ['status'], where: { projectId }, _count: { _all: true } }),
    ]);
    return {
      items: rows.map(({ config, ...row }) => ({ ...row, size: row.size.toString(), configName: config?.name, provider: config?.provider,
        ...(config && this.isBackupOnly(config.provider) ? { backupOnly: true } : {}) })),
      counts: Object.fromEntries(counts.map(c => [c.status, c._count._all])), nextCursor: rows.length === take ? rows[rows.length - 1].id : null,
    };
  }

  async retryProject(projectId: string): Promise<{ queued: number }> {
    const result = await this.table().updateMany({ where: { projectId, status: { in: ['FAILED', 'MISSING'] }, OR: [{ leaseOwner: null }, { leaseUntil: { lte: new Date() } }] },
      data: { status: 'PENDING', nextAttemptAt: new Date(), lastError: null, leaseOwner: null, leaseUntil: null } });
    return { queued: result.count };
  }

  async inspectProject(projectId: string, cursor?: string, requestedLimit = 20): Promise<Record<string, unknown>> {
    const take = Math.min(50, Math.max(1, Math.floor(requestedLimit) || 20));
    const rows = await this.table().findMany({ where: { projectId, status: { not: 'DELETING' }, ...(cursor ? { id: { gt: cursor } } : {}), OR: [{ leaseOwner: null }, { leaseUntil: { lte: new Date() } }] },
      include: { config: true }, orderBy: { id: 'asc' }, take });
    let ready = 0, failed = 0;
    for (const row of rows) {
      if (!row.config) continue;
      let source: VerifiedObject | undefined;
      try {
        let expectedChecksum = row.checksum;
        if (!expectedChecksum && row.config.provider !== CdnProvider.LOCAL) {
          source = await this.sourceForReplica(row);
          expectedChecksum = source.checksum;
        }
        if (this.isBackupOnly(row.config.provider)) {
          if (!expectedChecksum) throw new Error('缺少可确认的源文件摘要。');
          await this.confirmStoredObject(this.runtime(row.config), row.storageKey, Number(row.size), expectedChecksum);
        } else {
          const object = await this.readVerified(this.runtime(row.config), row.storageKey, row.size, expectedChecksum);
          expectedChecksum = object.checksum; await object.cleanup();
        }
        await this.table().updateMany({ where: { id: row.id, leaseOwner: null, status: { not: 'DELETING' } }, data: { status: 'READY', checksum: expectedChecksum, verifiedAt: new Date(), lastError: null } }); ready++;
      } catch (error) { await this.markUnreadable(row, error); failed++; }
      finally { await source?.cleanup(); }
    }
    return { scanned: rows.length, ready, failed, nextCursor: rows.length === take ? rows[rows.length - 1].id : null };
  }

  async ensureProjectReplicas(projectId: string, cursor?: string, requestedLimit = 20, targetConfigId?: string): Promise<Record<string, unknown>> {
    if (targetConfigId) await this.assertProjectSyncTarget(this.prisma, projectId, targetConfigId);
    const local = await this.getLocalStorage(projectId);
    const take = Math.min(50, Math.max(1, Math.floor(requestedLimit) || 20));
    const configs = await this.prisma.cdnConfig.findMany({ where: { enabled: true, projectId: null, projectBindings: { some: { projectId } },
      ...(targetConfigId ? { id: targetConfigId } : {}) } });
    await this.table().updateMany({ where: { projectId, configId: { in: configs.map(c => c.id) }, status: 'SKIPPED', leaseOwner: null },
      data: { status: 'PENDING', nextAttemptAt: new Date(), lastError: null } });
    const files = await this.prisma.managedFile.findMany({ where: { projectId, status: 'ACTIVE', ...(cursor ? { id: { gt: cursor } } : {}) },
      orderBy: { id: 'asc' }, take, include: { versions: true, derivatives: true } });
    let queued = 0;
    for (const file of files) {
      const derivativeObjects = file.derivatives.filter(d => d.status === 'READY').flatMap(d => {
        const meta = (d.meta && typeof d.meta === 'object' && !Array.isArray(d.meta) ? d.meta : {}) as Record<string, unknown>;
        if (d.kind !== 'HLS') return [{ storageKey: d.storageKey, size: d.size as bigint | undefined, checksum: null as string | null, configId: file.cdnConfigId }];
        const keys = [d.storageKey, ...(typeof meta.segmentPrefix === 'string' && Array.isArray(meta.files)
          ? meta.files.filter((name): name is string => typeof name === 'string').map(name => `${meta.segmentPrefix as string}/${name}`) : [])];
        return keys.map(storageKey => ({ storageKey, size: undefined, checksum: null as string | null, configId: file.cdnConfigId }));
      });
      const objects = [
        { storageKey: file.storageKey, size: file.size, checksum: file.checksum, configId: file.cdnConfigId },
        ...file.versions.map(v => ({ storageKey: v.storageKey, size: v.size, checksum: v.checksum, configId: v.cdnConfigId })),
        ...derivativeObjects,
      ];
      for (const object of objects) {
        const indexed = await this.table().findFirst({ where: { projectId, storageKey: object.storageKey } });
        if (!indexed && object.size === undefined) {
          if (!object.configId) throw new NotFoundException('旧 HLS 对象缺少原存储配置。');
          await this.materializeUploadedObject(projectId, object.configId, object.storageKey, undefined, null, 'application/octet-stream', object.storageKey.split('/').pop() || 'object', targetConfigId);
          queued++;
          continue;
        }
        const size = indexed?.size ?? object.size!;
        const checksum = indexed?.checksum ?? object.checksum;
        const configIds = [...new Set([local.id, ...configs.map(c => c.id), ...(!targetConfigId && object.configId ? [object.configId] : [])])];
        const count = await this.prisma.$transaction(async tx => {
          await tx.$queryRaw`SELECT id FROM Project WHERE id = ${projectId} FOR UPDATE`;
          const current = await tx.managedFile.findFirst({ where: { id: file.id, status: 'ACTIVE' }, select: { id: true } });
          if (!current || await this.table(tx).findFirst({ where: { projectId, storageKey: object.storageKey, status: 'DELETING' } })) return 0;
          const result = await this.table(tx).createMany({ data: configIds.map(configId => ({ projectId, storageKey: object.storageKey, configId,
            size, checksum, status: 'PENDING' })), skipDuplicates: true });
          return result.count;
        });
        queued += count;
      }
    }
    return { scanned: files.length, queued, nextCursor: files.length === take ? files[files.length - 1].id : null };
  }

  async enqueueProject(projectId: string, cursor = '', client?: Prisma.TransactionClient): Promise<{ taskId: string }> {
    const enqueue = async (tx: Prisma.TransactionClient) => {
      await tx.$queryRaw`SELECT id FROM Project WHERE id = ${projectId} FOR UPDATE`;
      return this.enqueueScan(tx, projectId, cursor);
    };
    return client ? enqueue(client) : this.prisma.$transaction(enqueue);
  }

  async enqueueProjectSync(projectId: string, targetConfigId: string, client?: Prisma.TransactionClient): Promise<{ taskId: string; requeued: number }> {
    const enqueue = async (tx: Prisma.TransactionClient) => {
      await tx.$queryRaw`SELECT id FROM Project WHERE id = ${projectId} FOR UPDATE`;
      await this.assertProjectSyncTarget(tx, projectId, targetConfigId);
      const now = new Date();
      const result = await this.table(tx).updateMany({ where: { projectId, configId: targetConfigId,
        status: { in: ['READY', 'FAILED', 'MISSING', 'SKIPPED', 'UNVERIFIED'] },
        OR: [{ leaseOwner: null }, { leaseUntil: null }, { leaseUntil: { lte: now } }] },
        data: { status: 'PENDING', nextAttemptAt: now, verifiedAt: null, lastError: null, leaseOwner: null, leaseUntil: null } });
      return { ...await this.enqueueScan(tx, projectId, '', targetConfigId), requeued: result.count };
    };
    return client ? enqueue(client) : this.prisma.$transaction(enqueue);
  }

  private async assertProjectSyncTarget(client: Prisma.TransactionClient, projectId: string, configId: string): Promise<void> {
    const config = await client.cdnConfig.findFirst({ where: { id: configId, enabled: true, projectId: null,
      provider: { not: CdnProvider.LOCAL }, projectBindings: { some: { projectId } } }, select: { id: true } });
    if (!config) throw new NotFoundException('目标存储已停用或未绑定此项目，请刷新后重试。');
  }

  private async enqueueScan(tx: Prisma.TransactionClient, projectId: string, cursor: string, targetConfigId?: string): Promise<{ taskId: string }> {
    const tasks = await tx.task.findMany({ where: { projectId, type: 'STORAGE_REPLICA_SYNC', status: 'RUNNING' }, orderBy: { createdAt: 'asc' } });
    const existing = tasks.find(task => jsonRecord(task.detail).targetConfigId === targetConfigId);
    if (existing) {
      const detail = jsonRecord(existing.detail);
      await tx.task.updateMany({ where: { id: existing.id, status: 'RUNNING' }, data: { detail: { ...detail, rescanRequested: true } } });
      return { taskId: existing.id };
    }
    const task = await tx.task.create({ data: { projectId, type: 'STORAGE_REPLICA_SYNC', title: targetConfigId ? '项目同步到云端' : '存储副本补齐', status: 'RUNNING',
      detail: { cursor, scanned: 0, queued: 0, rescanRequested: false, ...(targetConfigId ? { targetConfigId, phase: 'SCANNING' } : {}) }, progress: 0 } });
    return { taskId: task.id };
  }

  async processSyncBatch(owner: string): Promise<void> {
    const now = new Date();
    const claimable = { type: 'STORAGE_REPLICA_SYNC', status: 'RUNNING', OR: [{ leaseOwner: null }, { leaseOwner: owner }, { leaseUntil: { lte: now } }] };
    // Poll waiting uploads without letting the oldest one monopolize scans.
    // Updated timestamps rotate a bounded group when many projects are waiting.
    const tasks = await this.prisma.task.findMany({ where: claimable, orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }], take: 10 });
    for (const task of tasks) {
      if (!task.projectId) continue;
      const detail = jsonRecord(task.detail);
      const waiting = typeof detail.targetConfigId === 'string' && detail.phase === 'AWAITING_REPLICAS';
      await this.processSyncTask(task, owner, claimable);
      if (!waiting) break;
    }
  }

  private async processSyncTask(task: { id: string; projectId: string | null; detail: Prisma.JsonValue }, owner: string,
    claimable: Record<string, unknown>): Promise<void> {
    if (!task.projectId) return;
    const claimed = await this.prisma.task.updateMany({ where: { id: task.id, ...claimable }, data: { leaseOwner: owner, leaseUntil: new Date(Date.now() + LEASE_MS) } });
    if (claimed.count !== 1) return;
    const detail = jsonRecord(task.detail);
    const heartbeat = setInterval(() => { void this.prisma.task.updateMany({ where: { id: task.id, status: 'RUNNING', leaseOwner: owner },
      data: { leaseUntil: new Date(Date.now() + LEASE_MS) } }).catch(() => this.logger.warn('副本扫描任务续租失败。')); }, 30_000);
    heartbeat.unref?.();
    try {
      const targetConfigId = typeof detail.targetConfigId === 'string' ? detail.targetConfigId : undefined;
      if (targetConfigId && detail.phase === 'AWAITING_REPLICAS') {
        await this.checkSelectedReplicas(task.id, task.projectId, targetConfigId, owner);
        return;
      }
      if (targetConfigId && detail.retryReplicas === true) {
        await this.assertProjectSyncTarget(this.prisma, task.projectId, targetConfigId);
        const now = new Date();
        await this.table().updateMany({ where: { projectId: task.projectId, configId: targetConfigId,
          status: { in: ['FAILED', 'MISSING', 'SKIPPED', 'UNVERIFIED'] },
          OR: [{ leaseOwner: null }, { leaseUntil: null }, { leaseUntil: { lte: now } }] },
          data: { status: 'PENDING', nextAttemptAt: now, verifiedAt: null, lastError: null, leaseOwner: null, leaseUntil: null } });
      }
      const result = await this.ensureProjectReplicas(task.projectId, typeof detail.cursor === 'string' ? detail.cursor : '', 20,
        targetConfigId);
      const cursor = typeof result.nextCursor === 'string' ? result.nextCursor : '';
      await this.prisma.$transaction(async tx => {
        // Binding updates use this same project lock. Re-read the persisted
        // request at checkpoint so a concurrent enqueue cannot be overwritten.
        await tx.$queryRaw`SELECT id FROM Project WHERE id = ${task.projectId} FOR UPDATE`;
        const latest = await tx.task.findUnique({ where: { id: task.id } });
        if (!latest || latest.status !== 'RUNNING' || latest.leaseOwner !== owner) return;
        const latestDetail = jsonRecord(latest.detail);
        const rescan = !cursor && latestDetail.rescanRequested === true;
        const scanning = Boolean(cursor) || rescan;
        const running = scanning || Boolean(targetConfigId);
        await tx.task.updateMany({ where: { id: task.id, status: 'RUNNING', leaseOwner: owner }, data: {
          detail: { ...latestDetail, cursor, scanned: (Number(detail.scanned) || 0) + Number(result.scanned), queued: (Number(detail.queued) || 0) + Number(result.queued),
            rescanRequested: rescan ? false : latestDetail.rescanRequested === true,
            ...(targetConfigId ? { phase: scanning ? 'SCANNING' : 'AWAITING_REPLICAS', retryReplicas: false } : {}) },
          status: running ? 'RUNNING' : 'COMPLETED', progress: running ? 0 : 100, finishedAt: running ? null : new Date(),
          leaseOwner: null, leaseUntil: null, error: null,
        } });
      });
    } catch (error) {
      await this.prisma.task.updateMany({ where: { id: task.id, status: 'RUNNING', leaseOwner: owner }, data: {
        status: 'FAILED', error: safeError(error), leaseOwner: null, leaseUntil: null, finishedAt: new Date(),
      } });
    } finally { clearInterval(heartbeat); }
  }

  private async checkSelectedReplicas(taskId: string, projectId: string, configId: string, owner: string): Promise<void> {
    await this.assertProjectSyncTarget(this.prisma, projectId, configId);
    const counts = { replicaTotal: 0, replicaReady: 0, replicaPending: 0, replicaFailed: 0 };
    const checked = new Set<string>();
    let cursor = '';
    do {
      // This is a read-only status snapshot of objects still needed by active
      // files. Old orphan/recycled replicas must not hold this task open.
      const files = await this.prisma.managedFile.findMany({ where: { projectId, status: 'ACTIVE', ...(cursor ? { id: { gt: cursor } } : {}) },
        orderBy: { id: 'asc' }, take: 100, select: { id: true, storageKey: true, versions: { select: { storageKey: true } },
          derivatives: { where: { status: 'READY' }, select: { storageKey: true, kind: true, status: true, meta: true } } } });
      const keys = [...new Set(files.flatMap(file => [file.storageKey, ...file.versions.map(version => version.storageKey),
        ...file.derivatives.filter(derivative => derivative.status === 'READY').flatMap(derivative => {
          const meta = (derivative.meta && typeof derivative.meta === 'object' && !Array.isArray(derivative.meta) ? derivative.meta : {}) as Record<string, unknown>;
          return [derivative.storageKey, ...(derivative.kind === 'HLS' && typeof meta.segmentPrefix === 'string' && Array.isArray(meta.files)
            ? meta.files.filter((name): name is string => typeof name === 'string').map(name => `${meta.segmentPrefix as string}/${name}`) : [])];
        })]))].filter(key => !checked.has(key));
      for (let index = 0; index < keys.length; index += 200) {
        const chunk = keys.slice(index, index + 200);
        const rows = await this.table().findMany({ where: { projectId, configId, storageKey: { in: chunk } },
          select: { storageKey: true, status: true, leaseOwner: true, leaseUntil: true } });
        const byKey = new Map(rows.map(row => [row.storageKey, row]));
        for (const key of chunk) {
          checked.add(key); counts.replicaTotal++;
          const row = byKey.get(key);
          const leased = row?.leaseOwner && row.leaseUntil && row.leaseUntil > new Date();
          if (leased) counts.replicaPending++;
          else if (row?.status === 'READY') counts.replicaReady++;
          else if (!row || ['FAILED', 'MISSING', 'SKIPPED', 'DELETING'].includes(row.status)) counts.replicaFailed++;
          else counts.replicaPending++;
        }
      }
      cursor = files.length === 100 ? files[files.length - 1].id : '';
    } while (cursor);
    await this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM Project WHERE id = ${projectId} FOR UPDATE`;
      const latest = await tx.task.findUnique({ where: { id: taskId } });
      if (!latest || latest.status !== 'RUNNING' || latest.leaseOwner !== owner) return;
      const detail = jsonRecord(latest.detail);
      const rescan = detail.rescanRequested === true;
      const status = rescan || counts.replicaPending > 0 ? 'RUNNING' : 'COMPLETED';
      const failed = !rescan && counts.replicaFailed > 0;
      await tx.task.updateMany({ where: { id: taskId, status: 'RUNNING', leaseOwner: owner }, data: {
        detail: { ...detail, ...counts, ...(rescan ? { phase: 'SCANNING', cursor: '', rescanRequested: false } : {}) },
        status: failed ? 'FAILED' : status,
        progress: rescan ? 0 : !failed && status === 'COMPLETED' ? 100 : counts.replicaTotal ? Math.min(99, Math.floor(100 * counts.replicaReady / counts.replicaTotal)) : 0,
        error: failed ? `所选云存储有 ${counts.replicaFailed} 个所需对象同步失败或缺失，请重试此任务。` : null,
        finishedAt: !failed && status === 'RUNNING' ? null : new Date(), leaseOwner: null, leaseUntil: null,
      } });
    });
  }

  private runtime(config: CdnConfig): RuntimeCdnConfig {
    const cryptoKey = (this.configService.get<string>('APP_CRYPTO_KEY') ?? '').trim() || 'local-development-crypto-key';
    const raw = (config.config ?? {}) as Record<string, unknown>;
    return { id: config.id, provider: config.provider, name: config.name, config: Object.fromEntries(Object.entries(raw).map(([key, value]) =>
      [key, typeof value === 'string' && value.startsWith('vault:') ? decryptText(value.slice(6), cryptoKey) : value])) };
  }
}

function paginationInteger(value: string | number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if ((typeof value !== 'string' && typeof value !== 'number') || (typeof value === 'string' && !/^\d+$/.test(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) {
    throw new BadRequestException('分页参数必须为正整数。');
  }
  return Number(value);
}

/** Reads with backpressure and bounds RAM independently of the object size. */
export async function spoolVerifiedStream(stream: Readable, expectedSize?: bigint | number, expectedChecksum?: string | null): Promise<VerifiedObject> {
  const dir = await mkdtemp(join(tmpdir(), 'ufm-replica-'));
  const path = join(dir, 'object');
  const cleanup = async () => { await rm(dir, { recursive: true, force: true }); };
  const digest = createHash('sha256'); let size = 0;
  const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    size += chunk.length;
    if (expectedSize !== undefined && BigInt(size) > BigInt(expectedSize)) { callback(new Error('对象大小与记录不一致。')); return; }
    digest.update(chunk); callback(null, chunk);
  } });
  try {
    await pipeline(stream, meter, createWriteStream(path), { signal: AbortSignal.timeout(10 * 60_000) });
    const checksum = digest.digest('hex');
    if (expectedSize !== undefined && BigInt(size) !== BigInt(expectedSize)) throw new Error('对象大小与记录不一致。');
    if (expectedChecksum && checksum !== expectedChecksum) throw new Error('对象 SHA256 校验失败。');
    return { path, size, checksum, cleanup };
  } catch (error) { await cleanup(); throw error; }
}

export function verifiedTarget(object: VerifiedObject, range?: StorageByteRange, contentType?: string): StorageDownloadTarget {
  const stream = createReadStream(object.path, range ? { start: range.start, end: range.end } : {});
  stream.once('close', () => { void object.cleanup().catch(() => undefined); });
  return { type: 'stream', stream, contentType, verified: true, checksum: object.checksum,
    contentLength: range ? Math.max(0, (range.end ?? object.size - 1) - (range.start ?? 0) + 1) : object.size };
}
function normalizeKey(key: string): string { return key.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/{2,}/g, '/'); }
function safeError(error: unknown): string {
  if (error instanceof StorageLimitError) return error.message;
  if (error instanceof NotFoundException) return '存储对象不存在或没有可验证的源副本。';
  const message = error instanceof Error ? error.message : '存储复制失败。';
  // Provider errors can contain credentials or signed URLs. Only our fixed
  // integrity messages are retained; upstream error bodies never enter the DB.
  const known = new Set([
    '对象大小与记录不一致。', '对象 SHA256 校验失败。', '本地写盘对象大小或 SHA256 校验失败。',
    '复制目标返回了不同的不可变 key。', '存储适配器未支持流式复制，超过 32MiB 的对象已保留本地等待重试。',
    '存储已达到空间或流量阈值，等待用量恢复后重试。', '不可变存储对象内容冲突，请使用新的存储 key。',
    '不可变本地对象内容冲突，请使用新的存储 key。',
    '副本所属项目资料不完整，等待修复后重试。',
  ]);
  return known.has(message) ? message : '存储连接或复制失败，请检查配置并重试。';
}
function jsonRecord(value: unknown): Record<string, string | number | boolean | null> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string | number | boolean | null] =>
    entry[1] === null || typeof entry[1] === 'string' || typeof entry[1] === 'number' || typeof entry[1] === 'boolean'));
}
