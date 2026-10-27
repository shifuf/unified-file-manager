export type QuotaMeasurement = {
  quotaBytes: number | bigint | null | undefined;
  usedBytes: number | bigint | null | undefined;
  thresholdPercent: number | null | undefined;
};

export type StorageCandidate = {
  id: string;
  enabled: boolean;
  priority: number;
};

/**
 * Returns null when the quota or measurement is unknown. Unknown provider usage
 * must never be represented as zero, since doing so can hide an exhausted plan.
 */
export function isStorageAtFailoverThreshold(measurement: QuotaMeasurement): boolean | null {
  const quota = toFiniteNumber(measurement.quotaBytes);
  const used = toFiniteNumber(measurement.usedBytes);
  const threshold = toFiniteNumber(measurement.thresholdPercent);

  if (quota === null || quota <= 0 || used === null || used < 0 || threshold === null) {
    return null;
  }

  if (threshold <= 0 || threshold > 100) {
    return null;
  }

  return (used / quota) * 100 >= threshold;
}

/** Return active destinations in deterministic priority order, excluding source/current storage. */
export function orderStorageCandidates<T extends StorageCandidate>(
  candidates: readonly T[],
  excludeConfigId?: string | null,
): T[] {
  return candidates
    .filter((candidate) => candidate.enabled && candidate.id !== excludeConfigId)
    .slice()
    .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));
}

function toFiniteNumber(value: number | bigint | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  const numeric = typeof value === 'bigint' ? Number(value) : value;
  return Number.isFinite(numeric) ? numeric : null;
}

export type UsageSource = 'provider' | 'manual' | 'unavailable';

export function resolveUsageValue(
  providerValue: number | null | undefined,
  manualValue: number | bigint | null | undefined,
): { value: number | null; source: UsageSource } {
  if (providerValue != null && Number.isFinite(providerValue) && providerValue >= 0) {
    return { value: providerValue, source: 'provider' };
  }
  if (manualValue != null) {
    const value = typeof manualValue === 'bigint' ? Number(manualValue) : manualValue;
    if (Number.isFinite(value) && value >= 0) return { value, source: 'manual' };
  }
  return { value: null, source: 'unavailable' };
}
export type FailoverCandidate = StorageCandidate & { atThreshold: boolean | null };

/** Unknown quota data does not prove exhaustion; known-exhausted candidates are skipped. */
export function selectFailoverStorage<T extends FailoverCandidate>(
  candidates: readonly T[],
  currentConfigId: string,
): T | null {
  return orderStorageCandidates(candidates, currentConfigId).find((candidate) => candidate.atThreshold !== true) ?? null;
}
export type DualQuotaMeasurement = {
  thresholdPercent: number;
  storageQuotaBytes?: number | bigint | null;
  storageUsedBytes?: number | bigint | null;
  trafficQuotaBytes?: number | bigint | null;
  trafficUsedBytes?: number | bigint | null;
};

export function isAnyStorageUsageAtThreshold(measurement: DualQuotaMeasurement): boolean | null {
  const space = isStorageAtFailoverThreshold({
    quotaBytes: measurement.storageQuotaBytes,
    usedBytes: measurement.storageUsedBytes,
    thresholdPercent: measurement.thresholdPercent,
  });
  const traffic = isStorageAtFailoverThreshold({
    quotaBytes: measurement.trafficQuotaBytes,
    usedBytes: measurement.trafficUsedBytes,
    thresholdPercent: measurement.thresholdPercent,
  });
  if (space === true || traffic === true) return true;
  if (space === null && traffic === null) return null;
  if (space === null || traffic === null) return null;
  return false;
}
