import { DOMAIN_EVENTS, type DomainEventName } from '../events/domain-events';

export const DEFAULT_NOTIFY_EVENTS: DomainEventName[] = [
  DOMAIN_EVENTS.QUOTA_EXCEEDED,
  DOMAIN_EVENTS.CDN_HEALTH_FAIL,
  DOMAIN_EVENTS.SHARE_DOWNLOAD_RATE_LIMITED,
];

export const ALL_NOTIFY_EVENTS: DomainEventName[] = [
  DOMAIN_EVENTS.FILE_UPLOADED,
  DOMAIN_EVENTS.FILE_DELETED,
  DOMAIN_EVENTS.SHARE_DOWNLOADED,
  DOMAIN_EVENTS.SHARE_DOWNLOAD_RATE_LIMITED,
  DOMAIN_EVENTS.QUOTA_EXCEEDED,
  DOMAIN_EVENTS.CDN_HEALTH_FAIL,
];

export interface NotifySettings {
  enabled: boolean;
  baseUrl: string;
  apiKeyConfigured: boolean;
  events: DomainEventName[];
  /** Only present when writing a new key; never returned from list(). */
  apiKey?: string;
}

export interface NotifyDispatchResult {
  success: boolean;
  skipped?: boolean;
  reason?: string;
  statusCode?: number;
  messageId?: string;
}
