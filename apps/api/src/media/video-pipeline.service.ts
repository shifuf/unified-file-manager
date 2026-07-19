import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, stat, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DerivativeKind,
  DerivativeStatus,
  FileCategory,
  FileStatus,
} from '@prisma/client';

import { getConfigBoolean } from '../common/utils/security-config.util';
import { safeFetch } from '../common/utils/ssrf-guard.util';
import { DOMAIN_EVENTS } from '../events/domain-events';
import { EventBusService } from '../events/event-bus.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';

type VideoFile = { id: string; projectId: string; storageKey: string; originalName: string };

const HLS_LADDER = [
  { name: '480p', height: 480, videoBitrate: '1000k', audioBitrate: '96k', bandwidth: 1_200_000 },
  { name: '720p', height: 720, videoBitrate: '2500k', audioBitrate: '128k', bandwidth: 2_800_000 },
] as const;

/**
 * Video pipeline:
 * - COVER poster always.
 * - VIDEO_TRANSCODE_ENABLED → progressive MP4_720.
 * - VIDEO_HLS_ENABLED → multi-bitrate HLS (480p + 720p) with master.m3u8.
 */
@Injectable()
export class VideoPipelineService implements OnModuleInit {
  private readonly logger = new Logger(VideoPipelineService.name);
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(
    private readonly configService: ConfigService,
    private readonly eventBus: EventBusService,
    private readonly prisma: PrismaService,
    private readonly storageService: StorageService,
  ) {}

  onModuleInit(): void {
    this.eventBus.on(DOMAIN_EVENTS.FILE_UPLOADED, (payload) => {
      if (payload.category !== FileCategory.VIDEO && payload.category !== 'VIDEO') {
        return;
      }
      void this.withSlot(() => this.processVideo(payload.fileId));
    });
  }

  private async withSlot(fn: () => Promise<void>): Promise<void> {
    if (this.active >= 1) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active += 1;
    try {
      await fn();
    } finally {
      this.active -= 1;
      this.queue.shift()?.();
    }
  }

  private ffmpegBin(): string {
    return this.configService.get<string>('FFMPEG_PATH') || 'ffmpeg';
  }

  private async processVideo(fileId: string): Promise<void> {
    const file = await this.prisma.managedFile.findFirst({
      where: { id: fileId, status: FileStatus.ACTIVE, category: FileCategory.VIDEO },
      include: { cdnConfig: true },
    });
    if (!file) {
      return;
    }

    await this.markDerivative(file.id, DerivativeKind.COVER, 'image/jpeg', DerivativeStatus.PENDING);

    const workDir = await mkdtemp(join(tmpdir(), 'ufm-video-'));
    const inputPath = join(workDir, 'source.bin');
    const coverPath = join(workDir, 'cover.jpg');

    try {
      const target = await this.storageService.getDownloadTarget(file);
      if (target.type === 'stream' && target.stream) {
        await pipeline(target.stream, createWriteStream(inputPath));
      } else if (target.type === 'redirect' && target.url) {
        const response = await safeFetch(target.url);
        if (!response.ok || !response.body) {
          throw new Error(`下载视频失败 HTTP ${response.status}`);
        }
        await pipeline(Readable.fromWeb(response.body as never), createWriteStream(inputPath));
      } else {
        throw new Error('无法读取视频流');
      }

      await this.runFfmpeg([
        '-y',
        '-ss',
        '1',
        '-i',
        inputPath,
        '-frames:v',
        '1',
        '-q:v',
        '3',
        coverPath,
      ]);

      const coverBuffer = await readFile(coverPath);
      const coverKey = `${this.dirPrefix(file.storageKey)}thumbs/${file.id}-cover.jpg`;
      const uploaded = await this.storageService.upload(file.projectId, {
        key: coverKey,
        buffer: coverBuffer,
        mimeType: 'image/jpeg',
        originalName: `${file.originalName}.cover.jpg`,
      });

      const publicUrl = uploaded.publicUrl || this.storageService.buildPublicAccessUrl(file.id);

      await this.prisma.fileDerivative.upsert({
        where: { fileId_kind: { fileId, kind: DerivativeKind.COVER } },
        create: {
          fileId,
          kind: DerivativeKind.COVER,
          storageKey: uploaded.storageKey,
          mimeType: 'image/jpeg',
          size: BigInt(coverBuffer.length),
          status: DerivativeStatus.READY,
          publicUrl,
        },
        update: {
          storageKey: uploaded.storageKey,
          size: BigInt(coverBuffer.length),
          status: DerivativeStatus.READY,
          publicUrl,
          error: null,
        },
      });

      await this.prisma.managedFile.update({
        where: { id: fileId },
        data: { thumbnailUrl: publicUrl },
      });

      if (getConfigBoolean(this.configService, 'VIDEO_TRANSCODE_ENABLED', false)) {
        await this.generateMp4_720(file, inputPath);
      }

      if (getConfigBoolean(this.configService, 'VIDEO_HLS_ENABLED', false)) {
        await this.generateHlsMultiBitrate(file, inputPath, workDir);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Video pipeline failed fileId=${fileId}: ${message}`);
      await this.markDerivative(file.id, DerivativeKind.COVER, 'image/jpeg', DerivativeStatus.FAILED, message);
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private dirPrefix(storageKey: string): string {
    return storageKey.replace(/\/[^/]+$/, '/') || '';
  }

  private async generateMp4_720(file: VideoFile, inputPath: string): Promise<void> {
    const workDir = await mkdtemp(join(tmpdir(), 'ufm-mp4-'));
    const outPath = join(workDir, '720p.mp4');
    await this.markDerivative(file.id, DerivativeKind.MP4_720, 'video/mp4', DerivativeStatus.PENDING);

    try {
      await this.runFfmpeg([
        '-y',
        '-i',
        inputPath,
        '-vf',
        "scale='min(1280,iw)':-2",
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '23',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-movflags',
        '+faststart',
        outPath,
      ]);

      const buffer = await readFile(outPath);
      const key = `${this.dirPrefix(file.storageKey)}thumbs/${file.id}-720p.mp4`;
      const uploaded = await this.storageService.upload(file.projectId, {
        key,
        buffer,
        mimeType: 'video/mp4',
        originalName: `${file.originalName}.720p.mp4`,
      });
      // Prefer CDN public URL; otherwise stable API derivative route.
      const publicUrl =
        uploaded.publicUrl ||
        this.storageService.buildPublicDerivativeUrl(file.id, 'MP4_720');

      await this.prisma.fileDerivative.upsert({
        where: { fileId_kind: { fileId: file.id, kind: DerivativeKind.MP4_720 } },
        create: {
          fileId: file.id,
          kind: DerivativeKind.MP4_720,
          storageKey: uploaded.storageKey,
          mimeType: 'video/mp4',
          size: BigInt(buffer.length),
          status: DerivativeStatus.READY,
          publicUrl,
          meta: { height: 720, format: 'mp4' },
        },
        update: {
          storageKey: uploaded.storageKey,
          size: BigInt(buffer.length),
          status: DerivativeStatus.READY,
          publicUrl,
          error: null,
          meta: { height: 720, format: 'mp4' },
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`MP4_720 failed fileId=${file.id}: ${message}`);
      await this.markDerivative(file.id, DerivativeKind.MP4_720, 'video/mp4', DerivativeStatus.FAILED, message);
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * Multi-bitrate HLS: 480p + 720p variant playlists + master.m3u8.
   * Segment paths in playlists are rewritten to public derivative URLs so players
   * can fetch ts without knowing storage layout.
   */
  private async generateHlsMultiBitrate(file: VideoFile, inputPath: string, workDir: string): Promise<void> {
    const hlsRoot = join(workDir, 'hls');
    await mkdir(hlsRoot, { recursive: true });
    await this.markDerivative(
      file.id,
      DerivativeKind.HLS,
      'application/vnd.apple.mpegurl',
      DerivativeStatus.PENDING,
    );

    try {
      const prefix = `${this.dirPrefix(file.storageKey)}thumbs/${file.id}-hls`;
      const masterLines = ['#EXTM3U', '#EXT-X-VERSION:3'];
      let totalSize = 0;
      const uploadedNames: string[] = [];

      for (const rung of HLS_LADDER) {
        const variantDir = join(hlsRoot, rung.name);
        await mkdir(variantDir, { recursive: true });
        const playlistPath = join(variantDir, 'index.m3u8');

        await this.runFfmpeg([
          '-y',
          '-i',
          inputPath,
          '-vf',
          `scale=-2:'min(${rung.height},ih)'`,
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-b:v',
          rung.videoBitrate,
          '-maxrate',
          rung.videoBitrate,
          '-bufsize',
          String(Number.parseInt(rung.videoBitrate, 10) * 2) + 'k',
          '-c:a',
          'aac',
          '-b:a',
          rung.audioBitrate,
          '-ac',
          '2',
          '-f',
          'hls',
          '-hls_time',
          '6',
          '-hls_playlist_type',
          'vod',
          '-hls_segment_filename',
          join(variantDir, 'seg_%03d.ts'),
          playlistPath,
        ]);

        const entries = await readdir(variantDir);
        for (const name of entries) {
          const full = join(variantDir, name);
          const info = await stat(full);
          if (!info.isFile()) {
            continue;
          }
          let buffer = await readFile(full);
          totalSize += buffer.length;

          // Rewrite relative segment URIs in variant playlist to API derivative paths.
          if (name.endsWith('.m3u8')) {
            const text = buffer.toString('utf8');
            const rewritten = text
              .split('\n')
              .map((line) => {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('#')) {
                  return line;
                }
                // segment filename → public derivative relative path under HLS kind
                const segmentName = `${rung.name}/${trimmed}`;
                return this.storageService.buildPublicDerivativePath(file.id, 'HLS', segmentName);
              })
              .join('\n');
            buffer = Buffer.from(rewritten, 'utf8');
          }

          const relativeName = `${rung.name}/${name}`;
          const key = `${prefix}/${relativeName}`;
          const mimeType = name.endsWith('.m3u8')
            ? 'application/vnd.apple.mpegurl'
            : 'video/mp2t';
          await this.storageService.upload(file.projectId, {
            key,
            buffer,
            mimeType,
            originalName: relativeName.replace(/\//g, '_'),
          });
          uploadedNames.push(relativeName);
        }

        masterLines.push(
          `#EXT-X-STREAM-INF:BANDWIDTH=${rung.bandwidth},RESOLUTION=1280x${rung.height},NAME="${rung.name}"`,
        );
        masterLines.push(this.storageService.buildPublicDerivativePath(file.id, 'HLS', `${rung.name}/index.m3u8`));
      }

      const masterBody = `${masterLines.join('\n')}\n`;
      const masterBuffer = Buffer.from(masterBody, 'utf8');
      totalSize += masterBuffer.length;
      const masterKey = `${prefix}/master.m3u8`;
      const masterUpload = await this.storageService.upload(file.projectId, {
        key: masterKey,
        buffer: masterBuffer,
        mimeType: 'application/vnd.apple.mpegurl',
        originalName: 'master.m3u8',
      });

      // Always use API derivative route for master so relative/absolute path rewrites work
      // even when CDN domain is missing or CORS-blocked for m3u8.
      const playlistPublicUrl = this.storageService.buildPublicDerivativeUrl(file.id, 'HLS');

      await this.prisma.fileDerivative.upsert({
        where: { fileId_kind: { fileId: file.id, kind: DerivativeKind.HLS } },
        create: {
          fileId: file.id,
          kind: DerivativeKind.HLS,
          storageKey: masterUpload.storageKey,
          mimeType: 'application/vnd.apple.mpegurl',
          size: BigInt(totalSize),
          status: DerivativeStatus.READY,
          publicUrl: playlistPublicUrl,
          meta: {
            format: 'hls',
            multiBitrate: true,
            ladders: HLS_LADDER.map((r) => r.name),
            segmentPrefix: prefix,
            files: uploadedNames,
          },
        },
        update: {
          storageKey: masterUpload.storageKey,
          size: BigInt(totalSize),
          status: DerivativeStatus.READY,
          publicUrl: playlistPublicUrl,
          error: null,
          meta: {
            format: 'hls',
            multiBitrate: true,
            ladders: HLS_LADDER.map((r) => r.name),
            segmentPrefix: prefix,
            files: uploadedNames,
          },
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`HLS multi-bitrate failed fileId=${file.id}: ${message}`);
      await this.markDerivative(
        file.id,
        DerivativeKind.HLS,
        'application/vnd.apple.mpegurl',
        DerivativeStatus.FAILED,
        message,
      );
    }
  }

  private async markDerivative(
    fileId: string,
    kind: DerivativeKind,
    mimeType: string,
    status: DerivativeStatus,
    error?: string,
  ): Promise<void> {
    await this.prisma.fileDerivative
      .upsert({
        where: { fileId_kind: { fileId, kind } },
        create: {
          fileId,
          kind,
          storageKey: '',
          mimeType,
          size: BigInt(0),
          status,
          error: error ? error.slice(0, 512) : null,
        },
        update: {
          status,
          error: error ? error.slice(0, 512) : null,
        },
      })
      .catch(() => undefined);
  }

  private runFfmpeg(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.ffmpegBin(), args, { windowsHide: true });
      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });
      child.on('error', (error) => {
        reject(new Error(`ffmpeg 不可用: ${error.message}`));
      });
      child.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(stderr.slice(-400) || `ffmpeg exit ${code}`));
        }
      });
    });
  }
}
