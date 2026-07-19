import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, type OutboundWebhook, type Prisma } from '@prisma/client';
import { createHmac } from 'node:crypto';

import { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../common/types/request-user.type';
import { safeFetch } from '../common/utils/ssrf-guard.util';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectAccessService } from '../projects/project-access.service';

export type CreateWebhookDto = {
  name: string;
  url: string;
  secret?: string | null;
  events: string[];
  projectId?: string | null;
  enabled?: boolean;
};

@Injectable()
export class WebhooksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projectAccessService: ProjectAccessService,
    private readonly auditService: AuditService,
  ) {}

  async list(user: RequestUser, projectId?: string) {
    if (projectId) {
      await this.projectAccessService.assertProjectAccess(user, projectId, true);
    }
    const rows = await this.prisma.outboundWebhook.findMany({
      where: projectId
        ? { OR: [{ projectId }, { projectId: null }] }
        : {},
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((row) => this.toResponse(row));
  }

  async create(dto: CreateWebhookDto, user: RequestUser) {
    this.assertPayload(dto);
    if (dto.projectId) {
      await this.projectAccessService.assertProjectAccess(user, dto.projectId, true);
    }
    const row = await this.prisma.outboundWebhook.create({
      data: {
        name: dto.name.trim(),
        url: dto.url.trim(),
        secret: dto.secret?.trim() || null,
        events: dto.events,
        projectId: dto.projectId || null,
        enabled: dto.enabled ?? true,
      },
    });
    await this.auditService.write({
      action: AuditAction.WEBHOOK_CREATE,
      actorId: user.id,
      projectId: row.projectId ?? undefined,
      detail: { webhookId: row.id, name: row.name, events: dto.events },
    });
    return this.toResponse(row);
  }

  async update(
    id: string,
    dto: Partial<CreateWebhookDto>,
    user: RequestUser,
  ) {
    const existing = await this.prisma.outboundWebhook.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('Webhook 不存在。');
    }
    if (existing.projectId) {
      await this.projectAccessService.assertProjectAccess(user, existing.projectId, true);
    }
    if (dto.projectId) {
      await this.projectAccessService.assertProjectAccess(user, dto.projectId, true);
    }
    if (dto.url || dto.events || dto.name) {
      this.assertPayload({
        name: dto.name ?? existing.name,
        url: dto.url ?? existing.url,
        events: dto.events ?? (existing.events as string[]),
      });
    }

    const row = await this.prisma.outboundWebhook.update({
      where: { id },
      data: {
        name: dto.name?.trim(),
        url: dto.url?.trim(),
        secret: dto.secret === undefined ? undefined : dto.secret?.trim() || null,
        events: dto.events,
        projectId: dto.projectId === undefined ? undefined : dto.projectId || null,
        enabled: dto.enabled,
      },
    });
    await this.auditService.write({
      action: AuditAction.WEBHOOK_UPDATE,
      actorId: user.id,
      projectId: row.projectId ?? undefined,
      detail: { webhookId: row.id },
    });
    return this.toResponse(row);
  }

  async remove(id: string, user: RequestUser) {
    const existing = await this.prisma.outboundWebhook.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('Webhook 不存在。');
    }
    if (existing.projectId) {
      await this.projectAccessService.assertProjectAccess(user, existing.projectId, true);
    }
    await this.prisma.outboundWebhook.delete({ where: { id } });
    await this.auditService.write({
      action: AuditAction.WEBHOOK_DELETE,
      actorId: user.id,
      projectId: existing.projectId ?? undefined,
      detail: { webhookId: id },
    });
    return { success: true };
  }

  async listDeliveries(id: string, user: RequestUser, page = 1, pageSize = 20) {
    const existing = await this.prisma.outboundWebhook.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('Webhook 不存在。');
    }
    if (existing.projectId) {
      await this.projectAccessService.assertProjectAccess(user, existing.projectId, true);
    }
    const take = Math.min(100, Math.max(1, pageSize));
    const skip = (Math.max(1, page) - 1) * take;
    const [items, total] = await this.prisma.$transaction([
      this.prisma.webhookDelivery.findMany({
        where: { webhookId: id },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      this.prisma.webhookDelivery.count({ where: { webhookId: id } }),
    ]);
    return { items, total, page: Math.max(1, page), pageSize: take };
  }

  async test(id: string, user: RequestUser) {
    const existing = await this.prisma.outboundWebhook.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('Webhook 不存在。');
    }
    if (existing.projectId) {
      await this.projectAccessService.assertProjectAccess(user, existing.projectId, true);
    }
    return this.deliver(existing, 'webhook.test', {
      message: 'UFM webhook test',
      at: new Date().toISOString(),
    });
  }

  async deliverForEvent(event: string, payload: Record<string, unknown>): Promise<void> {
    const projectId = typeof payload.projectId === 'string' ? payload.projectId : null;
    const hooks = await this.prisma.outboundWebhook.findMany({
      where: {
        enabled: true,
        OR: projectId
          ? [{ projectId }, { projectId: null }]
          : [{ projectId: null }],
      },
    });

    for (const hook of hooks) {
      const events = Array.isArray(hook.events) ? (hook.events as string[]) : [];
      if (!events.includes('*') && !events.includes(event)) {
        continue;
      }
      void this.deliver(hook, event, payload);
    }
  }

  private async deliver(
    hook: OutboundWebhook,
    event: string,
    payload: Record<string, unknown>,
  ): Promise<{ success: boolean; statusCode?: number; error?: string }> {
    const body = JSON.stringify({
      event,
      timestamp: new Date().toISOString(),
      data: payload,
    });
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'UFM-Webhook/1.0',
      'X-UFM-Event': event,
    };
    if (hook.secret) {
      const signature = createHmac('sha256', hook.secret).update(body).digest('hex');
      headers['X-UFM-Signature'] = `sha256=${signature}`;
    }

    let lastError = '';
    let statusCode: number | undefined;
    let success = false;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await safeFetch(hook.url, {
          method: 'POST',
          headers,
          body,
        });
        statusCode = response.status;
        if (response.ok) {
          success = true;
          break;
        }
        lastError = `HTTP ${response.status}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
      }
    }

    await this.prisma.webhookDelivery.create({
      data: {
        webhookId: hook.id,
        event,
        success,
        statusCode: statusCode ?? null,
        error: success ? null : lastError.slice(0, 512),
      },
    });

    await this.auditService.write({
      action: AuditAction.WEBHOOK_DELIVERY,
      projectId: hook.projectId ?? undefined,
      detail: {
        webhookId: hook.id,
        event,
        success,
        statusCode,
        error: success ? undefined : lastError,
      },
    });

    return { success, statusCode, error: success ? undefined : lastError };
  }

  private assertPayload(dto: { name: string; url: string; events: string[] }): void {
    if (!dto.name?.trim()) {
      throw new BadRequestException('名称不能为空。');
    }
    if (!dto.url?.trim() || !/^https?:\/\//i.test(dto.url.trim())) {
      throw new BadRequestException('URL 必须是 http/https 地址。');
    }
    if (!Array.isArray(dto.events) || dto.events.length === 0) {
      throw new BadRequestException('至少订阅一个事件。');
    }
  }

  private toResponse(row: OutboundWebhook) {
    return {
      id: row.id,
      projectId: row.projectId,
      name: row.name,
      url: row.url,
      hasSecret: Boolean(row.secret),
      events: row.events as Prisma.JsonValue,
      enabled: row.enabled,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
