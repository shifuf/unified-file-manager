import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
  Put,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import archiver from 'archiver';
import type { Request, Response } from 'express';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Throttle } from '../common/guards/throttle.decorator';
import type { RequestUser } from '../common/types/request-user.type';
import { getClientIp } from '../common/utils/client-ip.util';
import { isUrlHostAllowed, normalizeDomainAllowlist } from '../common/utils/domain-allowlist.util';
import { buildFrameAncestors, buildRequestPublicBaseUrl, isSecureRequest, parseOrigins } from '../common/utils/origin.util';
import {
  applyRangeHeaders,
  getRequestRangeHeader,
  parseByteRange,
  pipeStreamToResponse,
  writeUnsatisfiableRange,
} from '../common/utils/http-range.util';
import { safeFetch } from '../common/utils/ssrf-guard.util';
import { SettingsService } from '../settings/settings.service';
import { StorageService } from '../storage/storage.service';
import { AccessStatsService } from './access-stats.service';
import { BatchDownloadDto } from './dto/batch-download.dto';
import { BatchFileOperationDto } from './dto/batch-file-operation.dto';
import { BatchCopyFileDto, BatchMoveFileDto } from './dto/batch-move-file.dto';
import { CopyFileDto } from './dto/copy-file.dto';
import { CreateShareLinkDto } from './dto/create-share-link.dto';
import { InitChunkedUploadDto } from './dto/init-chunked-upload.dto';
import { ListFilesDto } from './dto/list-files.dto';
import { ListShareLinksDto } from './dto/list-share-links.dto';
import { MoveFileDto } from './dto/move-file.dto';
import { UpdateFileDto } from './dto/update-file.dto';
import { UpdateShareLinkDto } from './dto/update-share-link.dto';
import { FilesService } from './files.service';
import {
  createImageTransformStream,
  hasImageTransform,
  matchesStoredThumb,
  parseImageTransformOptions,
  resolveTransformedContentType,
} from './image-transform.util';
import { UploadFilesInterceptor } from './interceptors/upload-files.interceptor';
import { createWatermarkStream } from './watermark.util';

type ArchiveFailure = {
  name: string;
  reason: string;
};

type ArchiveFile = Awaited<ReturnType<FilesService['listArchiveFiles']>>[number];

@ApiTags('文件管理')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
export class FilesController {
  constructor(private readonly filesService: FilesService) {}

  @Get('files')
  list(@Query() query: ListFilesDto, @CurrentUser() user: RequestUser): ReturnType<FilesService['list']> {
    return this.filesService.list(query, user);
  }

  @Get('files/:fileId')
  get(@Param('fileId') fileId: string, @CurrentUser() user: RequestUser): ReturnType<FilesService['get']> {
    return this.filesService.get(fileId, user);
  }

  @Put('files/:fileId')
  update(
    @Param('fileId') fileId: string,
    @Body() dto: UpdateFileDto,
    @CurrentUser() user: RequestUser,
  ): ReturnType<FilesService['update']> {
    return this.filesService.update(fileId, dto, user);
  }

  @Post('projects/:projectId/files')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(UploadFilesInterceptor)
  upload(
    @Param('projectId') projectId: string,
    @Query('folderPath') folderPath: string | undefined,
    @Query('duplicateStrategy') duplicateStrategy: 'reject' | 'reuse' | 'replace' | undefined,
    @Query('targetFileId') targetFileId: string | undefined,
    @UploadedFiles() files: Express.Multer.File[],
    @CurrentUser() user: RequestUser,
  ): ReturnType<FilesService['upload']> {
    return this.filesService.upload(projectId, files, user, { folderPath, duplicateStrategy, targetFileId });
  }

  @Post('projects/:projectId/uploads/init')
  initChunkedUpload(
    @Param('projectId') projectId: string,
    @Body() dto: InitChunkedUploadDto,
    @CurrentUser() user: RequestUser,
  ): ReturnType<FilesService['initChunkedUpload']> {
    return this.filesService.initChunkedUpload(projectId, dto, user);
  }

  @Get('projects/:projectId/uploads/:uploadId')
  getChunkStatus(
    @Param('projectId') projectId: string,
    @Param('uploadId') uploadId: string,
    @CurrentUser() user: RequestUser,
  ): ReturnType<FilesService['getChunkStatus']> {
    return this.filesService.getChunkStatus(projectId, uploadId, user);
  }

  @Put('projects/:projectId/uploads/:uploadId/chunks/:chunkIndex')
  @ApiConsumes('multipart/form-data')
  @Throttle({ limit: 1200, windowMs: 60_000 })
  @UseInterceptors(UploadFilesInterceptor)
  uploadChunk(
    @Param('projectId') projectId: string,
    @Param('uploadId') uploadId: string,
    @Param('chunkIndex') chunkIndex: string,
    @UploadedFiles() files: Express.Multer.File[],
    @CurrentUser() user: RequestUser,
  ): ReturnType<FilesService['uploadChunk']> {
    return this.filesService.uploadChunk(projectId, uploadId, Number(chunkIndex), files?.[0], user);
  }

  @Post('projects/:projectId/uploads/:uploadId/complete')
  completeChunkedUpload(
    @Param('projectId') projectId: string,
    @Param('uploadId') uploadId: string,
    @CurrentUser() user: RequestUser,
  ): ReturnType<FilesService['completeChunkedUpload']> {
    return this.filesService.completeChunkedUpload(projectId, uploadId, user);
  }

  @Delete('projects/:projectId/uploads/:uploadId')
  abortChunkedUpload(
    @Param('projectId') projectId: string,
    @Param('uploadId') uploadId: string,
    @CurrentUser() user: RequestUser,
  ): ReturnType<FilesService['abortChunkedUpload']> {
    return this.filesService.abortChunkedUpload(projectId, uploadId, user);
  }

  @Get('projects/:projectId/files/folders')
  listFolders(
    @Param('projectId') projectId: string,
    @CurrentUser() user: RequestUser,
  ): ReturnType<FilesService['listFolders']> {
    return this.filesService.listFolders(projectId, user);
  }

  @Get('projects/:projectId/files/search')
  search(
    @Param('projectId') projectId: string,
    @Query('q') q: string | undefined,
    @Query('page') page: string | undefined,
    @Query('pageSize') pageSize: string | undefined,
    @CurrentUser() user: RequestUser,
  ): ReturnType<FilesService['search']> {
    return this.filesService.search(projectId, q ?? '', user, {
      page: page === undefined ? undefined : Number(page),
      pageSize: pageSize === undefined ? undefined : Number(pageSize),
    });
  }

  @Get('projects/:projectId/files/folder-tree')
  listFolderTree(
    @Param('projectId') projectId: string,
    @CurrentUser() user: RequestUser,
  ): ReturnType<FilesService['listFolderTree']> {
    return this.filesService.listFolderTree(projectId, user);
  }

  @Post('projects/:projectId/files/migrate-local')
  migrateLocalFiles(
    @Param('projectId') projectId: string,
    @CurrentUser() user: RequestUser,
  ): ReturnType<FilesService['migrateLocalFiles']> {
    return this.filesService.migrateLocalFiles(projectId, user);
  }

  @Get('files/:fileId/download')
  async download(
    @Param('fileId') fileId: string,
    @CurrentUser() user: RequestUser,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const meta = await this.filesService.get(fileId, user);
    const size = Number(meta.size ?? 0);
    const parsed = parseByteRange(getRequestRangeHeader(request), size);
    if (parsed === 'unsatisfiable') {
      writeUnsatisfiableRange(response, size);
      return;
    }

    const range =
      parsed && typeof parsed === 'object'
        ? { start: parsed.start, end: parsed.end }
        : undefined;
    const { file, target } = await this.filesService.getDownloadTarget(fileId, user, range);

    await this.writeDownloadResponse(
      response,
      file.originalName,
      file.mimeType,
      target,
      size,
      parsed && typeof parsed === 'object' ? parsed : null,
    );
  }

  @Post('files/batch-download')
  @HttpCode(200)
  @Header('Content-Type', 'application/zip')
  async batchDownload(
    @Body() dto: BatchDownloadDto,
    @CurrentUser() user: RequestUser,
    @Res() response: Response,
  ): Promise<void> {
    const files = await this.filesService.listArchiveFiles(dto.fileIds, user);
    response.attachment(`files-${Date.now()}.zip`);
    const archive = archiver('zip', { zlib: { level: 9 } });
    const failures: ArchiveFailure[] = [];
    const usedNames = new Set<string>();

    archive.once('error', (error) => this.handleArchiveError(response, error));
    archive.pipe(response);

    for (const file of files) {
      try {
        const target = await this.resolveArchiveTarget(file.id, user);
        archive.append(target, { name: this.buildArchiveEntryName(file, usedNames) });
      } catch (error) {
        failures.push({
          name: file.originalName,
          reason: error instanceof Error && error.message ? error.message : '文件读取失败',
        });
      }
    }

    if (failures.length > 0) {
      archive.append(this.formatArchiveFailures(failures), { name: '_download-failures.txt' });
    }

    await archive.finalize();
  }

  @Post('files/batch/recycle')
  batchRecycle(
    @Body() dto: BatchFileOperationDto,
    @CurrentUser() user: RequestUser,
  ): ReturnType<FilesService['batchRecycle']> {
    return this.filesService.batchRecycle(dto, user);
  }

  @Post('files/batch/restore')
  batchRestore(
    @Body() dto: BatchFileOperationDto,
    @CurrentUser() user: RequestUser,
  ): ReturnType<FilesService['batchRestore']> {
    return this.filesService.batchRestore(dto, user);
  }

  @Post('files/batch/purge')
  batchPurge(
    @Body() dto: BatchFileOperationDto,
    @CurrentUser() user: RequestUser,
  ): ReturnType<FilesService['batchPurge']> {
    return this.filesService.batchPurge(dto, user);
  }

  @Post('files/batch/move')
  batchMove(
    @Body() dto: BatchMoveFileDto,
    @CurrentUser() user: RequestUser,
  ): ReturnType<FilesService['batchMove']> {
    return this.filesService.batchMove(dto, user);
  }

  @Post('files/batch/copy')
  batchCopy(
    @Body() dto: BatchCopyFileDto,
    @CurrentUser() user: RequestUser,
  ): ReturnType<FilesService['batchCopy']> {
    return this.filesService.batchCopy(dto, user);
  }

  @Post('files/:fileId/move')
  move(
    @Param('fileId') fileId: string,
    @Body() dto: MoveFileDto,
    @CurrentUser() user: RequestUser,
  ): ReturnType<FilesService['move']> {
    return this.filesService.move(fileId, dto, user);
  }

  @Post('files/:fileId/copy')
  copy(
    @Param('fileId') fileId: string,
    @Body() dto: CopyFileDto,
    @CurrentUser() user: RequestUser,
  ): ReturnType<FilesService['copy']> {
    return this.filesService.copy(fileId, dto, user);
  }

  @Post('files/:fileId/shares')
  createShareLink(
    @Param('fileId') fileId: string,
    @Body() dto: CreateShareLinkDto,
    @Req() request: Request,
    @CurrentUser() user: RequestUser,
  ): ReturnType<FilesService['createShareLink']> {
    return this.filesService.createShareLink(fileId, dto, user, buildRequestPublicBaseUrl(request));
  }

  @Get('files/:fileId/shares')
  listShareLinks(
    @Param('fileId') fileId: string,
    @Req() request: Request,
    @CurrentUser() user: RequestUser,
  ): ReturnType<FilesService['listShareLinks']> {
    return this.filesService.listShareLinks(fileId, user, buildRequestPublicBaseUrl(request));
  }

  @Get('file-shares')
  listAllShareLinks(
    @Query() query: ListShareLinksDto,
    @Req() request: Request,
    @CurrentUser() user: RequestUser,
  ): ReturnType<FilesService['listAllShareLinks']> {
    return this.filesService.listAllShareLinks(query, user, buildRequestPublicBaseUrl(request));
  }

  @Delete('file-shares/:shareId')
  disableShareLink(
    @Param('shareId') shareId: string,
    @CurrentUser() user: RequestUser,
  ): ReturnType<FilesService['disableShareLink']> {
    return this.filesService.disableShareLink(shareId, user);
  }

  @Put('file-shares/:shareId')
  updateShareLink(
    @Param('shareId') shareId: string,
    @Body() dto: UpdateShareLinkDto,
    @Req() request: Request,
    @CurrentUser() user: RequestUser,
  ): ReturnType<FilesService['updateShareLink']> {
    return this.filesService.updateShareLink(shareId, dto, user, buildRequestPublicBaseUrl(request));
  }

  @Delete('files/:fileId')
  recycle(
    @Param('fileId') fileId: string,
    @CurrentUser() user: RequestUser,
  ): ReturnType<FilesService['recycle']> {
    return this.filesService.recycle(fileId, user);
  }

  @Post('files/:fileId/restore')
  restore(
    @Param('fileId') fileId: string,
    @CurrentUser() user: RequestUser,
  ): ReturnType<FilesService['restore']> {
    return this.filesService.restore(fileId, user);
  }

  @Delete('files/:fileId/purge')
  purge(
    @Param('fileId') fileId: string,
    @CurrentUser() user: RequestUser,
  ): ReturnType<FilesService['purge']> {
    return this.filesService.purge(fileId, user);
  }

  @Get('files/:fileId/versions')
  listVersions(
    @Param('fileId') fileId: string,
    @CurrentUser() user: RequestUser,
  ): ReturnType<FilesService['listVersions']> {
    return this.filesService.listVersions(fileId, user);
  }

  @Post('files/:fileId/versions/:version/restore')
  restoreVersion(
    @Param('fileId') fileId: string,
    @Param('version') version: string,
    @CurrentUser() user: RequestUser,
  ): ReturnType<FilesService['restoreVersion']> {
    return this.filesService.restoreVersion(fileId, Number(version), user);
  }

  private async writeDownloadResponse(
    response: Response,
    filename: string,
    mimeType: string,
    target: Awaited<ReturnType<FilesService['getDownloadTarget']>>['target'],
    size = 0,
    range: ReturnType<typeof parseByteRange> extends infer T
      ? T extends object
        ? T
        : null
      : null = null,
  ): Promise<void> {
    // Cloud redirect cannot honor API-side Range; only redirect when full body requested.
    if (target.type === 'redirect' && target.url && !range) {
      response.setHeader('Cache-Control', 'private, no-store, max-age=0, must-revalidate');
      response.redirect(target.url);
      return;
    }

    if (!target.stream) {
      response.status(404).send('File stream not found.');
      return;
    }

    this.setPrivateDownloadHeaders(response);
    applyRangeHeaders(
      response,
      mimeType,
      size,
      range && typeof range === 'object' ? range : null,
      'attachment',
      filename,
    );
    pipeStreamToResponse(target.stream as Readable, response, (error) =>
      this.handleStreamError(response, error),
    );
  }

  private handleStreamError(response: Response, error: Error): void {
    if (!response.headersSent) {
      response.status(404).send('File stream not found.');
      return;
    }

    response.destroy(error);
  }

  private async resolveArchiveTarget(
    fileId: string,
    user: RequestUser,
  ): Promise<Readable> {
    const { target } = await this.filesService.getDownloadTarget(fileId, user);

    if (target.type === 'stream' && target.stream) {
      return target.stream;
    }

    if (!target.url) {
      throw new BadRequestException('没有可用的下载地址。');
    }

    const remoteResponse = await safeFetch(target.url, { signal: AbortSignal.timeout(30_000) });
    if (!remoteResponse.ok || !remoteResponse.body) {
      throw new BadRequestException(`远程存储返回 ${remoteResponse.status}`);
    }

    return Readable.fromWeb(remoteResponse.body as unknown as NodeReadableStream);
  }

  private formatArchiveFailures(failures: ArchiveFailure[]): string {
    return [
      '以下文件未能加入本次批量下载：',
      ...failures.map((failure) => `- ${failure.name}: ${failure.reason}`),
      '',
    ].join('\n');
  }

  private buildArchiveEntryName(file: ArchiveFile, usedNames: Set<string>): string {
    const folderPath = (file.folderPath ?? '')
      .split('/')
      .map((segment) => this.sanitizeArchivePathSegment(segment))
      .filter(Boolean)
      .join('/');
    const fileName = this.sanitizeArchivePathSegment(file.originalName) || `file-${usedNames.size + 1}`;
    const baseName = folderPath ? `${folderPath}/${fileName}` : fileName;
    return this.uniqueArchiveEntryName(baseName, usedNames);
  }

  private sanitizeArchivePathSegment(value: string): string {
    return (
      value
        .replace(/\\/g, '/')
        .split('/')
        .pop()
        ?.split('')
        .map((char) => {
          const code = char.charCodeAt(0);
          return code < 32 || code === 127 ? '_' : char;
        })
        .join('')
        .replace(/^\.+$/g, '_')
        .trim()
        .slice(0, 180) || ''
    );
  }

  private uniqueArchiveEntryName(baseName: string, usedNames: Set<string>): string {
    let candidate = baseName;
    let index = 2;

    while (usedNames.has(candidate)) {
      const slashIndex = baseName.lastIndexOf('/');
      const directory = slashIndex >= 0 ? baseName.slice(0, slashIndex + 1) : '';
      const filename = slashIndex >= 0 ? baseName.slice(slashIndex + 1) : baseName;
      const dotIndex = filename.lastIndexOf('.');
      const stem = dotIndex > 0 ? filename.slice(0, dotIndex) : filename;
      const extension = dotIndex > 0 ? filename.slice(dotIndex) : '';
      candidate = `${directory}${stem} (${index})${extension}`;
      index += 1;
    }

    usedNames.add(candidate);
    return candidate;
  }

  private handleArchiveError(response: Response, error: Error): void {
    if (!response.headersSent) {
      response.status(500).send('Archive generation failed.');
      return;
    }

    response.destroy(error);
  }

  private setPrivateDownloadHeaders(response: Response): void {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Accept-Ranges', 'bytes');
  }
}

@ApiTags('公开文件访问')
@Throttle({ limit: 1200, windowMs: 60_000 })
@Controller('public/files')
export class PublicFilesController {
  constructor(
    private readonly configService: ConfigService,
    private readonly filesService: FilesService,
    private readonly settingsService: SettingsService,
    private readonly storageService: StorageService,
    private readonly accessStatsService: AccessStatsService,
  ) {}

  /**
   * Serve READY derivatives (HLS master/segments, MP4_720, …).
   * Paths:
   *   /api/public/files/:fileId/derivatives/HLS
   *   /api/public/files/:fileId/derivatives/HLS/480p/seg_000.ts
   *   /api/public/files/:fileId/derivatives/MP4_720
   */
  @Get(':fileId/derivatives/:kind')
  @Get(':fileId/derivatives/:kind/*')
  async accessDerivative(
    @Param('fileId') fileId: string,
    @Param('kind') kind: string,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const marker = `/derivatives/${kind}`;
    const pathOnly = (request.originalUrl || request.url || '').split('?')[0] || '';
    const idx = pathOnly.indexOf(marker);
    let subPath: string | undefined;
    if (idx >= 0) {
      const rest = pathOnly.slice(idx + marker.length).replace(/^\//, '');
      if (rest) {
        subPath = rest
          .split('/')
          .filter(Boolean)
          .map((part) => {
            try {
              return decodeURIComponent(part);
            } catch {
              return part;
            }
          })
          .join('/');
      }
    }

    try {
      // Same access model as the original file: open-public / signed / authorized referer.
      const access = await this.filesService.getPublicDownloadTarget(
        fileId,
        request.query.expires === undefined ? undefined : Number(request.query.expires),
        typeof request.query.signature === 'string' ? request.query.signature : undefined,
      );
      const accessMode = await this.enforcePublicAccessPolicy(request, access);

      const { target, mimeType, size } = await this.filesService.getPublicDerivativeTarget(
        fileId,
        kind,
        subPath,
      );

      const parsed = parseByteRange(getRequestRangeHeader(request), size > 0 ? size : Number.MAX_SAFE_INTEGER);
      if (parsed === 'unsatisfiable') {
        writeUnsatisfiableRange(response, size);
        return;
      }

      if (target.type === 'redirect' && target.url && !(parsed && typeof parsed === 'object')) {
        response.setHeader('Cache-Control', 'private, no-store, max-age=0, must-revalidate');
        response.setHeader('Access-Control-Allow-Origin', '*');
        response.redirect(target.url);
        return;
      }

      let stream = target.stream;
      if (!stream && target.type === 'redirect' && target.url) {
        stream = await this.fetchRemoteStream(target.url);
      }

      if (!stream) {
        response.status(404).send('Derivative stream not found.');
        return;
      }

      this.applyPublicCacheHeaders(response, accessMode);
      response.setHeader('Access-Control-Allow-Origin', '*');
      response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      applyRangeHeaders(
        response,
        mimeType,
        size > 0 ? size : 0,
        parsed && typeof parsed === 'object' && size > 0 ? parsed : null,
        'inline',
        subPath || kind,
      );
      pipeStreamToResponse(stream as Readable, response, (error) =>
        this.handlePublicStreamError(response, error),
      );
    } catch (error) {
      if (!response.headersSent) {
        if (error instanceof ForbiddenException) {
          response.status(403).send(error.message);
          return;
        }
        if (error instanceof BadRequestException) {
          response.status(400).send(error.message);
          return;
        }
        const status =
          typeof error === 'object' && error !== null && 'getStatus' in error
            ? Number((error as { getStatus: () => number }).getStatus())
            : 404;
        const message = error instanceof Error ? error.message : 'Derivative not found.';
        response.status(Number.isFinite(status) ? status : 404).send(message);
      }
    }
  }

  @Get(':fileId')
  async access(
    @Param('fileId') fileId: string,
    @Query('expires') expires: string | undefined,
    @Query('signature') signature: string | undefined,
    @Query('w') rawWidth: string | undefined,
    @Query('h') rawHeight: string | undefined,
    @Query('x') rawX: string | undefined,
    @Query('y') rawY: string | undefined,
    @Query('cw') rawCropWidth: string | undefined,
    @Query('ch') rawCropHeight: string | undefined,
    @Query('format') rawFormat: string | undefined,
    @Query('preset') rawPreset: string | undefined,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const access = await this.filesService.getPublicDownloadTarget(
      fileId,
      expires === undefined ? undefined : Number(expires),
      signature,
    );
    const { file, target, allowedDomains, isOpenPublic, signatureValid } = access;

    // Access model:
    // - signed temporary link: trusted as-is (still enforce HTTPS when required)
    // - isOpenPublic (per-file / folder public): open hotlink, publicly cacheable
    // - otherwise: only project/global authorized domains with an explicit Origin/Referer
    //   (empty Origin+Referer no longer bypasses the allowlist)
    const accessMode = await this.enforcePublicAccessPolicy(request, {
      allowedDomains,
      isOpenPublic,
      signatureValid,
    });

    this.setPublicFileHeaders(response, accessMode);

    // Hotspot counters (referer + bytes). Best-effort; never block delivery.
    this.accessStatsService.recordPublicAccess({
      projectId: file.projectId,
      fileId: file.id,
      bytes: Number(file.size) || 0,
      referer: request.get('referer'),
      origin: request.get('origin'),
    });

    const transformOptions = parseImageTransformOptions(
      rawWidth,
      rawFormat,
      request.headers['accept'],
      rawHeight,
      rawX,
      rawY,
      rawCropWidth,
      rawCropHeight,
      rawPreset,
    );
    const shouldTransform = file.category === 'IMAGE' && hasImageTransform(transformOptions);
    const fileSize = Number(file.size);
    const parsedRange = shouldTransform
      ? null
      : parseByteRange(getRequestRangeHeader(request), fileSize);
    if (parsedRange === 'unsatisfiable') {
      writeUnsatisfiableRange(response, fileSize);
      return;
    }
    const rangeOpts =
      parsedRange && typeof parsedRange === 'object'
        ? { start: parsedRange.start, end: parsedRange.end }
        : undefined;

    // Pre-generated 320px webp THUMB: serve the stored object, skip sharp.
    if (shouldTransform && matchesStoredThumb(transformOptions)) {
      const thumb = await this.filesService.getReadyThumbDerivative(file.id);
      if (thumb) {
        const thumbEtag = this.buildThumbEtag(file.id, thumb.size, file.checksum);
        if (this.matchesEtag(request, thumbEtag)) {
          response.status(304).end();
          return;
        }

        try {
          const thumbTarget = await this.storageService.getDownloadTargetForKey(
            file,
            thumb.storageKey,
          );
          if (thumbTarget.type === 'redirect' && thumbTarget.url && !thumbTarget.stream) {
            // Signed CDN URL — do not cache 302 (token expires).
            response.setHeader('Cache-Control', 'private, no-store, max-age=0, must-revalidate');
            response.redirect(thumbTarget.url);
            return;
          }

          let stream = thumbTarget.stream;
          if (!stream && thumbTarget.type === 'redirect' && thumbTarget.url) {
            stream = await this.fetchRemoteStream(thumbTarget.url);
          }
          if (stream) {
            response.setHeader('Content-Type', thumb.mimeType || 'image/webp');
            response.setHeader(
              'Content-Disposition',
              `inline; filename*=UTF-8''${encodeURIComponent(file.originalName)}.thumb.webp`,
            );
            if (accessMode === 'open') {
              response.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
            } else {
              this.applyPublicCacheHeaders(response, accessMode);
            }
            response.setHeader('ETag', thumbEtag);
            stream.once('error', (error) => this.handlePublicStreamError(response, error));
            stream.pipe(response);
            return;
          }
        } catch {
          // Fall through to on-the-fly transform if stored thumb is missing.
        }
      }
    }

    // Prefer ranged stream when seeking; avoid bare redirect so Accept-Ranges works.
    // Image transforms also need a server-side stream (sharp).
    let activeTarget = target;
    if (rangeOpts || shouldTransform) {
      try {
        activeTarget = await this.storageService.getDownloadTarget(file, undefined, rangeOpts, {
          preferRedirect: false,
        });
      } catch {
        activeTarget = target;
      }
    } else if (activeTarget.type === 'stream' && file.cdnConfig?.provider !== 'LOCAL') {
      // Target may have been built without preferRedirect if env is off; leave as-is.
    }

    if (activeTarget.type === 'redirect' && activeTarget.url && !rangeOpts && !shouldTransform) {
      // Signed CDN Location expires in minutes. Never cache the 302/ETag-304 path —
      // browsers would reuse a stale ?e=&token= and CDN returns "token out of date".
      response.setHeader('Cache-Control', 'private, no-store, max-age=0, must-revalidate');
      response.setHeader('Pragma', 'no-cache');
      response.redirect(activeTarget.url);
      return;
    }

    let stream = activeTarget.stream;
    if (!stream && activeTarget.type === 'redirect' && activeTarget.url) {
      stream = await this.fetchRemoteStream(activeTarget.url);
    }

    if (!stream) {
      response.status(404).send('File stream not found.');
      return;
    }

    if (shouldTransform) {
      const transformedType = resolveTransformedContentType(transformOptions) ?? file.mimeType;
      response.setHeader('Content-Type', transformedType);
      response.setHeader(
        'Content-Disposition',
        `inline; filename*=UTF-8''${encodeURIComponent(file.originalName)}`,
      );
      if (accessMode === 'open') {
        response.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
      } else {
        this.applyPublicCacheHeaders(response, accessMode);
      }
      if (transformOptions.negotiated) {
        response.setHeader('Vary', 'Accept');
      }

      const transformer = createImageTransformStream(transformOptions);
      const handleStreamError = () => {
        if (!response.headersSent) {
          response.status(404).send('File stream not found.');
          return;
        }
        response.destroy();
      };
      transformer.once('error', handleStreamError);
      stream.once('error', handleStreamError);
      stream.pipe(transformer).pipe(response);
      return;
    }

    const etag = this.buildFileEtag(file);
    if (!rangeOpts && etag && this.matchesEtag(request, etag)) {
      response.status(304).end();
      return;
    }

    this.applyOriginalCacheHeaders(response, file, etag, accessMode);
    applyRangeHeaders(
      response,
      file.mimeType,
      fileSize,
      parsedRange && typeof parsedRange === 'object' ? parsedRange : null,
      'inline',
      file.originalName,
    );
    pipeStreamToResponse(stream as Readable, response, (error) =>
      this.handlePublicStreamError(response, error),
    );
  }

  private applyOriginalCacheHeaders(
    response: Response,
    file: { checksum?: string | null; updatedAt?: Date | null; size?: bigint | number | null },
    etag: string | null,
    mode: 'open' | 'signed' | 'restricted' = 'restricted',
  ): void {
    // Only open/public files get shared edge cache. Signed/restricted stay private/no-store.
    // Originals may be overwritten in place (same fileId URL) — never immutable.
    this.applyPublicCacheHeaders(response, mode);
    if (mode === 'open') {
      response.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
    }
    if (etag) {
      response.setHeader('ETag', etag);
    }
    if (file.updatedAt instanceof Date) {
      response.setHeader('Last-Modified', file.updatedAt.toUTCString());
    }
  }

  private buildFileEtag(file: {
    id: string;
    checksum?: string | null;
    size?: bigint | number | null;
    updatedAt?: Date | null;
  }): string | null {
    if (file.checksum) {
      return `"${file.checksum}"`;
    }
    const size = file.size == null ? 0 : Number(file.size);
    const updated = file.updatedAt instanceof Date ? file.updatedAt.getTime() : 0;
    return `W/"${file.id}-${size}-${updated}"`;
  }

  private buildThumbEtag(fileId: string, size: number, checksum?: string | null): string {
    if (checksum) {
      return `"thumb-${checksum}"`;
    }
    return `W/"thumb-${fileId}-${size}"`;
  }

  private matchesEtag(request: Request, etag: string): boolean {
    const raw = request.headers['if-none-match'];
    if (!raw) {
      return false;
    }
    const candidates = String(raw)
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
    return candidates.some((value) => value === etag || value === `W/${etag}` || etag === `W/${value}`);
  }

  private async fetchRemoteStream(url: string): Promise<Readable | undefined> {
    try {
      const remote = await safeFetch(url);
      if (remote.ok && remote.body) {
        return Readable.fromWeb(remote.body as NodeReadableStream);
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  private handlePublicStreamError(response: Response, error: Error): void {
    if (!response.headersSent) {
      response.status(404).send('File stream not found.');
      return;
    }
    response.destroy(error);
  }

  /**
   * Enforce public file access policy and return the cache mode to apply.
   * - open: explicitly published (isPublic / folder policy) — shared cache OK
   * - signed: temporary HMAC link — private, no-store
   * - restricted: domain allowlist anti-hotlink only (forgeable headers) — private, no-store
   *   Confidential content must use open or signed; do not treat restricted as ACL.
   */
  private async enforcePublicAccessPolicy(
    request: Request,
    access: { allowedDomains: string[]; isOpenPublic: boolean; signatureValid: boolean },
  ): Promise<'open' | 'signed' | 'restricted'> {
    if (access.signatureValid) {
      await this.assertHttpsIfRequired(request);
      return 'signed';
    }
    if (access.isOpenPublic) {
      await this.assertHttpsIfRequired(request);
      return 'open';
    }
    await this.assertAllowedDomain(request, access.allowedDomains);
    return 'restricted';
  }

  private async assertAllowedDomain(request: Request, projectAllowlist: string[]): Promise<void> {
    await this.assertHttpsIfRequired(request);
    const origin = request.get('origin');
    const referer = request.get('referer');

    // Never allow curl/direct downloads of non-public files without a signed URL.
    // Missing both headers used to be a bypass of the domain allowlist.
    if (!origin && !referer) {
      throw new ForbiddenException('非公开文件需要签名链接，或从授权域名引用访问。');
    }

    const globalAllowlist = await this.settingsService.getPublicFileAllowedDomains();
    const configuredAllowlist = projectAllowlist.length > 0 ? projectAllowlist : globalAllowlist;
    const allowlist = configuredAllowlist.length > 0 ? configuredAllowlist : this.defaultPublicFileAllowlist(request);

    if (this.isAllowedSource(request, allowlist)) {
      return;
    }

    throw new ForbiddenException('当前来源域名不在文件访问白名单内。');
  }

  private applyPublicCacheHeaders(response: Response, mode: 'open' | 'signed' | 'restricted'): void {
    // Only fully public files may be edge-cached. Signed/restricted must stay private so
    // nginx proxy_cache cannot serve them to unauthorized clients.
    if (mode === 'open') {
      response.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
      return;
    }
    response.setHeader('Cache-Control', 'private, no-store, max-age=0, must-revalidate');
  }

  private async assertHttpsIfRequired(request: Request): Promise<void> {
    if (!(await this.settingsService.isHttpsRequired()) || isSecureRequest(request) || this.isLocalRequest(request)) {
      return;
    }

    throw new ForbiddenException('公开文件访问需要使用 HTTPS。');
  }

  private defaultPublicFileAllowlist(request: Request): string[] {
    return normalizeDomainAllowlist([
      this.configService.get<string>('PUBLIC_URL', ''),
      request.get('host') ?? '',
    ]);
  }

  private isLocalRequest(request: Request): boolean {
    const hostname = request.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  }

  /**
   * Domain allowlist is anti-hotlink UX only — Origin/Referer are forgeable.
   * Confidential files must use isOpenPublic or a signed URL (see enforcePublicAccessPolicy).
   * WeChat Mini Program (servicewechat.com) is intentionally NOT hard-allowed here:
   * mark files public or issue short-lived signed URLs for private content.
   */
  private isAllowedSource(request: Request, allowlist: string[]): boolean {
    const origin = request.get('origin');
    const referer = request.get('referer');

    if (origin && isUrlHostAllowed(origin, allowlist)) {
      return true;
    }

    if (referer && isUrlHostAllowed(referer, allowlist)) {
      return true;
    }

    return false;
  }

  private setPublicFileHeaders(response: Response, mode: 'open' | 'signed' | 'restricted' = 'restricted'): void {
    const webPublicUrl = this.configService.get<string>('PUBLIC_URL', '');
    const frameAncestors = buildFrameAncestors(parseOrigins(webPublicUrl));

    response.removeHeader('X-Frame-Options');
    this.applyPublicCacheHeaders(response, mode);
    response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    response.setHeader('Vary', 'Origin, Referer, Sec-Fetch-Site');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader(
      'Content-Security-Policy',
      [
        `frame-ancestors ${frameAncestors}`,
        "default-src 'none'",
        "img-src 'self' data: blob:",
        "media-src 'self' data: blob:",
        "style-src 'self' 'unsafe-inline'",
        "font-src 'self' data:",
        "script-src 'none'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
      ].join('; '),
    );
  }
}
@ApiTags('公开分享访问')
@Throttle({ limit: 60, windowMs: 60_000 })
@Controller('shares')
export class PublicSharesController {
  constructor(private readonly filesService: FilesService) {}

  /** Resolve share metadata by opaque token or multi-segment customPath (e.g. docs/readme). */
  @Get('resolve')
  resolve(@Query('path') path: string): ReturnType<FilesService['getPublicShareInfo']> {
    return this.filesService.getPublicShareInfo(path);
  }

  @Get(':token')
  async get(
    @Param('token') token: string,
    @Query('password') password: string | undefined,
    @Query('ticket') ticket: string | undefined,
    @Query('expires') expires: string | undefined,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    if (this.prefersJson(request)) {
      response.json(await this.filesService.getPublicShareInfo(token));
      return;
    }

    await this.downloadShareFile(token, password, ticket, expires, request, response);
  }

  @Post(':token/download')
  @HttpCode(200)
  async downloadWithPassword(
    @Param('token') token: string,
    @Body('password') password: string | undefined,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const { file, target, watermarkText } = await this.filesService.getShareDownloadTarget(token, password, {
      ip: getClientIp(request),
    });
    await this.writeShareFileResponse(response, file.originalName, file.mimeType, target, 'attachment', {
      watermarkText,
      category: file.category,
      size: Number(file.size),
    });
  }

  @Post(':token/download-session')
  @HttpCode(200)
  createDownloadSession(
    @Param('token') token: string,
    @Body('password') password: string | undefined,
    @Req() request: Request,
  ): ReturnType<FilesService['createShareDownloadSession']> {
    return this.filesService.createShareDownloadSession(token, password, { ip: getClientIp(request) });
  }

  @Get(':token/download')
  async download(
    @Param('token') token: string,
    @Query('password') password: string | undefined,
    @Query('ticket') ticket: string | undefined,
    @Query('expires') expires: string | undefined,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    await this.downloadShareFile(token, password, ticket, expires, request, response);
  }

  private async downloadShareFile(
    token: string,
    password: string | undefined,
    ticket: string | undefined,
    expires: string | undefined,
    request: Request,
    response: Response,
  ): Promise<void> {
    const sessionValid = this.filesService.verifyShareDownloadSession(
      token,
      expires === undefined ? undefined : Number(expires),
      ticket,
    );
    if (!sessionValid && !password && (await this.filesService.shareRequiresPassword(token))) {
      response.redirect(`/shares/${token}`);
      return;
    }
    const { file, target, watermarkText } = await this.filesService.getShareDownloadTarget(token, sessionValid ? undefined : password, {
      ip: getClientIp(request),
      // Ticket path already rate-limited when the session was issued.
      skipPassword: sessionValid,
      skipRateLimit: sessionValid,
    });
    await this.writeShareFileResponse(response, file.originalName, file.mimeType, target, 'attachment', {
      watermarkText,
      category: file.category,
      size: Number(file.size),
    });
  }

  private prefersJson(request: Request): boolean {
    const accept = request.get('accept')?.toLowerCase() ?? '';
    return accept.includes('application/json') || accept.includes('+json');
  }

  @Post(':token/preview')
  @HttpCode(200)
  async previewWithPassword(
    @Param('token') token: string,
    @Body('password') password: string | undefined,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const { file, target, watermarkText } = await this.filesService.getShareDownloadTarget(token, password, {
      countDownload: false,
      ip: getClientIp(request),
    });
    await this.writeShareFileResponse(response, file.originalName, file.mimeType, target, 'inline', {
      watermarkText,
      category: file.category,
      size: Number(file.size),
    });
  }

  private async writeShareFileResponse(
    response: Response,
    filename: string,
    mimeType: string,
    target: Awaited<ReturnType<FilesService['getShareDownloadTarget']>>['target'],
    disposition: 'attachment' | 'inline',
    options: {
      watermarkText?: string | null;
      category?: string;
      size?: number;
      range?: { start: number; end: number; size: number; length: number } | null;
    } = {},
  ): Promise<void> {
    if (target.type === 'redirect' && target.url && !options.range) {
      response.redirect(target.url);
      return;
    }

    if (!target.stream) {
      response.status(404).send('File stream not found.');
      return;
    }

    // Active content (HTML/SVG/XML) is never served inline — the uploader controls
    // mimeType, so an inline HTML/SVG file would run script in this origin. Force it
    // to a download and lock everything else down with a sandboxed, no-script CSP.
    const effectiveDisposition =
      disposition === 'inline' && this.isInlineUnsafeType(mimeType) ? 'attachment' : disposition;

    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'none'",
        "img-src 'self' data: blob:",
        "media-src 'self' data: blob:",
        "style-src 'self' 'unsafe-inline'",
        "font-src 'self' data:",
        "script-src 'none'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
        'sandbox',
      ].join('; '),
    );

    const size = options.size ?? 0;
    applyRangeHeaders(
      response,
      mimeType,
      size,
      options.range ?? null,
      effectiveDisposition,
      filename,
    );

    const onStreamError = (error?: Error): void => {
      if (!response.headersSent) {
        response.status(404).send('File stream not found.');
        return;
      }

      response.destroy(error);
    };

    // Watermark raster images on opt-in shares (skip SVG — it would rasterize and
    // no longer match its Content-Type). Range + watermark is unsupported: full body only.
    const shouldWatermark =
      Boolean(options.watermarkText) &&
      options.category === 'IMAGE' &&
      !this.isInlineUnsafeType(mimeType) &&
      !options.range;

    if (shouldWatermark) {
      const transformer = createWatermarkStream(options.watermarkText as string);
      transformer.once('error', onStreamError);
      target.stream.once('error', onStreamError);
      target.stream.pipe(transformer).pipe(response);
      return;
    }

    pipeStreamToResponse(target.stream as Readable, response, onStreamError);
  }

  private isInlineUnsafeType(mimeType: string): boolean {
    return /(text\/html|xhtml|svg|application\/xml|text\/xml|javascript|ecmascript)/i.test(mimeType);
  }
}
