import { BadRequestException } from '@nestjs/common';

export function purgeFileIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 1000
    || value.some(id => typeof id !== 'string' || !id.trim() || id.length > 128)) return [];
  return [...new Set(value as string[])];
}

export function purgeRetryFileIds(detail: Record<string, unknown>, result: Record<string, unknown>): string[] {
  const failureIds = (value: unknown): string[] => Array.isArray(value)
    ? purgeFileIds(value.map(failure => failure && typeof failure === 'object' && !Array.isArray(failure)
      ? (failure as Record<string, unknown>).fileId : undefined)) : [];
  const allIds = purgeFileIds(detail.fileIds);
  const failed = purgeFileIds(detail.failedFileIds);
  const failures = failureIds(detail.failures);
  const resultFailures = failureIds(result.failures);
  const knownFailures = failed.length ? failed : failures.length ? failures : resultFailures;
  // The synchronous original batch attempted its complete list. Durable workers
  // additionally record nextIndex, so a crash must retain the unattempted tail.
  const unfinished = Number.isSafeInteger(detail.nextIndex) && Number(detail.nextIndex) >= 0
    ? allIds.slice(Number(detail.nextIndex)) : [];
  const ids = [...new Set(knownFailures.length || unfinished.length ? [...knownFailures, ...unfinished] : allIds)];
  if (!ids.length) throw new BadRequestException('此旧任务缺少可执行的文件清单，请回到回收站重新选择文件并彻底删除。');
  return ids;
}
