import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { FileCategory, FileStatus } from '@prisma/client';

import { DOMAIN_EVENTS } from '../events/domain-events';
import { EventBusService } from '../events/event-bus.service';
import { PrismaService } from '../prisma/prisma.service';
import { SearchService } from '../search/search.service';
import { StorageService } from '../storage/storage.service';

const MAX_TEXT_BYTES = 512 * 1024;
const MAX_CONCURRENT = 2;
const TEXT_MIME_PREFIXES = ['text/', 'application/json', 'application/xml', 'application/javascript'];
const CODE_EXTENSIONS = new Set([
  'js', 'ts', 'tsx', 'jsx', 'json', 'xml', 'html', 'css', 'scss', 'md', 'txt', 'yml', 'yaml', 'csv', 'log', 'sql', 'sh', 'py', 'go', 'java', 'c', 'cpp', 'h', 'rs',
]);

@Injectable()
export class ContentExtractService implements OnModuleInit {
  private readonly logger = new Logger(ContentExtractService.name);
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(
    private readonly eventBus: EventBusService,
    private readonly prisma: PrismaService,
    private readonly searchService: SearchService,
    private readonly storageService: StorageService,
  ) {}

  onModuleInit(): void {
    this.eventBus.on(DOMAIN_EVENTS.FILE_UPLOADED, (payload) => {
      void this.withSlot(() => this.extract(payload.fileId));
    });
  }

  private async withSlot<T>(fn: () => Promise<T>): Promise<T | void> {
    if (this.active >= MAX_CONCURRENT) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      const next = this.queue.shift();
      next?.();
    }
  }

  private async extract(fileId: string): Promise<void> {
    const file = await this.prisma.managedFile.findFirst({
      where: { id: fileId, status: FileStatus.ACTIVE },
      include: { cdnConfig: true },
    });
    if (!file) {
      return;
    }

    if (!this.shouldExtract(file.mimeType, file.extension, file.category)) {
      return;
    }

    try {
      const target = await this.storageService.getDownloadTarget(file);
      let buffer: Buffer | null = null;
      if (target.type === 'stream' && target.stream) {
        buffer = await this.readStreamLimited(target.stream, MAX_TEXT_BYTES);
      } else if (target.type === 'redirect' && target.url) {
        const response = await fetch(target.url);
        if (!response.ok) {
          return;
        }
        const arrayBuffer = await response.arrayBuffer();
        buffer = Buffer.from(arrayBuffer).subarray(0, MAX_TEXT_BYTES);
      }
      if (!buffer || buffer.length === 0) {
        return;
      }

      const text = buffer.toString('utf8').split(String.fromCharCode(0)).join('').trim();
      if (!text) {
        return;
      }

      await this.prisma.managedFile.update({
        where: { id: fileId },
        data: { contentText: text.slice(0, 200_000) },
      });
      await this.searchService.indexFileById(fileId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`content extract failed fileId=${fileId}: ${message}`);
    }
  }

  private shouldExtract(mimeType: string, extension: string, category: FileCategory): boolean {
    if (category === FileCategory.CODE || category === FileCategory.DOCUMENT) {
      if (CODE_EXTENSIONS.has(extension.toLowerCase()) || mimeType.startsWith('text/')) {
        return true;
      }
    }
    return TEXT_MIME_PREFIXES.some((prefix) => mimeType.startsWith(prefix)) || CODE_EXTENSIONS.has(extension.toLowerCase());
  }

  private async readStreamLimited(stream: NodeJS.ReadableStream, maxBytes: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remain = maxBytes - total;
      if (remain <= 0) {
        break;
      }
      chunks.push(buf.subarray(0, remain));
      total += Math.min(buf.length, remain);
      if (total >= maxBytes) {
        break;
      }
    }
    return Buffer.concat(chunks, total);
  }
}
