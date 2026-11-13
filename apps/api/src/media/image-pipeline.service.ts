import { createHash } from 'node:crypto';

import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DerivativeKind,
  DerivativeStatus,
  FileCategory,
  FileStatus,
  type CdnConfig,
  type ManagedFile,
  type Prisma,
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
      return this.handleUploaded(payload.fileId, payload.category);
    });
    this.eventBus.on(DOMAIN_EVENTS.FILE_UPDATED, (payload) =>
      this.handleUploaded(payload.fileId, FileCategory.IMAGE, true),
    );
  }

  private async handleUploaded(
    fileId: string,
    category: string,
    onlyIfNeeded = false,
  ): Promise<void> {
    if (category !== FileCategory.IMAGE && category !== 'IMAGE') {
      return;
    }

    try {
      await this.withThumbSlot(() => this.generateThumbnail(fileId, onlyIfNeeded));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Thumbnail pipeline failed for fileId=${fileId}: ${message}`);
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

  async generateThumbnail(fileId: string, onlyIfNeeded = false): Promise<void> {
    const file = await this.prisma.managedFile.findUnique({
      where: { id: fileId },
      include: { cdnConfig: true, derivatives: true },
    });

    if (!file || file.status === FileStatus.DELETED || file.category !== FileCategory.IMAGE) {
      return;
    }
    if (
      onlyIfNeeded &&
      file.derivatives.some(
        (derivative) =>
          derivative.kind === DerivativeKind.THUMB &&
          derivative.status === DerivativeStatus.READY &&
          this.matchesSource(file, derivative.meta),
      )
    )
      return;

    try {
      await this.generateSourceThumbnail(file);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.markFailed(file, message).catch(() => undefined);
      throw error;
    }
  }

  private async generateSourceThumbnail(
    file: ManagedFile & { cdnConfig: CdnConfig | null },
  ): Promise<void> {
    const fileId = file.id;

    if (Number(file.size) > MAX_THUMB_SOURCE_BYTES) {
      await this.markFailed(file, `source exceeds max size ${MAX_THUMB_SOURCE_BYTES}`);
      return;
    }

    if (
      !(await this.withCurrentSource(file, (tx) =>
        tx.fileDerivative.upsert({
          where: { fileId_kind: { fileId, kind: DerivativeKind.THUMB } },
          create: {
            fileId,
            kind: DerivativeKind.THUMB,
            storageKey: '',
            mimeType: 'image/webp',
            size: BigInt(0),
            status: DerivativeStatus.PENDING,
            meta: this.sourceMeta(file),
          },
          update: {
            status: DerivativeStatus.PENDING,
            error: null,
            meta: this.sourceMeta(file),
          },
        }),
      ))
    )
      return;

    const sourceBuffer = await this.readFileBuffer(file);
    const thumbBuffer = await sharp(sourceBuffer, {
      failOn: 'none',
      limitInputPixels: MAX_INPUT_PIXELS,
    })
      .rotate()
      .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
      .webp({ quality: THUMB_WEBP_QUALITY })
      .toBuffer();

    const storageKey = this.buildThumbKey(file);
    const uploadResult = await this.storageService.upload(file.projectId, {
      key: storageKey,
      buffer: thumbBuffer,
      mimeType: 'image/webp',
      originalName: `${file.originalName}.thumb.webp`,
    });

    const thumbnailUrl = this.storageService.buildPublicDerivativeUrl(file.id, 'THUMB');

    if (
      !(await this.withCurrentSource(file, async (tx) => {
        await tx.fileDerivative.upsert({
          where: { fileId_kind: { fileId, kind: DerivativeKind.THUMB } },
          create: {
            fileId,
            kind: DerivativeKind.THUMB,
            storageKey: uploadResult.storageKey,
            mimeType: 'image/webp',
            size: BigInt(thumbBuffer.length),
            status: DerivativeStatus.READY,
            publicUrl: thumbnailUrl,
            meta: { ...this.sourceMeta(file), width: THUMB_WIDTH, format: 'webp' },
          },
          update: {
            storageKey: uploadResult.storageKey,
            mimeType: 'image/webp',
            size: BigInt(thumbBuffer.length),
            status: DerivativeStatus.READY,
            publicUrl: thumbnailUrl,
            meta: { ...this.sourceMeta(file), width: THUMB_WIDTH, format: 'webp' },
            error: null,
          },
        });
        await tx.managedFile.update({
          where: { id: fileId },
          data: { thumbnailUrl },
        });
      }))
    )
      return;

    this.logger.debug(`Thumbnail ready for fileId=${fileId} key=${uploadResult.storageKey}`);
  }

  private async readFileBuffer(
    file: ManagedFile & { cdnConfig: CdnConfig | null },
  ): Promise<Buffer> {
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
      const allowPrivate = getConfigBoolean(
        this.configService,
        'STORAGE_ALLOW_PRIVATE_ENDPOINTS',
        false,
      );
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

  private sourceMeta(file: ManagedFile) {
    return {
      sourceStorageKey: file.storageKey,
      sourceChecksum: file.checksum,
      sourceVersion: file.currentVersion,
      sourceRevision: createHash('sha256')
        .update(JSON.stringify([file.storageKey, file.checksum, file.currentVersion]))
        .digest('hex')
        .slice(0, 32),
    };
  }

  private matchesSource(file: ManagedFile, meta: Prisma.JsonValue): boolean {
    return (
      meta !== null &&
      typeof meta === 'object' &&
      !Array.isArray(meta) &&
      meta.sourceStorageKey === file.storageKey &&
      meta.sourceChecksum === file.checksum &&
      meta.sourceVersion === file.currentVersion
    );
  }

  private async withCurrentSource(
    file: ManagedFile,
    write: (tx: Prisma.TransactionClient) => Promise<unknown>,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.managedFile.updateMany({
        where: {
          id: file.id,
          storageKey: file.storageKey,
          checksum: file.checksum,
          currentVersion: file.currentVersion,
          status: file.status,
          category: FileCategory.IMAGE,
        },
        data: { currentVersion: file.currentVersion },
      });
      if (!locked.count) return false;
      await write(tx);
      return true;
    });
  }

  private async markFailed(file: ManagedFile, error: string): Promise<boolean> {
    return this.withCurrentSource(file, (tx) =>
      tx.fileDerivative.upsert({
        where: { fileId_kind: { fileId: file.id, kind: DerivativeKind.THUMB } },
        create: {
          fileId: file.id,
          kind: DerivativeKind.THUMB,
          storageKey: '',
          mimeType: 'image/webp',
          size: BigInt(0),
          status: DerivativeStatus.FAILED,
          error: error.slice(0, 512),
          meta: this.sourceMeta(file),
        },
        update: {
          status: DerivativeStatus.FAILED,
          error: error.slice(0, 512),
          meta: this.sourceMeta(file),
        },
      }),
    );
  }

  private buildThumbKey(file: ManagedFile): string {
    const storageKey = file.storageKey;
    const lastSlash = storageKey.lastIndexOf('/');
    const dir = lastSlash >= 0 ? storageKey.slice(0, lastSlash + 1) : '';
    return `${dir}thumbs/${file.id}-${this.sourceMeta(file).sourceRevision}-320.webp`;
  }
}
