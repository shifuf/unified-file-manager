export const DOMAIN_EVENTS = {
  FILE_UPLOADED: 'file.uploaded',
  FILE_DELETED: 'file.deleted',
  FILE_RESTORED: 'file.restored',
  FILE_PURGED: 'file.purged',
  FILE_UPDATED: 'file.updated',
  FILE_PUBLISHED: 'file.published',
  FILE_UNPUBLISHED: 'file.unpublished',
  SHARE_DOWNLOADED: 'share.downloaded',
  SHARE_DOWNLOAD_RATE_LIMITED: 'share.download.rate_limited',
  QUOTA_EXCEEDED: 'quota.exceeded',
  CDN_HEALTH_FAIL: 'cdn.health.fail',
} as const;

export type DomainEventName = (typeof DOMAIN_EVENTS)[keyof typeof DOMAIN_EVENTS];

export interface DomainEventPayloadMap {
  [DOMAIN_EVENTS.FILE_UPLOADED]: {
    projectId: string;
    fileId: string;
    originalName: string;
    size: number;
    mimeType: string;
    category: string;
    folderPath?: string | null;
    actorId?: string | null;
  };
  [DOMAIN_EVENTS.FILE_DELETED]: {
    projectId: string;
    fileId: string;
    originalName: string;
    actorId?: string | null;
  };
  [DOMAIN_EVENTS.FILE_RESTORED]: {
    projectId: string;
    fileId: string;
    originalName: string;
    actorId?: string | null;
  };
  [DOMAIN_EVENTS.FILE_PURGED]: {
    projectId: string;
    fileId: string;
    originalName: string;
    actorId?: string | null;
  };
  [DOMAIN_EVENTS.FILE_UPDATED]: {
    projectId: string;
    fileId: string;
    originalName: string;
    actorId?: string | null;
  };
  [DOMAIN_EVENTS.FILE_PUBLISHED]: {
    projectId: string;
    fileId: string;
    originalName: string;
    actorId?: string | null;
  };
  [DOMAIN_EVENTS.FILE_UNPUBLISHED]: {
    projectId: string;
    fileId: string;
    originalName: string;
    actorId?: string | null;
  };
  [DOMAIN_EVENTS.SHARE_DOWNLOADED]: {
    projectId: string;
    fileId: string;
    shareId: string;
    originalName: string;
    ip?: string | null;
  };
  [DOMAIN_EVENTS.SHARE_DOWNLOAD_RATE_LIMITED]: {
    projectId?: string | null;
    fileId?: string | null;
    shareId?: string | null;
    originalName?: string | null;
    ip?: string | null;
    limit: number;
    windowSeconds: number;
    kind: 'file-share' | 'folder-share' | 'public';
  };
  [DOMAIN_EVENTS.QUOTA_EXCEEDED]: {
    projectId: string;
    projectName?: string;
    kind: 'bytes' | 'files';
    used: number;
    quota: number;
    actorId?: string | null;
  };
  [DOMAIN_EVENTS.CDN_HEALTH_FAIL]: {
    projectId?: string | null;
    cdnConfigId: string;
    name: string;
    message: string;
  };
}

export type DomainEventPayload<T extends DomainEventName> = DomainEventPayloadMap[T];
