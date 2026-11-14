import type { Response } from 'express';
import type { DownloadStorageSource, RuntimeCdnConfig } from './storage.types';

export function storageIdentity(config: Pick<RuntimeCdnConfig, 'id' | 'name' | 'provider'>) {
  return { configId: config.id, configName: config.name, provider: config.provider };
}

export function writeDownloadStorageHeader(response: Response, source?: DownloadStorageSource): void {
  if (!source) return;
  const attempts = source.attempts.slice();
  let omittedAttempts = 0;
  const encode = () => encodeURIComponent(JSON.stringify({ ...source, attempts,
    ...(omittedAttempts ? { omittedAttempts } : {}) }));
  let value = encode();
  // Leave room for normal headers in a 4KiB proxy header buffer. Always retain
  // the selected identity, even if verbose attempt details do not fit.
  while (value.length > 3072 && attempts.length) {
    const failed = attempts.map(attempt => attempt.outcome === 'SELECTED').lastIndexOf(false);
    attempts.splice(failed < 0 ? attempts.length - 1 : failed, 1);
    omittedAttempts++;
    value = encode();
  }
  response.setHeader('X-UFM-Download-Storage', value);
}

export function downloadStorageMessage(source?: DownloadStorageSource): string | undefined {
  if (!source) return undefined;
  const selected = source.selected;
  const failures = source.attempts.filter(item => item.outcome !== 'SELECTED')
    .map(item => `${item.configName}（${item.provider}）：${item.reason || '不可用'}`);
  return `下载存储：${selected.configName}（${selected.provider}）；按云存储优先级下载${failures.length ? `；切换原因：${failures.join('；')}` : selected.provider === 'LOCAL' ? '；无可用云副本，使用本地兜底' : ''}`;
}
