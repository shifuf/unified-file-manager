import type { StorageAdapter } from './types';

export const STORAGE_PLUGIN_API_VERSION = 1;
export interface StoragePluginField {
  key: string; label: string; type: 'string' | 'number' | 'boolean' | 'select';
  required?: boolean; secret?: boolean; url?: boolean; hidden?: boolean; immutable?: boolean; default?: string | number | boolean;
  placeholder?: string; description?: string; options?: Array<{ label: string; value: string }>;
}
export interface StoragePluginManifest {
  id: string; name: string; version: string; apiVersion: 1; entry: string; description?: string;
  fields: StoragePluginField[]; capabilities: { directUpload: boolean; usage: boolean; authentication?: boolean; backupOnly?: boolean; remoteFiles?: boolean };
}
const forbiddenKeys = new Set(['__proto__', 'constructor', 'prototype']);
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function fail(message: string): never { throw new Error(`存储插件：${message}`); }

export function validateManifest(input: unknown): StoragePluginManifest {
  if (!record(input)) fail('manifest 必须是对象');
  if (typeof input.id !== 'string' || !/^[A-Z][A-Z0-9_]{1,63}$/.test(input.id) || input.id === 'LOCAL') fail('id 无效或保留');
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 128) fail('name 无效');
  if (typeof input.version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(input.version)) fail('version 必须为 x.y.z');
  if (input.apiVersion !== STORAGE_PLUGIN_API_VERSION) fail('apiVersion 不兼容');
  if (input.entry !== 'index.cjs') fail('entry 必须为 index.cjs');
  if (input.description !== undefined && (typeof input.description !== 'string' || input.description.length > 2000)) fail('description 无效');
  if (!record(input.capabilities) || typeof input.capabilities.directUpload !== 'boolean' || typeof input.capabilities.usage !== 'boolean') fail('capabilities 无效');
  if (input.capabilities.authentication !== undefined && typeof input.capabilities.authentication !== 'boolean') fail('authentication 无效');
  if (input.capabilities.backupOnly !== undefined && typeof input.capabilities.backupOnly !== 'boolean') fail('backupOnly 无效');
  if (input.capabilities.remoteFiles !== undefined && typeof input.capabilities.remoteFiles !== 'boolean') fail('remoteFiles 无效');
  if (!Array.isArray(input.fields) || input.fields.length > 100) fail('fields 无效');
  const keys = new Set<string>();
  for (const f of input.fields) {
    if (!record(f) || typeof f.key !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(f.key) || forbiddenKeys.has(f.key) || keys.has(f.key)) fail('字段 key 重复或无效');
    keys.add(f.key);
    if (typeof f.label !== 'string' || !f.label.trim() || f.label.length > 128) fail(`字段 ${f.key} label 无效`);
    if (!['string', 'number', 'boolean', 'select'].includes(String(f.type))) fail(`字段 ${f.key} type 无效`);
    for (const flag of ['required', 'secret', 'url', 'hidden', 'immutable']) if (f[flag] !== undefined && typeof f[flag] !== 'boolean') fail(`字段 ${f.key} ${flag} 无效`);
    if ((f.secret || f.url) && f.type !== 'string') fail(`字段 ${f.key} secret/url 仅支持 string`);
    for (const text of ['description', 'placeholder']) if (f[text] !== undefined && typeof f[text] !== 'string') fail(`字段 ${f.key} ${text} 无效`);
    if (f.type === 'select') {
      if (!Array.isArray(f.options) || !f.options.length || f.options.length > 100) fail(`字段 ${f.key} 缺少选项`);
      const values = new Set<string>();
      for (const o of f.options) {
        if (!record(o) || typeof o.label !== 'string' || !o.label || typeof o.value !== 'string' || values.has(o.value)) fail(`字段 ${f.key} 选项无效`);
        values.add(o.value);
      }
    }
    if (f.default !== undefined) validateValue(f as unknown as StoragePluginField, f.default);
  }
  return structuredClone(input) as unknown as StoragePluginManifest;
}

function validateValue(field: StoragePluginField, value: unknown): void {
  const type = field.type === 'select' ? 'string' : field.type;
  if (typeof value !== type || (type === 'number' && !Number.isFinite(value))) fail(`字段 ${field.key} 类型应为 ${type}`);
  if (field.type === 'select' && !field.options?.some((o) => o.value === value)) fail(`字段 ${field.key} 选项无效`);
  if (field.url && value) {
    let url: URL;
    try { url = new URL(String(value).includes('://') ? String(value) : `https://${value}`); } catch { fail(`字段 ${field.key} URL 无效`); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail(`字段 ${field.key} URL 无效`);
  }
}

export function validateConfig(manifest: StoragePluginManifest, input: unknown): Record<string, unknown> {
  if (!record(input)) fail('配置必须是对象');
  const result = { ...input };
  for (const field of manifest.fields) {
    let value = result[field.key];
    // The pre-plugin configuration form stored boolean inputs as strings.
    if (field.type === 'boolean' && typeof value === 'string' && /^(true|false)$/i.test(value.trim())) {
      value = value.trim().toLowerCase() === 'true'; result[field.key] = value;
    }
    if (value === undefined || value === null || value === '') {
      if (field.default !== undefined) { value = field.default; result[field.key] = value; }
      else if (field.required) fail(`缺少必填字段 ${field.key}`);
      else continue;
    }
    if (field.required && typeof value === 'string' && !value.trim()) fail(`缺少必填字段 ${field.key}`);
    validateValue(field, value);
  }
  return result;
}

export function validateAdapter(manifest: StoragePluginManifest, adapter: unknown): StorageAdapter {
  if (!record(adapter) || adapter.provider !== manifest.id) fail('适配器 provider 与 manifest 不一致');
  for (const method of ['upload', 'uploadFile', 'remove', 'getDownloadUrl', 'objectExists']) if (typeof adapter[method] !== 'function') fail(`适配器缺少 ${method}`);
  if (manifest.capabilities.backupOnly && typeof adapter.verifyBackup !== 'function') fail('备份适配器缺少 verifyBackup');
  if (manifest.capabilities.remoteFiles) for (const method of ['listRemoteFiles', 'readRemoteFile']) {
    if (typeof adapter[method] !== 'function') fail(`云端文件适配器缺少 ${method}`);
  }
  if (manifest.capabilities.authentication) for (const method of ['startLogin', 'pollLogin', 'cancelLogin', 'accountStatus', 'disconnectAccount']) {
    if (typeof adapter[method] !== 'function') fail(`认证适配器缺少 ${method}`);
  }
  for (const [capability, method] of [['directUpload', 'createDirectUpload'], ['usage', 'getUsage']] as const) {
    if (manifest.capabilities[capability] !== (typeof adapter[method] === 'function')) fail(`能力 ${capability} 与适配器不一致`);
  }
  return adapter as unknown as StorageAdapter;
}
