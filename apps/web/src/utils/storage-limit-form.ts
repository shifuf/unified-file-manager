import type { CdnConfig } from '../types';

export function storageSpaceView(config: Partial<CdnConfig>, reported?: { storageUsedBytes?: number | null; storageQuotaBytes?: number | null }) {
  const quota = config.storageQuotaBytes == null ? reported?.storageQuotaBytes ?? null : Number(config.storageQuotaBytes);
  const tracked = Number(config.trackedStorageBytes ?? 0);
  const baseline = config.storageBaselineBytes == null ? null : Number(config.storageBaselineBytes);
  const providerUsed = reported?.storageUsedBytes ?? null;
  const used = config.manualStorageUsedBytes != null ? Number(config.manualStorageUsedBytes) + tracked
    : baseline != null ? Math.max(baseline + tracked, providerUsed ?? 0) : providerUsed == null ? null : providerUsed + tracked;
  const enabled = config.provider !== 'LOCAL' && config.storageLimitEnabled !== false;
  const paused = enabled && quota != null && (used == null || quota <= 0 || used >= quota * (config.failoverThresholdPercent ?? 90) / 100);
  return { used, quota, paused, unknown: enabled && quota != null && used == null };
}

export function limitFormValues(config: Partial<CdnConfig>) {
  const gib = (value: string | null | undefined) => value == null ? null : Number((Number(value) / 1073741824).toFixed(6));
  return {
    storageLimitEnabled: config.storageLimitEnabled !== false,
    trafficLimitEnabled: config.trafficLimitEnabled === true,
    trafficQuotaMode: config.trafficQuotaMode === 'MONTHLY' ? 'MONTHLY' as const : 'FIXED' as const,
    storageQuotaGiB: gib(config.storageQuotaBytes),
    manualStorageUsedGiB: gib(config.manualStorageUsedBytes),
    trafficQuotaGiB: gib(config.trafficQuotaBytes),
    manualTrafficUsedGiB: gib(config.trafficUsedBytes ?? config.manualTrafficUsedBytes),
  };
}

export function storageLimitPayload(form: ReturnType<typeof limitFormValues>, initial?: ReturnType<typeof limitFormValues>) {
  const data: { storageLimitEnabled: boolean; trafficLimitEnabled: boolean; trafficQuotaMode: 'MONTHLY' | 'FIXED';
    storageQuotaBytes?: number | null; manualStorageUsedBytes?: number | null;
    trafficQuotaBytes?: number | null; manualTrafficUsedBytes?: number | null } = {
      storageLimitEnabled: form.storageLimitEnabled, trafficLimitEnabled: form.trafficLimitEnabled, trafficQuotaMode: form.trafficQuotaMode,
    };
  for (const [field, key] of [['storageQuotaGiB', 'storageQuotaBytes'], ['manualStorageUsedGiB', 'manualStorageUsedBytes'],
    ['trafficQuotaGiB', 'trafficQuotaBytes'], ['manualTrafficUsedGiB', 'manualTrafficUsedBytes']] as const) {
    const value = form[field];
    if (initial && value === initial[field]) continue;
    const bytes = value == null ? null : Math.round(value * 1073741824);
    if (bytes !== null && (!Number.isSafeInteger(bytes) || bytes < 0)) throw new Error('额度或已用量超出允许范围。');
    data[key] = bytes;
  }
  return data;
}
