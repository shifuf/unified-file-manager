import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CdnProvider, type CdnConfig, type Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

import { PrismaService } from '../prisma/prisma.service';
import { decryptText } from './crypto.util';
import { StorageAdapterRegistry } from './storage-registry.service';
import type { RuntimeCdnConfig, StorageUsageSnapshot } from './storage.types';

type LimitConfig = Pick<CdnConfig, 'id' | 'provider'> & Partial<Pick<CdnConfig,
  'enabled' | 'storageLimitEnabled' | 'trafficLimitEnabled' | 'trafficQuotaMode' | 'trafficPeriodKey' |
  'quotaRevision' | 'trackedStorageBytes' | 'storageBaselineBytes' | 'storageQuotaBytes' | 'manualStorageUsedBytes' |
  'trafficQuotaBytes' | 'manualTrafficUsedBytes' | 'failoverThresholdPercent'>>;

export type ReadReservation = { configId: string; revision: number; period: string | null; bytes: bigint | null; settled: boolean };
export type UploadReservation = { verification: ReadReservation; space?: { id: string; configId: string; owner: string; revision: number; size: bigint } };

/** Admission failure is availability, never evidence that a replica is corrupt. */
export class StorageLimitError extends ServiceUnavailableException {
  constructor(message: string) { super(message); }
}

@Injectable()
export class StorageLimitsService {
  constructor(private readonly prisma: PrismaService, private readonly registry: StorageAdapterRegistry,
    private readonly configService: ConfigService) {}

  now(): Date { return new Date(); }

  currentPeriodKey(): string {
    return new Date(this.now().getTime() + 8 * 3600_000).toISOString().slice(0, 7);
  }

  describe(config: Partial<CdnConfig>) {
    const mode = config.trafficQuotaMode === 'MONTHLY' ? 'MONTHLY' : 'FIXED';
    const period = mode === 'MONTHLY' ? this.currentPeriodKey() : null;
    const used = config.trafficLimitEnabled === true && mode === 'MONTHLY' && config.trafficPeriodKey !== period ? 0n : config.manualTrafficUsedBytes ?? 0n;
    const quota = config.trafficQuotaBytes;
    const remaining = quota == null ? null : quota > used ? quota - used : 0n;
    return { storageLimitEnabled: config.storageLimitEnabled !== false, trafficLimitEnabled: config.trafficLimitEnabled === true,
      trafficQuotaMode: mode, trafficPeriodKey: period, trafficUsedBytes: used.toString(),
      trafficRemainingBytes: remaining?.toString() ?? null,
      trafficExhausted: config.trafficLimitEnabled === true && (remaining === null || remaining === 0n),
      trackedStorageBytes: (config.trackedStorageBytes ?? 0n).toString() };
  }

  async reserveRead(config: LimitConfig, expectedBytes?: bigint | number): Promise<ReadReservation> {
    if (config.provider === CdnProvider.LOCAL) return this.unlimited(config.id);
    const size = expectedBytes === undefined ? undefined : bytes(expectedBytes);
    for (let attempt = 0; attempt < 64; attempt++) {
      const current = await this.current(config.id);
      if (await this.resetMonth(current)) continue;
      if (!current.trafficLimitEnabled) return this.unlimited(config.id);
      const remaining = this.remaining(current);
      const amount = size ?? remaining;
      if (remaining <= 0n || amount > remaining) throw new StorageLimitError('云存储流量额度不足，等待额度恢复后重试。');
      const changed = await this.prisma.cdnConfig.updateMany({ where: this.compare(current),
        data: { manualTrafficUsedBytes: (current.manualTrafficUsedBytes ?? 0n) + amount } });
      if (changed.count === 1) return this.ticket(current, amount);
    }
    throw new StorageLimitError('云存储额度正在被其他请求使用，请稍后重试。');
  }

  async settleRead(ticket: ReadReservation, actualBytes: bigint): Promise<void> {
    if (ticket.settled) return;
    ticket.settled = true;
    if (ticket.bytes === null) return;
    const actual = bytes(actualBytes);
    if (actual > ticket.bytes) throw new Error('读取字节超过预留额度。');
    const refund = ticket.bytes - actual;
    if (refund === 0n) return;
    await this.prisma.cdnConfig.updateMany({ where: { id: ticket.configId, quotaRevision: ticket.revision,
      trafficPeriodKey: ticket.period }, data: { manualTrafficUsedBytes: { decrement: refund } } });
  }

  /** Bounds bytes admitted to the application, and settles even on checksum/network failures. */
  async consumeRead<T>(ticket: ReadReservation, source: Readable, consume: (stream: Readable) => Promise<T>): Promise<T> {
    let actual = 0n;
    const maximum = ticket.bytes;
    // Keep the source paused and pull only the bytes covered by the reservation.
    // A cloud stream may prefetch into its own buffer; those unread bytes are
    // discarded on cancellation and are not delivered to integrity validation.
    const onSourceError = () => undefined;
    source.on('error', onSourceError);
    async function* chunks() {
      while (true) {
        if (source.errored) throw source.errored;
        if (source.readableEnded) return;
        if (source.destroyed) throw new Error('远程存储读取意外中断。');
        if (source.readableLength === 0) {
          source.read(0);
          if (!source.readableEnded && source.readableLength === 0) await waitReadable(source);
          continue;
        }
        if (maximum !== null && actual === maximum) throw new StorageLimitError('云存储读取大小超过预留流量额度。');
        const available = source.readableLength;
        const count = maximum === null ? available : Number(BigInt(available) < maximum - actual ? BigInt(available) : maximum - actual);
        const value = source.read(count);
        if (value === null) continue;
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        // Some adapters expose Buffer objects in objectMode, where read(n) counts
        // objects. Put the unread suffix back before delivering the bounded part.
        if (maximum !== null && BigInt(chunk.length) > maximum - actual) {
          const remaining = Number(maximum - actual);
          source.unshift(chunk.subarray(remaining));
          actual += BigInt(remaining);
          yield chunk.subarray(0, remaining);
        } else {
          actual += BigInt(chunk.length);
          yield chunk;
        }
      }
    }
    const metered = Readable.from(chunks());
    try { return await consume(metered); }
    finally {
      metered.destroy(); source.destroy();
      await this.settleRead(ticket, actual);
      source.off('error', onSourceError);
    }
  }

  /** Space and the verification read are reserved in one database compare-and-swap. */
  async reserveUpload(config: LimitConfig, expectedBytes: bigint | number, storageKey?: string): Promise<UploadReservation> {
    const size = bytes(expectedBytes);
    if (config.provider === CdnProvider.LOCAL) return { verification: this.unlimited(config.id) };
    let usage: StorageUsageSnapshot | undefined;
    for (let attempt = 0; attempt < 64; attempt++) {
      const current = await this.current(config.id);
      if (await this.resetMonth(current)) continue;
      const chargeRead = current.trafficLimitEnabled && this.registry.manifest?.(current.provider)?.capabilities.backupOnly !== true;
      if (chargeRead && (this.remaining(current) <= 0n || size > this.remaining(current))) {
        throw new StorageLimitError('云存储流量额度不足，无法上传并校验对象。');
      }
      if (current.storageLimitEnabled !== false && usage === undefined) usage = await this.usage(current);
      const quota = current.storageQuotaBytes ?? measurement(usage?.storageQuotaBytes);
      const trackSpace = current.storageLimitEnabled !== false && quota !== null;
      if (trackSpace && storageKey !== undefined) return this.reserveKeyUpload(config.id, storageKey, size, usage ?? {});
      if (trackSpace) this.assertSpace(current, usage ?? {}, size);
      if (!trackSpace && !chargeRead) return { verification: this.unlimited(config.id) };
      const changed = await this.prisma.cdnConfig.updateMany({ where: this.compare(current), data: {
        ...(trackSpace ? { trackedStorageBytes: (current.trackedStorageBytes ?? 0n) + size } : {}),
        ...(trackSpace && current.manualStorageUsedBytes == null && current.storageBaselineBytes == null
          ? { storageBaselineBytes: measurement(usage?.storageUsedBytes) } : {}),
        ...(chargeRead ? { manualTrafficUsedBytes: (current.manualTrafficUsedBytes ?? 0n) + size } : {}),
      } });
      if (changed.count === 1) return { verification: chargeRead ? this.ticket(current, size) : this.unlimited(config.id) };
    }
    throw new StorageLimitError('云存储额度正在被其他请求使用，请稍后重试。');
  }

  private async reserveKeyUpload(configId: string, storageKey: string, size: bigint, usage: StorageUsageSnapshot): Promise<UploadReservation> {
    const keyHash = createHash('sha256').update(storageKey).digest('hex');
    return this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM CdnConfig WHERE id = ${configId} FOR UPDATE`;
      let current = await this.current(configId, tx);
      if (await this.resetMonth(current, tx)) current = await this.current(configId, tx);
      const chargeRead = current.trafficLimitEnabled && this.registry.manifest?.(current.provider)?.capabilities.backupOnly !== true;
      const track = current.storageLimitEnabled !== false && (current.storageQuotaBytes ?? measurement(usage.storageQuotaBytes)) !== null;
      const existing = track ? await tx.storageSpaceReservation.findUnique({ where: { configId_keyHash: { configId, keyHash } } }) : null;
      if (existing?.owner && existing.leaseUntil && existing.leaseUntil > this.now()) {
        throw new StorageLimitError('同一云对象正在上传，请稍后重试。');
      }
      if (existing && (existing.storageKey !== storageKey || existing.size !== size)) throw new StorageLimitError('不可变对象空间预留大小冲突。');
      if (chargeRead && (this.remaining(current) <= 0n || size > this.remaining(current))) {
        throw new StorageLimitError('云存储流量额度不足，无法上传并校验对象。');
      }
      if (track) this.assertSpace(current, usage, size, existing?.size ?? 0n);
      const owner = randomUUID();
      // Upload and verification each have a ten-minute timeout. A crashed writer's
      // reservation remains counted, and can be reused once this lease expires.
      const leaseUntil = new Date(this.now().getTime() + 25 * 60_000);
      const space = track ? existing
        ? await tx.storageSpaceReservation.update({ where: { id: existing.id }, data: { owner, leaseUntil, quotaRevision: current.quotaRevision } })
        : await tx.storageSpaceReservation.create({ data: { configId, keyHash, storageKey, size, owner, leaseUntil, quotaRevision: current.quotaRevision } })
        : null;
      await tx.cdnConfig.updateMany({ where: this.compare(current), data: {
        ...(track && !existing ? { trackedStorageBytes: (current.trackedStorageBytes ?? 0n) + size } : {}),
        ...(track && current.manualStorageUsedBytes == null && current.storageBaselineBytes == null
          ? { storageBaselineBytes: measurement(usage.storageUsedBytes) } : {}),
        ...(chargeRead ? { manualTrafficUsedBytes: (current.manualTrafficUsedBytes ?? 0n) + size } : {}),
      } });
      return { verification: chargeRead ? this.ticket(current, size) : this.unlimited(configId),
        ...(space ? { space: { id: space.id, configId, owner, revision: current.quotaRevision, size } } : {}) };
    });
  }

  /** Only the owning writer can release its reservation after a reliable absence probe. */
  async finishUpload(reservation: UploadReservation, outcome: 'PRESENT' | 'ABSENT' | 'UNKNOWN'): Promise<void> {
    if (!reservation.space) return;
    const ticket = reservation.space;
    await this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM CdnConfig WHERE id = ${ticket.configId} FOR UPDATE`;
      const current = await tx.cdnConfig.findFirst({ where: { id: ticket.configId } });
      const space = await tx.storageSpaceReservation.findUnique({ where: { id: ticket.id } });
      if (!current || !space || space.owner !== ticket.owner) return;
      if (outcome === 'ABSENT') {
        // Baseline correction deletes the old ledger under the same row lock.
        // A surviving owned row therefore still belongs to this tracked total,
        // even if a traffic-only edit or month rollover advanced quotaRevision.
        await tx.cdnConfig.updateMany({ where: { id: ticket.configId, quotaRevision: current.quotaRevision,
          trackedStorageBytes: { gte: space.size } }, data: { trackedStorageBytes: { decrement: space.size } } });
        await tx.storageSpaceReservation.delete({ where: { id: space.id } });
      } else {
        await tx.storageSpaceReservation.update({ where: { id: space.id }, data: { owner: null, leaseUntil: null } });
      }
    });
  }

  async releaseDeletedObject(configId: string, storageKey: string): Promise<void> {
    const keyHash = createHash('sha256').update(storageKey).digest('hex');
    await this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM CdnConfig WHERE id = ${configId} FOR UPDATE`;
      const space = await tx.storageSpaceReservation.findUnique({ where: { configId_keyHash: { configId, keyHash } } });
      if (!space) return;
      if (space.owner && space.leaseUntil && space.leaseUntil > this.now()) throw new StorageLimitError('对象仍在上传，请稍后重试删除。');
      await tx.cdnConfig.updateMany({ where: { id: configId, trackedStorageBytes: { gte: space.size } },
        data: { trackedStorageBytes: { decrement: space.size } } });
      await tx.storageSpaceReservation.delete({ where: { id: space.id } });
    });
  }

  async reconcileFailedUpload(reservation: UploadReservation, config: RuntimeCdnConfig, key: string): Promise<void> {
    let outcome: 'PRESENT' | 'ABSENT' | 'UNKNOWN' = 'UNKNOWN';
    try {
      const exists = await this.registry.adapter(config.provider).objectExists?.(config, key);
      if (exists !== undefined) outcome = exists ? 'PRESENT' : 'ABSENT';
    } catch { /* Ambiguous outcomes retain one reusable reservation for this key. */ }
    await this.finishUpload(reservation, outcome);
    await this.settleRead(reservation.verification, 0n);
  }

  async uploadBlocked(config: CdnConfig): Promise<boolean> {
    if (config.provider === CdnProvider.LOCAL) return false;
    if (!config.enabled || this.describe(config).trafficExhausted) return true;
    if (config.storageLimitEnabled === false) return false;
    try { this.assertSpace(config, await this.usage(config), 0n); return false; }
    catch (error) { if (error instanceof StorageLimitError) return true; throw error; }
  }

  private assertSpace(config: LimitConfig, usage: StorageUsageSnapshot, incoming: bigint, reserved = 0n): void {
    const quota = config.storageQuotaBytes ?? measurement(usage.storageQuotaBytes);
    if (quota === null) return;
    const reported = measurement(usage.storageUsedBytes);
    const baseline = config.manualStorageUsedBytes ?? config.storageBaselineBytes ?? reported;
    // Unknown provider usage cannot safely be interpreted as an empty bucket.
    if (baseline === null) throw new StorageLimitError('云存储空间用量未知，请先填写已用空间。');
    const estimate = baseline + (config.trackedStorageBytes ?? 0n);
    const total = config.manualStorageUsedBytes == null && reported !== null && reported > estimate ? reported : estimate;
    const used = total > reserved ? total - reserved : 0n;
    const percent = config.failoverThresholdPercent ?? 90;
    const threshold = BigInt(Math.round(Math.max(0, Math.min(100, percent)) * 100));
    if (quota <= 0n || used * 10_000n >= quota * threshold || used + incoming > quota) {
      throw new StorageLimitError('云存储空间不足或已达到上传阈值。');
    }
  }

  private async current(id: string, client: Pick<Prisma.TransactionClient, 'cdnConfig'> = this.prisma): Promise<CdnConfig> {
    const current = await client.cdnConfig.findFirst({ where: { id } });
    if (!current || !current.enabled) throw new StorageLimitError('云存储已停用或不存在。');
    return current;
  }

  private async resetMonth(config: CdnConfig, client: Pick<Prisma.TransactionClient, 'cdnConfig'> = this.prisma): Promise<boolean> {
    if (!config.trafficLimitEnabled || config.trafficQuotaMode !== 'MONTHLY' || config.trafficPeriodKey === this.currentPeriodKey()) return false;
    await client.cdnConfig.updateMany({ where: this.compare(config), data: {
      trafficPeriodKey: this.currentPeriodKey(), manualTrafficUsedBytes: 0n, quotaRevision: { increment: 1 },
    } });
    return true;
  }

  private compare(config: CdnConfig) {
    return { id: config.id, enabled: config.enabled, quotaRevision: config.quotaRevision,
      manualTrafficUsedBytes: config.manualTrafficUsedBytes, trackedStorageBytes: config.trackedStorageBytes,
      storageBaselineBytes: config.storageBaselineBytes,
      trafficPeriodKey: config.trafficPeriodKey };
  }

  private remaining(config: CdnConfig): bigint {
    const quota = config.trafficQuotaBytes ?? 0n;
    const used = config.manualTrafficUsedBytes ?? 0n;
    return quota > used ? quota - used : 0n;
  }

  private ticket(config: CdnConfig, amount: bigint): ReadReservation {
    return { configId: config.id, revision: config.quotaRevision, period: config.trafficPeriodKey, bytes: amount, settled: false };
  }

  private unlimited(configId: string): ReadReservation {
    return { configId, revision: 0, period: null, bytes: null, settled: false };
  }

  private async usage(config: CdnConfig): Promise<StorageUsageSnapshot> {
    if (config.manualStorageUsedBytes !== null && config.manualStorageUsedBytes !== undefined && config.storageQuotaBytes !== null) return {};
    const key = (this.configService.get<string>('APP_CRYPTO_KEY') ?? '').trim() || 'local-development-crypto-key';
    const raw = (config.config ?? {}) as Record<string, unknown>;
    const runtime: RuntimeCdnConfig = { id: config.id, name: config.name, provider: config.provider,
      config: Object.fromEntries(Object.entries(raw).map(([name, value]) => [name,
        typeof value === 'string' && value.startsWith('vault:') ? decryptText(value.slice(6), key) : value])) };
    try { return await this.registry.adapter(config.provider).getUsage?.(runtime) ?? {}; }
    catch { return {}; }
  }
}

function bytes(value: bigint | number): bigint {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) throw new Error('字节数必须为非负安全整数。');
  const result = BigInt(value);
  if (result < 0n) throw new Error('字节数必须为非负安全整数。');
  return result;
}

function measurement(value: number | null | undefined): bigint | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
}

async function waitReadable(stream: Readable): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => { stream.off('readable', ready); stream.off('end', ready); stream.off('close', ready); stream.off('error', failed); };
    const ready = () => { cleanup(); resolve(); };
    const failed = (error: Error) => { cleanup(); reject(error); };
    stream.once('readable', ready); stream.once('end', ready); stream.once('close', ready); stream.once('error', failed);
  });
}
