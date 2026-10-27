import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { BACKUP_FORMAT_VERSION, BACKUP_MODELS, isBackupScopeKey, modelsForScopes } from './backup.constants';
import type { BACKUP_SCOPE_KEYS } from './backup.constants';

export const MAX_BACKUP_EXPANDED_BYTES = 1024 * 1024 * 1024;

export function decompressBackupBuffer(buffer: Buffer, maxOutputBytes = MAX_BACKUP_EXPANDED_BYTES): Buffer {
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new RangeError('maxOutputBytes must be a positive safe integer');
  }
  try {
    return gunzipSync(buffer, { maxOutputLength: maxOutputBytes });
  } catch (error) {
    if (error instanceof Error && /larger than|output length|larger than the maximum/i.test(error.message)) {
      throw new Error(`备份解压后超过 ${maxOutputBytes} 字节上限。`);
    }
    throw error;
  }
}

export function validateBackupPayload(candidate: unknown): {
  formatVersion: number;
  createdAt: string;
  scopes: string[];
  tables: Record<string, Array<Record<string, unknown>>>;
  objects: Array<{ cdnConfigId: string; storageKey: string; mimeType: string; originalName: string; size: number; data: string }>;
  warnings: string[];
} {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error('备份文件格式不正确。');
  const value = candidate as Record<string, unknown>;
  if (Number(value.formatVersion) !== BACKUP_FORMAT_VERSION) throw new Error(`不支持的备份版本：${String(value.formatVersion)}`);
  if (typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) throw new Error('备份创建时间格式不正确。');
  if (!Array.isArray(value.scopes) || !value.scopes.every((scope) => typeof scope === 'string' && isBackupScopeKey(scope))) {
    throw new Error('备份范围格式不正确。');
  }
  const scopes = [...new Set(value.scopes as string[])];
  const allowedModels = new Set(modelsForScopes(scopes as (typeof BACKUP_SCOPE_KEYS)[number][]));
  if (!value.tables || typeof value.tables !== 'object' || Array.isArray(value.tables)) throw new Error('备份表数据格式不正确。');
  const tables: Record<string, Array<Record<string, unknown>>> = {};
  for (const [model, rows] of Object.entries(value.tables as Record<string, unknown>)) {
    if (!(BACKUP_MODELS as readonly string[]).includes(model) || !allowedModels.has(model as (typeof BACKUP_MODELS)[number])) {
      throw new Error(`备份包含未声明的表：${model}`);
    }
    if (!Array.isArray(rows) || rows.some((row) => !row || typeof row !== 'object' || Array.isArray(row))) {
      throw new Error(`备份表数据格式错误：${model}`);
    }
    tables[model] = rows as Array<Record<string, unknown>>;
  }
  if (!Array.isArray(value.objects)) throw new Error('备份对象列表格式不正确。');
  const objects = value.objects.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`备份对象格式错误：${index}`);
    const object = entry as Record<string, unknown>;
    const { cdnConfigId, storageKey, mimeType, originalName, size, data } = object;
    if (typeof cdnConfigId !== 'string' || typeof storageKey !== 'string' || typeof mimeType !== 'string' || typeof originalName !== 'string') {
      throw new Error(`备份对象元数据格式错误：${index}`);
    }
    if (!storageKey || storageKey.startsWith('/') || storageKey.startsWith('\\') || storageKey.split(/[\\/]/).some((part) => part === '.' || part === '..')) {
      throw new Error(`备份对象路径不安全：${index}`);
    }
    if (!Number.isSafeInteger(size) || Number(size) < 0 || typeof data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
      throw new Error(`备份对象内容格式错误：${index}`);
    }
    const decoded = Buffer.from(data, 'base64');
    if (decoded.byteLength !== size || decoded.toString('base64') !== data) throw new Error(`备份对象大小或编码不匹配：${index}`);
    return { cdnConfigId, storageKey, mimeType, originalName, size: Number(size), data };
  });
  const warnings = value.warnings === undefined ? [] : value.warnings;
  if (!Array.isArray(warnings) || !warnings.every((warning) => typeof warning === 'string')) throw new Error('备份警告列表格式不正确。');
  return {
    formatVersion: BACKUP_FORMAT_VERSION,
    createdAt: value.createdAt as string,
    scopes,
    tables,
    objects,
    warnings,
  };
}

export function verifyBackupChecksum(buffer: Buffer, expected: string | null | undefined): boolean {
  if (!expected || !/^[a-f0-9]{64}$/i.test(expected)) return false;
  const actual = createHash('sha256').update(buffer).digest('hex');
  return actual.toLowerCase() === expected.toLowerCase();
}

