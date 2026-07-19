import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DerivativeKind,
  DerivativeStatus,
  FileCategory,
  FileStatus,
  type CdnConfig,
  type ManagedFile,
} from '@prisma/client';
import sharp from 'sharp';

import { getConfigBoolean } from '../common/utils/security-config.util';
import { safeFetch } from '../common/utils/ssrf-guard.util';
import { DOMAIN_EVENTS } from '../events/domain-events';
import { EventBusService } from '../events/event-bus.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';

const THUMB_WIDTH = 320;
const THUMB_WEBP_QUALITY = 80;
const MAX_INPUT_PIXELS = 50_000_000;
const MAX_THUMB_SOURCE_BYTES = 100 * 1024 * 1024;
const MAX_CONCURRENT_THUMBS = 2;

@Injectable()
export class ImagePipelineService implements OnModuleInit {
  private readonly logger = new Logger(ImagePipelineService.name);
  private activeThumbs = 0;
  private readonly thumbQueue: Array<() => void> = [];

  constructor(
    private readonly configService: ConfigService,
    private readonly eventBus: EventBusService,
    private readonly prisma: PrismaService,
    private readonly storageService: StorageService,
  ) {}

  onModuleInit(): void {
    this.eventBus.on(DOMAIN_EVENTS.FILE_UPLOADED, (payload) => {
      void this.handleUploaded(payload.fileId, payload.category);
    });
  }

  private async handleUploaded(fileId: string, category: string): Promise<void> {
    if (category !== FileCategory.IMAGE && category !== 'IMAGE') {
      return;
    }

    try {
      await this.withThumbSlot(() => this.generateThumbnail(fileId));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Thumbnail pipeline failed for fileId=${fileId}: ${message}`);
      await this.prisma.fileDerivative
        .upsert({
          where: { fileId_kind: { fileId, kind: DerivativeKind.THUMB } },
          create: {
            fileId,
            kind: DerivativeKind.THUMB,
            storageKey: '',
            mimeType: 'image/webp',
            size: BigInt(0),
            status: DerivativeStatus.FAILED,
            error: message.slice(0, 512),
          },
          update: {
            status: DerivativeStatus.FAILED,
            error: message.slice(0, 512),
          },
        })
        .catch(() => undefined);
    }
  }

  private async withThumbSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.activeThumbs >= MAX_CONCURRENT_THUMBS) {
      await new Promise<void>((resolve) => {
        this.thumbQueue.push(resolve);
      });
    }
    this.activeThumbs += 1;
    try {
      return await fn();
    } finally {
      this.activeThumbs -= 1;
      const next = this.thumbQueue.shift();
      next?.();
    }
  }

  async generateThumbnail(fileId: string): Promise<void> {
    const file = await this.prisma.managedFile.findUnique({
      where: { id: fileId },
      include: { cdnConfig: true },
    });

    if (!file || file.status === FileStatus.DELETED || file.category !== FileCategory.IMAGE) {
      return;
    }

    if (Number(file.size) > MAX_THUMB_SOURCE_BYTES) {
      await this.prisma.fileDerivative.upsert({
        where: { fileId_kind: { fileId, kind: DerivativeKind.THUMB } },
        create: {
          fileId,
          kind: DerivativeKind.THUMB,
          storageKey: '',
          mimeType: 'image/webp',
          size: BigInt(0),
          status: DerivativeStatus.FAILED,
          error: `source exceeds max size ${MAX_THUMB_SOURCE_BYTES}`,
        },
        update: {
          status: DerivativeStatus.FAILED,
          error: `source exceeds max size ${MAX_THUMB_SOURCE_BYTES}`,
        },
      });
      return;
    }

    await this.prisma.fileDerivative.upsert({
      where: { fileId_kind: { fileId, kind: DerivativeKind.THUMB } },
      create: {
        fileId,
        kind: DerivativeKind.THUMB,
        storageKey: '',
        mimeType: 'image/webp',
        size: BigInt(0),
        status: DerivativeStatus.PENDING,
      },
      update: {
        status: DerivativeStatus.PENDING,
        error: null,
      },
    });

    const sourceBuffer = await this.readFileBuffer(file);
    const thumbBuffer = await sharp(sourceBuffer, {
      failOn: 'none',
      limitInputPixels: MAX_INPUT_PIXELS,
    })
      .rotate()
      .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
      .webp({ quality: THUMB_WEBP_QUALITY })
      .toBuffer();

    const storageKey = this.buildThumbKey(file.storageKey);
    const uploadResult = await this.storageService.upload(file.projectId, {
      key: storageKey,
      buffer: thumbBuffer,
      mimeType: 'image/webp',
      originalName: `${file.originalName}.thumb.webp`,
    });

    // Prefer CDN public URL; otherwise point at the public transform path that can
    // short-circuit to the stored THUMB object (cacheable + immutable).
    const thumbnailUrl =
      uploadResult.publicUrl ??
      `${this.storageService.buildPublicAccessUrl(file.id)}?w=${THUMB_WIDTH}&format=webp`;

    await this.prisma.$transaction([
      this.prisma.fileDerivative.upsert({
        where: { fileId_kind: { fileId, kind: DerivativeKind.THUMB } },
        create: {
          fileId,
          kind: DerivativeKind.THUMB,
          storageKey: uploadResult.storageKey,
          mimeType: 'image/webp',
          size: BigInt(thumbBuffer.length),
          status: DerivativeStatus.READY,
          publicUrl: uploadResult.publicUrl ?? null,
          meta: { width: THUMB_WIDTH, format: 'webp' },
        },
        update: {
          storageKey: uploadResult.storageKey,
          mimeType: 'image/webp',
          size: BigInt(thumbBuffer.length),
          status: DerivativeStatus.READY,
          publicUrl: uploadResult.publicUrl ?? null,
          meta: { width: THUMB_WIDTH, format: 'webp' },
          error: null,
        },
      }),
      this.prisma.managedFile.update({
        where: { id: fileId },
        data: { thumbnailUrl },
      }),
    ]);

    this.logger.debug(`Thumbnail ready for fileId=${fileId} key=${uploadResult.storageKey}`);
  }

  private async readFileBuffer(file: ManagedFile & { cdnConfig: CdnConfig | null }): Promise<Buffer> {
    if (Number(file.size) > MAX_THUMB_SOURCE_BYTES) {
      throw new Error(`Source exceeds max size ${MAX_THUMB_SOURCE_BYTES}`);
    }

    const target = await this.storageService.getDownloadTarget(file);
    if (target.type === 'stream' && target.stream) {
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of target.stream) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        total += buf.length;
        if (total > MAX_THUMB_SOURCE_BYTES) {
          throw new Error(`Source exceeds max size ${MAX_THUMB_SOURCE_BYTES}`);
        }
        chunks.push(buf);
      }
      return Buffer.concat(chunks);
    }

    if (target.type === 'redirect' && target.url) {
      const allowPrivate = getConfigBoolean(this.configService, 'STORAGE_ALLOW_PRIVATE_ENDPOINTS', false);
      const response = await safeFetch(
        target.url,
        {},
        {
          allowPrivate,
          maxRedirects: 3,
        },
      );
      if (!response.ok) {
        throw new Error(`Failed to fetch source image: HTTP ${response.status}`);
      }
      const contentLength = Number(response.headers.get('content-length') || 0);
      if (contentLength > MAX_THUMB_SOURCE_BYTES) {
        throw new Error(`Source exceeds max size ${MAX_THUMB_SOURCE_BYTES}`);
      }
      const arrayBuffer = await response.arrayBuffer();
      if (arrayBuffer.byteLength > MAX_THUMB_SOURCE_BYTES) {
        throw new Error(`Source exceeds max size ${MAX_THUMB_SOURCE_BYTES}`);
      }
      return Buffer.from(arrayBuffer);
    }

    throw new Error('No readable source for thumbnail generation.');
  }

  private buildThumbKey(storageKey: string): string {
    const lastSlash = storageKey.lastIndexOf('/');
    const dir = lastSlash >= 0 ? storageKey.slice(0, lastSlash + 1) : '';
    const base = lastSlash >= 0 ? storageKey.slice(lastSlash + 1) : storageKey;
    const withoutExt = base.replace(/\.[^.]+$/, '');
    return `${dir}thumbs/${withoutExt}-320.webp`;
  }
}
