import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FileStatus, type ManagedFile } from '@prisma/client';

import { DOMAIN_EVENTS } from '../events/domain-events';
import { EventBusService } from '../events/event-bus.service';
import { PrismaService } from '../prisma/prisma.service';

const INDEX_UID = 'managed_files';

interface MeiliHit {
  id: string;
}

interface MeiliSearchResponse {
  hits?: MeiliHit[];
  estimatedTotalHits?: number;
  nbHits?: number;
}

@Injectable()
export class SearchService implements OnModuleInit {
  private readonly logger = new Logger(SearchService.name);
  private available: boolean | null = null;
  private ensuringIndex: Promise<void> | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly eventBus: EventBusService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.eventBus.on(DOMAIN_EVENTS.FILE_UPLOADED, (payload) => {
      void this.indexFileById(payload.fileId);
    });
    this.eventBus.on(DOMAIN_EVENTS.FILE_UPDATED, (payload) => {
      void this.indexFileById(payload.fileId);
    });
    this.eventBus.on(DOMAIN_EVENTS.FILE_RESTORED, (payload) => {
      void this.indexFileById(payload.fileId);
    });
    this.eventBus.on(DOMAIN_EVENTS.FILE_DELETED, (payload) => {
      void this.removeFile(payload.fileId);
    });
    this.eventBus.on(DOMAIN_EVENTS.FILE_PURGED, (payload) => {
      void this.removeFile(payload.fileId);
    });

    // Best-effort warm-up; failures are non-fatal.
    void this.ensureIndex().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Meilisearch init skipped: ${message}`);
    });
  }

  isConfigured(): boolean {
    return Boolean(this.configService.get<string>('MEILI_URL', '').trim());
  }

  async searchFileIds(
    projectId: string,
    query: string,
    options?: { limit?: number; offset?: number },
  ): Promise<{ ids: string[]; total: number } | null> {
    if (!this.isConfigured()) {
      return null;
    }

    try {
      await this.ensureIndex();
      const limit = Math.min(100, Math.max(1, options?.limit ?? 20));
      const offset = Math.max(0, options?.offset ?? 0);
      const response = await this.request<MeiliSearchResponse>(
        `/indexes/${INDEX_UID}/search`,
        {
          method: 'POST',
          body: JSON.stringify({
            q: query,
            filter: `projectId = "${projectId}" AND status = "ACTIVE"`,
            limit,
            offset,
            attributesToRetrieve: ['id'],
          }),
        },
      );

      if (!response) {
        return null;
      }

      const ids = (response.hits ?? []).map((hit) => hit.id).filter(Boolean);
      const total = response.estimatedTotalHits ?? response.nbHits ?? ids.length;
      return { ids, total };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Meilisearch search failed, falling back to SQL: ${message}`);
      this.available = false;
      return null;
    }
  }

  async indexFileById(fileId: string): Promise<void> {
    const file = await this.prisma.managedFile.findUnique({ where: { id: fileId } });
    if (!file) {
      return;
    }
    if (file.status !== FileStatus.ACTIVE) {
      await this.removeFile(fileId);
      return;
    }
    await this.indexFile(file);
  }

  async indexFile(file: ManagedFile): Promise<void> {
    if (!this.isConfigured()) {
      return;
    }

    try {
      await this.ensureIndex();
      const document = this.toDocument(file);
      const ok = await this.request(`/indexes/${INDEX_UID}/documents`, {
        method: 'POST',
        body: JSON.stringify([document]),
      });
      if (ok !== null) {
        await this.prisma.managedFile
          .update({ where: { id: file.id }, data: { indexedAt: new Date() } })
          .catch(() => undefined);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Meilisearch index failed for fileId=${file.id}: ${message}`);
      this.available = false;
    }
  }

  async removeFile(fileId: string): Promise<void> {
    if (!this.isConfigured()) {
      return;
    }

    try {
      await this.request(`/indexes/${INDEX_UID}/documents/${fileId}`, {
        method: 'DELETE',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Meilisearch delete failed for fileId=${fileId}: ${message}`);
      this.available = false;
    }
  }

  private toDocument(file: ManagedFile): Record<string, unknown> {
    return {
      id: file.id,
      projectId: file.projectId,
      originalName: file.originalName,
      mimeType: file.mimeType,
      extension: file.extension,
      category: file.category,
      status: file.status,
      remark: file.remark ?? '',
      tags: file.tags ?? '',
      folderPath: file.folderPath ?? '',
      contentText: file.contentText ?? '',
      size: Number(file.size),
      createdAt: file.createdAt.toISOString(),
      updatedAt: file.updatedAt.toISOString(),
    };
  }

  private async ensureIndex(): Promise<void> {
    if (!this.isConfigured()) {
      return;
    }
    if (this.available === true) {
      return;
    }
    if (this.ensuringIndex) {
      return this.ensuringIndex;
    }

    this.ensuringIndex = (async () => {
      // Create index if missing (Meili returns 404 when absent).
      const existing = await this.request(`/indexes/${INDEX_UID}`, { method: 'GET' }, true);
      if (!existing) {
        await this.request(`/indexes`, {
          method: 'POST',
          body: JSON.stringify({ uid: INDEX_UID, primaryKey: 'id' }),
        });
      }

      await this.request(`/indexes/${INDEX_UID}/settings`, {
        method: 'PATCH',
        body: JSON.stringify({
          searchableAttributes: ['originalName', 'remark', 'tags', 'extension', 'folderPath', 'contentText'],
          filterableAttributes: ['projectId', 'status', 'category', 'extension'],
          sortableAttributes: ['createdAt', 'updatedAt', 'size'],
        }),
      });

      this.available = true;
    })()
      .catch((error: unknown) => {
        this.available = false;
        throw error;
      })
      .finally(() => {
        this.ensuringIndex = null;
      });

    return this.ensuringIndex;
  }

  private async request<T = unknown>(
    path: string,
    init: RequestInit,
    allowNotFound = false,
  ): Promise<T | null> {
    const baseUrl = this.configService.get<string>('MEILI_URL', '').trim().replace(/\/+$/, '');
    if (!baseUrl) {
      return null;
    }

    const masterKey = this.configService.get<string>('MEILI_MASTER_KEY', '').trim();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(masterKey ? { Authorization: `Bearer ${masterKey}` } : {}),
    };

    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        ...headers,
        ...(init.headers as Record<string, string> | undefined),
      },
      signal: AbortSignal.timeout(8_000),
    });

    if (allowNotFound && response.status === 404) {
      return null;
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Meili HTTP ${response.status}: ${text.slice(0, 200)}`);
    }

    if (response.status === 204) {
      return {} as T;
    }

    const text = await response.text();
    if (!text) {
      return {} as T;
    }

    return JSON.parse(text) as T;
  }
}
