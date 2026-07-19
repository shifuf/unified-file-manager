import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditAction } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { decryptText, encryptText } from '../common/utils/crypto.util';
import { getAppCryptoKey } from '../common/utils/security-config.util';
import { safeFetch, UnsafeOutboundUrlError } from '../common/utils/ssrf-guard.util';
import {
  DOMAIN_EVENTS,
  type DomainEventName,
  type DomainEventPayload,
  type DomainEventPayloadMap,
} from '../events/domain-events';
import { EventBusService } from '../events/event-bus.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  ALL_NOTIFY_EVENTS,
  DEFAULT_NOTIFY_EVENTS,
  type NotifyDispatchResult,
  type NotifySettings,
} from './notify.types';

const SETTING_BASE_URL = 'notify.baseUrl';
const SETTING_API_KEY = 'notify.apiKey';
const SETTING_ENABLED = 'notify.enabled';
const SETTING_EVENTS = 'notify.events';

interface NotifyConfig {
  enabled: boolean;
  baseUrl: string;
  apiKey: string | null;
  events: Set<DomainEventName>;
}

@Injectable()
export class NotifyService implements OnModuleInit {
  private readonly logger = new Logger(NotifyService.name);
  /** Simple in-process aggregation: event+project within window collapses. */
  private readonly recentKeys = new Map<string, number>();
  private readonly aggregateWindowMs = 60_000;

  constructor(
    private readonly auditService: AuditService,
    private readonly configService: ConfigService,
    private readonly eventBus: EventBusService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    for (const event of ALL_NOTIFY_EVENTS) {
      this.eventBus.on(event, (payload) => {
        void this.handleDomainEvent(event, payload as DomainEventPayloadMap[typeof event]);
      });
    }
  }

  async getPublicSettings(): Promise<NotifySettings> {
    const config = await this.loadConfig();
    return {
      enabled: config.enabled,
      baseUrl: config.baseUrl,
      apiKeyConfigured: Boolean(config.apiKey),
      events: [...config.events],
    };
  }

  async updateSettings(input: {
    enabled?: boolean;
    baseUrl?: string;
    apiKey?: string;
    clearApiKey?: boolean;
    events?: string[];
    actorId?: string;
  }): Promise<NotifySettings> {
    if (input.enabled !== undefined) {
      await this.upsertSetting(SETTING_ENABLED, Boolean(input.enabled));
    }

    if (input.baseUrl !== undefined) {
      const baseUrl = input.baseUrl.trim().replace(/\/+$/, '');
      if (baseUrl) {
        if (!/^https?:\/\//i.test(baseUrl)) {
          throw new BadRequestException('消息通知地址必须以 http:// 或 https:// 开头。');
        }
        // Fail closed: URL must be safe under current SSRF policy before we store it.
        // Private targets only when NOTIFY_ALLOW_PRIVATE / STORAGE_ALLOW_PRIVATE_ENDPOINTS is on.
        const allowPrivate = this.allowPrivateNotifyTargets();
        const requireHttps = this.configService.get<string>('NODE_ENV') === 'production';
        try {
          await safeFetch(
            new URL('/api/health', ensureHttpUrl(baseUrl)).toString(),
            { method: 'GET' },
            { allowPrivate, requireHttps },
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new BadRequestException(`消息通知地址不可达或不安全：${message}`);
        }
      }
      await this.upsertSetting(SETTING_BASE_URL, baseUrl);
    }

    if (input.clearApiKey) {
      await this.prisma.systemSetting.deleteMany({ where: { key: SETTING_API_KEY } });
    } else if (input.apiKey !== undefined && input.apiKey.trim()) {
      const vault = encryptText(input.apiKey.trim(), getAppCryptoKey(this.configService));
      await this.upsertSetting(SETTING_API_KEY, vault);
    }

    if (input.events !== undefined) {
      const events = input.events.filter((event): event is DomainEventName =>
        (ALL_NOTIFY_EVENTS as string[]).includes(event),
      );
      await this.upsertSetting(SETTING_EVENTS, events);
    }

    await this.auditService.write({
      action: AuditAction.SETTING_UPDATE,
      actorId: input.actorId,
      detail: { key: 'notify.*' },
    });

    return this.getPublicSettings();
  }

  async test(actorId?: string): Promise<NotifyDispatchResult> {
    const result = await this.dispatch({
      title: '【统一文件管理】通知测试',
      content: `这是一条来自统一文件管理系统的测试消息。\n时间：${new Date().toISOString()}`,
      extra: { event: 'notify.test', source: 'ufm' },
      force: true,
    });

    await this.auditService.write({
      action: AuditAction.NOTIFY_TEST,
      actorId,
      detail: { success: result.success, reason: result.reason, statusCode: result.statusCode },
    });

    return result;
  }

  async handleDomainEvent<T extends DomainEventName>(
    event: T,
    payload: DomainEventPayload<T>,
  ): Promise<void> {
    const projectId =
      payload && typeof payload === 'object' && 'projectId' in payload
        ? (payload as { projectId?: string | null }).projectId
        : null;

    if (projectId) {
      const project = await this.prisma.project.findFirst({
        where: { id: projectId, deletedAt: null },
        select: { notifyEnabled: true, name: true },
      });
      if (project && !project.notifyEnabled) {
        return;
      }
    }

    const config = await this.loadConfig();
    if (!config.enabled || !config.events.has(event)) {
      return;
    }

    // Rate-limit alerts: aggregate per IP so different attackers still notify, but one IP doesn't spam.
    const ipKey =
      event === DOMAIN_EVENTS.SHARE_DOWNLOAD_RATE_LIMITED &&
      payload &&
      typeof payload === 'object' &&
      'ip' in payload
        ? String((payload as { ip?: string | null }).ip || 'unknown')
        : '';
    const aggregateKey = ipKey
      ? `${event}:ip:${ipKey}`
      : `${event}:${projectId ?? 'system'}`;
    if (this.shouldAggregate(aggregateKey)) {
      return;
    }

    const message = this.buildMessage(event, payload);
    await this.dispatch({
      ...message,
      projectId: projectId ?? undefined,
    });
  }

  async dispatch(params: {
    title: string;
    content: string;
    extra?: Record<string, unknown>;
    projectId?: string;
    force?: boolean;
  }): Promise<NotifyDispatchResult> {
    const config = await this.loadConfig();
    if (!params.force && !config.enabled) {
      return { success: false, skipped: true, reason: '通知未启用' };
    }
    if (!config.baseUrl) {
      return { success: false, skipped: true, reason: '未配置消息通知地址' };
    }
    if (!config.apiKey) {
      return { success: false, skipped: true, reason: '未配置消息通知 API Key' };
    }

    const url = new URL('/api/webhook', ensureHttpUrl(config.baseUrl)).toString();

    try {
      const allowPrivate = this.allowPrivateNotifyTargets();
      const requireHttps = this.configService.get<string>('NODE_ENV') === 'production';
      const response = await safeFetch(
        url,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            title: params.title,
            content: params.content,
            extra: {
              source: 'unified-file-manager',
              projectId: params.projectId,
              ...params.extra,
            },
          }),
        },
        { allowPrivate, requireHttps },
      );

      const text = await response.text();
      let messageId: string | undefined;
      try {
        const json = JSON.parse(text) as { data?: { messageId?: string } };
        messageId = json.data?.messageId;
      } catch {
        // Response body is optional; keep messageId only when JSON parses cleanly.
      }

      if (!response.ok) {
        this.logger.warn(`Notify dispatch failed HTTP ${response.status}: ${text.slice(0, 300)}`);
        return {
          success: false,
          statusCode: response.status,
          reason: text.slice(0, 300) || `HTTP ${response.status}`,
          messageId,
        };
      }

      await this.auditService.write({
        action: AuditAction.NOTIFY_SEND,
        projectId: params.projectId,
        detail: { title: params.title, messageId, statusCode: response.status },
      });

      return { success: true, statusCode: response.status, messageId };
    } catch (error) {
      const message =
        error instanceof UnsafeOutboundUrlError
          ? error.message
          : error instanceof Error
            ? error.message
            : String(error);
      this.logger.warn(`Notify dispatch error: ${message}`);
      return { success: false, reason: message };
    }
  }

  private buildMessage<T extends DomainEventName>(
    event: T,
    payload: DomainEventPayload<T>,
  ): { title: string; content: string; extra: Record<string, unknown> } {
    const p = payload as Record<string, unknown>;
    switch (event) {
      case DOMAIN_EVENTS.FILE_UPLOADED:
        return {
          title: '【统一文件管理】文件已上传',
          content: `文件 ${String(p.originalName)}（${formatBytes(Number(p.size) || 0)}）已上传。`,
          extra: { event, ...p },
        };
      case DOMAIN_EVENTS.FILE_DELETED:
        return {
          title: '【统一文件管理】文件已删除',
          content: `文件 ${String(p.originalName)} 已移入回收站。`,
          extra: { event, ...p },
        };
      case DOMAIN_EVENTS.SHARE_DOWNLOADED:
        return {
          title: '【统一文件管理】分享被下载',
          content: `分享文件 ${String(p.originalName)} 被下载。IP：${String(p.ip ?? '-')}`,
          extra: { event, ...p },
        };
      case DOMAIN_EVENTS.SHARE_DOWNLOAD_RATE_LIMITED: {
        const ip = String(p.ip ?? '未知 IP');
        const name = String(p.originalName ?? '分享文件');
        const limit = Number(p.limit) || 5;
        const windowSeconds = Number(p.windowSeconds) || 60;
        return {
          title: '【统一文件管理】分享下载触发防刷限流',
          content: `IP ${ip} 在 ${windowSeconds} 秒内下载「${name}」超过 ${limit} 次，已临时限制访问约 10 分钟。请在后台「IP 防刷」查看并处理。`,
          extra: { event, ...p },
        };
      }
      case DOMAIN_EVENTS.QUOTA_EXCEEDED:
        return {
          title: '【统一文件管理】项目配额超限',
          content: `项目 ${String(p.projectName ?? p.projectId)} ${String(p.kind)} 配额超限：已用 ${String(p.used)} / 上限 ${String(p.quota)}。`,
          extra: { event, ...p },
        };
      case DOMAIN_EVENTS.CDN_HEALTH_FAIL:
        return {
          title: '【统一文件管理】存储健康检查失败',
          content: `存储配置 ${String(p.name)} 检查失败：${String(p.message)}`,
          extra: { event, ...p },
        };
      default:
        return {
          title: `【统一文件管理】${event}`,
          content: JSON.stringify(p),
          extra: { event, ...p },
        };
    }
  }

  private shouldAggregate(key: string): boolean {
    const now = Date.now();
    const last = this.recentKeys.get(key);
    if (last && now - last < this.aggregateWindowMs) {
      return true;
    }
    this.recentKeys.set(key, now);
    // opportunistic cleanup
    if (this.recentKeys.size > 500) {
      for (const [k, ts] of this.recentKeys) {
        if (now - ts > this.aggregateWindowMs) {
          this.recentKeys.delete(k);
        }
      }
    }
    return false;
  }

  private async loadConfig(): Promise<NotifyConfig> {
    const rows = await this.prisma.systemSetting.findMany({
      where: {
        key: { in: [SETTING_BASE_URL, SETTING_API_KEY, SETTING_ENABLED, SETTING_EVENTS] },
      },
    });
    const map = new Map(rows.map((row) => [row.key, row.value]));

    const envBase = this.configService.get<string>('MSG_NOTIFY_BASE_URL', '').trim();
    const envKey = this.configService.get<string>('MSG_NOTIFY_API_KEY', '').trim();

    const baseUrlRaw = typeof map.get(SETTING_BASE_URL) === 'string' ? String(map.get(SETTING_BASE_URL)) : envBase;
    const enabledValue = map.get(SETTING_ENABLED);
    const enabled =
      typeof enabledValue === 'boolean'
        ? enabledValue
        : Boolean(baseUrlRaw && (map.has(SETTING_API_KEY) || envKey));

    let apiKey: string | null = null;
    const vault = map.get(SETTING_API_KEY);
    if (typeof vault === 'string' && vault) {
      try {
        apiKey = decryptText(vault, getAppCryptoKey(this.configService));
      } catch {
        this.logger.warn('Failed to decrypt notify.apiKey vault');
      }
    } else if (envKey) {
      apiKey = envKey;
    }

    const eventsValue = map.get(SETTING_EVENTS);
    const eventsList = Array.isArray(eventsValue)
      ? eventsValue.filter((item): item is DomainEventName => (ALL_NOTIFY_EVENTS as string[]).includes(String(item)))
      : DEFAULT_NOTIFY_EVENTS;

    return {
      enabled,
      baseUrl: baseUrlRaw.replace(/\/+$/, ''),
      apiKey,
      events: new Set(eventsList),
    };
  }

  private async upsertSetting(key: string, value: unknown): Promise<void> {
    await this.prisma.systemSetting.upsert({
      where: { key },
      update: { value: value as object },
      create: { key, value: value as object },
    });
  }

  /** Private/internal notify targets only when explicitly allowed (self-hosted msg platform). */
  private allowPrivateNotifyTargets(): boolean {
    const raw =
      this.configService.get<string>('NOTIFY_ALLOW_PRIVATE') ??
      this.configService.get<string>('STORAGE_ALLOW_PRIVATE_ENDPOINTS') ??
      '';
    const normalized = String(raw).trim().toLowerCase();
    return ['true', '1', 'yes', 'on'].includes(normalized);
  }
}

function ensureHttpUrl(value: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
