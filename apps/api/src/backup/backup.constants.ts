/**
 * Insert order for restore (parents before children) — the reverse order is used
 * when a `replace` restore clears business data first.
 *
 * The internal `Backup` table is deliberately excluded so backups never contain
 * (or overwrite) other backups.
 */
export const BACKUP_MODELS = [
  'user',
  'project',
  'cdnConfig',
  'managedFolder',
  'managedFile',
  'fileDerivative',
  'fileVersion',
  'shareLink',
  'folderShareLink',
  'folderPublicPolicy',
  'projectSecret',
  'uploadCredential',
  'outboundWebhook',
  'webhookDelivery',
  'notification',
  'lifecyclePolicy',
  'task',
  'systemSetting',
  'shareIpStat',
  'openApiNonce',
  'refreshToken',
  'fileAccessDailyStat',
  'downloadRecord',
  'downloadDailyStat',
  'auditLog',
] as const;

export type BackupModelName = (typeof BACKUP_MODELS)[number];

/**
 * Tables cleared by a `replace` restore. Ordered so dependent rows go first and
 * the `Project` -> `CdnConfig` reference is dropped before the config itself.
 * Users, audit logs, analytics, notifications and backups are intentionally kept.
 */
export const REPLACE_DELETE_ORDER: readonly BackupModelName[] = [
  'webhookDelivery',
  'outboundWebhook',
  'lifecyclePolicy',
  'folderPublicPolicy',
  'folderShareLink',
  'shareLink',
  'fileVersion',
  'fileDerivative',
  'managedFile',
  'managedFolder',
  'uploadCredential',
  'projectSecret',
  'project',
  'cdnConfig',
];

export const BACKUP_FORMAT_VERSION = 1;
/**
 * Selectable data domains. A backup records the scopes it covers, and a restore
 * can target a subset of them ("备什么就恢复什么").
 */
export const BACKUP_SCOPES = {
  projects: {
    label: '项目与文件',
    description: '项目、目录、文件元数据、衍生文件与历史版本',
    models: ['project', 'managedFolder', 'managedFile', 'fileDerivative', 'fileVersion'],
  },
  storage: {
    label: '存储配置',
    description: '本地 / 七牛 / 又拍云 / OSS / S3 存储配置（密钥为加密密文）',
    models: ['cdnConfig'],
  },
  shares: {
    label: '分享与公开库',
    description: '文件分享、目录分享与目录公开策略',
    models: ['shareLink', 'folderShareLink', 'folderPublicPolicy'],
  },
  credentials: {
    label: '项目密钥与直传凭证',
    description: '开放 API 密钥与上传凭证',
    models: ['projectSecret', 'uploadCredential'],
  },
  automation: {
    label: '自动化',
    description: '出站 Webhook、投递记录、生命周期策略与任务',
    models: ['outboundWebhook', 'webhookDelivery', 'lifecyclePolicy', 'task'],
  },
  users: {
    label: '用户与登录会话',
    description: '管理员账号与刷新令牌',
    models: ['user', 'refreshToken'],
  },
  settings: {
    label: '系统设置',
    description: '控制台系统参数',
    models: ['systemSetting'],
  },
  security: {
    label: '审计与通知',
    description: '审计日志、站内通知与分享 IP 统计',
    models: ['auditLog', 'notification', 'shareIpStat'],
  },
  analytics: {
    label: '下载与访问统计',
    description: '下载明细、按日汇总与访问热点',
    models: ['downloadRecord', 'downloadDailyStat', 'fileAccessDailyStat'],
  },
  openapi: {
    label: '开放 API 防重放',
    description: '签名 nonce 记录（通常无需备份）',
    models: ['openApiNonce'],
  },
} as const satisfies Record<string, { label: string; description: string; models: readonly BackupModelName[] }>;

export type BackupScopeKey = keyof typeof BACKUP_SCOPES;

export const BACKUP_SCOPE_KEYS = Object.keys(BACKUP_SCOPES) as BackupScopeKey[];

export function isBackupScopeKey(value: string): value is BackupScopeKey {
  return Object.prototype.hasOwnProperty.call(BACKUP_SCOPES, value);
}

/** Models covered by a set of scopes (in canonical insert order). */
export function modelsForScopes(scopes: readonly BackupScopeKey[]): BackupModelName[] {
  const wanted = new Set<string>();
  for (const scope of scopes) {
    for (const model of BACKUP_SCOPES[scope].models) {
      wanted.add(model);
    }
  }
  return BACKUP_MODELS.filter((model) => wanted.has(model));
}