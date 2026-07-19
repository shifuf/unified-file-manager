import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { UserRole } from '@prisma/client';

import { DOMAIN_EVENTS, type DomainEventName } from '../events/domain-events';
import { EventBusService } from '../events/event-bus.service';
import { PrismaService } from '../prisma/prisma.service';

const HIGH_SIGNAL: DomainEventName[] = [
  DOMAIN_EVENTS.QUOTA_EXCEEDED,
  DOMAIN_EVENTS.CDN_HEALTH_FAIL,
  DOMAIN_EVENTS.SHARE_DOWNLOAD_RATE_LIMITED,
];

@Injectable()
export class NotificationsService implements OnModuleInit {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly eventBus: EventBusService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    for (const event of HIGH_SIGNAL) {
      this.eventBus.on(event, (payload) => {
        void this.fanOut(event, payload as unknown as Record<string, unknown>).catch((error) => {
          this.logger.warn(`notification fan-out failed: ${error instanceof Error ? error.message : error}`);
        });
      });
    }
  }

  async list(userId: string, options?: { unreadOnly?: boolean; page?: number; pageSize?: number }) {
    const page = Math.max(1, Number(options?.page ?? 1) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(options?.pageSize ?? 20) || 20));
    const where = {
      userId,
      ...(options?.unreadOnly ? { readAt: null } : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.notification.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }

  async unreadCount(userId: string): Promise<{ count: number }> {
    const count = await this.prisma.notification.count({
      where: { userId, readAt: null },
    });
    return { count };
  }

  async markRead(userId: string, dto: { ids?: string[]; all?: boolean }) {
    if (dto.all) {
      await this.prisma.notification.updateMany({
        where: { userId, readAt: null },
        data: { readAt: new Date() },
      });
      return { success: true };
    }
    const ids = dto.ids ?? [];
    if (ids.length === 0) {
      return { success: true };
    }
    await this.prisma.notification.updateMany({
      where: { userId, id: { in: ids } },
      data: { readAt: new Date() },
    });
    return { success: true };
  }

  private async fanOut(event: string, payload: Record<string, unknown>): Promise<void> {
    const projectId = typeof payload.projectId === 'string' ? payload.projectId : null;
    const title = this.titleFor(event, payload);
    const body = this.bodyFor(event, payload);
    const href =
      event === DOMAIN_EVENTS.SHARE_DOWNLOAD_RATE_LIMITED
        ? '/share-ip-abuse'
        : projectId
          ? `/projects/${projectId}`
          : '/dashboard';

    // Single super-admin product: only enabled SUPER_ADMIN accounts receive in-app alerts.
    const recipients = new Set<string>();
    const superAdmins = await this.prisma.user.findMany({
      where: { role: UserRole.SUPER_ADMIN, enabled: true },
      select: { id: true },
    });
    for (const user of superAdmins) {
      recipients.add(user.id);
    }

    if (recipients.size === 0) {
      return;
    }

    await this.prisma.notification.createMany({
      data: [...recipients].map((userId) => ({
        userId,
        title,
        body,
        level: event.includes('error') || event.includes('fail') ? 'error' : 'warning',
        href,
        meta: payload as object,
      })),
    });
  }

  private titleFor(event: string, payload: Record<string, unknown>): string {
    switch (event) {
      case DOMAIN_EVENTS.QUOTA_EXCEEDED:
        return '项目配额超限';
      case DOMAIN_EVENTS.CDN_HEALTH_FAIL:
        return '存储健康检查失败';
      case DOMAIN_EVENTS.SHARE_DOWNLOAD_RATE_LIMITED:
        return '分享下载触发防刷限制';
      default:
        return event;
    }
  }

  private bodyFor(event: string, payload: Record<string, unknown>): string {
    if (event === DOMAIN_EVENTS.SHARE_DOWNLOAD_RATE_LIMITED) {
      const ip = typeof payload.ip === 'string' ? payload.ip : '未知 IP';
      const name = typeof payload.originalName === 'string' ? payload.originalName : '分享文件';
      const limit = typeof payload.limit === 'number' ? payload.limit : 5;
      const windowSeconds = typeof payload.windowSeconds === 'number' ? payload.windowSeconds : 60;
      return `IP ${ip} 在 ${windowSeconds} 秒内下载「${name}」超过 ${limit} 次，已临时限制访问。`;
    }
    return JSON.stringify(payload).slice(0, 1000);
  }
}
