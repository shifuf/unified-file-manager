export type PluginConfigValue = string | number | boolean | undefined;

export interface StoragePluginField {
  key: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'select';
  required?: boolean;
  secret?: boolean;
  url?: boolean;
  hidden?: boolean;
  immutable?: boolean;
  default?: string | number | boolean;
  description?: string;
  placeholder?: string;
  options?: Array<{ label: string; value: string }>;
}

export function buildPluginConfigValues(fields: StoragePluginField[], config: Record<string, unknown> = {}): Record<string, PluginConfigValue> {
  return Object.fromEntries(fields.map(field => {
    const value = config[field.key] ?? field.default;
    if (field.type === 'boolean') return [field.key, value === true || value === 'true'];
    if (field.type === 'number') return [field.key, value == null || value === '' ? undefined : Number(value)];
    return [field.key, String(value ?? '')];
  }));
}

export function collectPluginConfigValues(fields: StoragePluginField[], values: Record<string, PluginConfigValue>, allowMaskedSecrets: boolean): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (const field of fields) {
    let value = values[field.key];
    if (typeof value === 'string') value = value.trim();
    if (field.secret && value === '******') {
      if (allowMaskedSecrets) continue;
      throw new Error(`请填写：${field.label}。`);
    }
    if (value == null || value === '') {
      if (field.required) throw new Error(`请填写：${field.label}。`);
      if (field.type !== 'number') config[field.key] = value ?? '';
      continue;
    }
    if (field.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) throw new Error(`${field.label} 必须是有效数字。`);
    if (field.type === 'boolean' && typeof value !== 'boolean') throw new Error(`${field.label} 必须选择是或否。`);
    if (field.type === 'select' && !field.options?.some(option => option.value === value)) throw new Error(`${field.label} 的选项无效。`);
    if (field.url) {
      try {
        const raw = String(value);
        const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
      }
      catch { throw new Error(`${field.label} 必须是有效的 HTTP 或 HTTPS 地址。`); }
    }
    config[field.key] = value;
  }
  return config;
}
