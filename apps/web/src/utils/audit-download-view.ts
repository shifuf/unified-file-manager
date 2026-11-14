import type { DownloadStorageSource } from '@/types';

type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
}

export function isDownloadAudit(action: string): boolean {
  return ['FILE_DOWNLOAD', 'FILE_SHARE_DOWNLOAD', 'FOLDER_SHARE_DOWNLOAD'].includes(action);
}

export function auditDownloadSource(detail: unknown): DownloadStorageSource | null {
  const source = object(object(detail)?.storageSource);
  if (!source || source.strategy !== 'CLOUD_PRIORITY' || !Array.isArray(source.attempts)) return null;
  const identity = (value: unknown): DownloadStorageSource['selected'] | null => {
    const row = object(value);
    if (!row || typeof row.configId !== 'string' || typeof row.configName !== 'string'
      || !['LOCAL', 'QINIU', 'ALIYUN', 'S3', 'UPYUN'].includes(String(row.provider))) return null;
    return { configId: row.configId, configName: row.configName, provider: row.provider as DownloadStorageSource['selected']['provider'] };
  };
  const selected = identity(source.selected);
  if (!selected) return null;
  const attempts: DownloadStorageSource['attempts'] = [];
  for (const value of source.attempts) {
    const row = object(value), storage = identity(value);
    if (!row || !storage || !['SELECTED', 'FAILED', 'SKIPPED'].includes(String(row.outcome))) return null;
    attempts.push({ ...storage, outcome: row.outcome as DownloadStorageSource['attempts'][number]['outcome'],
      ...(typeof row.reason === 'string' ? { reason: row.reason } : {}) });
  }
  return { strategy: 'CLOUD_PRIORITY', selected, attempts,
    ...(typeof source.omittedAttempts === 'number' && Number.isInteger(source.omittedAttempts) && source.omittedAttempts > 0 ? { omittedAttempts: source.omittedAttempts } : {}) };
}

export function auditDownloadChannel(detail: unknown): string {
  const row = object(detail);
  if (typeof row?.downloadSourceLabel === 'string') return row.downloadSourceLabel;
  return row?.source === 'open-api' ? '开放 API' : '';
}
