import { Readable } from 'node:stream';

import { DownloadSource } from '@prisma/client';

import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiConsumes, ApiSecurity, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import {
  applyRangeHeaders,
  parseByteRange,
  pipeStreamToResponse,
  writeUnsatisfiableRange,
} from '../common/utils/http-range.util';
import { getClientIp } from '../common/utils/client-ip.util';
import { CreateFolderDto } from '../files/dto/create-folder.dto';
import { DownloadStatsService } from '../files/download-stats.service';
import { FilesService } from '../files/files.service';
import { FolderManagerService } from '../files/folder-manager.service';
import { BatchFileOperationDto } from '../files/dto/batch-file-operation.dto';
import { CreateShareLinkDto } from '../files/dto/create-share-link.dto';
import { UpdateFileDto } from '../files/dto/update-file.dto';
import { UpdateShareLinkDto } from '../files/dto/update-share-link.dto';
import { UploadFilesInterceptor } from '../files/interceptors/upload-files.interceptor';
import { OpenListFilesDto } from './dto/open-list-files.dto';
import { OpenApiGuard } from './open-api.guard';
import type { OpenApiRequest } from './open-api.types';

@ApiTags('开放接口')
@ApiSecurity('AppID')
@ApiSecurity('Signature')
@UseGuards(OpenApiGuard)
@Controller('open/files')
export class OpenApiController {
  constructor(
    private readonly downloadStatsService: DownloadStatsService,
    private readonly filesService: FilesService,
    private readonly folderManagerService: FolderManagerService,
  ) {}

  @Get()
  list(
    @Req() request: OpenApiRequest,
    @Query() query: OpenListFilesDto,
  ): ReturnType<FilesService['listByProject']> {
    return this.filesService.listByProject({
      ...query,
      projectId: request.openProject.id,
    });
  }

  @Get('folders')
  listFolders(@Req() request: OpenApiRequest): ReturnType<FilesService['listFoldersForProject']> {
    return this.filesService.listFoldersForProject(request.openProject.id);
  }

  @Post('folders')
  createFolder(
    @Req() request: OpenApiRequest,
    @Body() dto: CreateFolderDto,
  ): ReturnType<FolderManagerService['createForProject']> {
    return this.folderManagerService.createForProject(request.openProject.id, dto.folderPath);
  }

  @Get('folder-tree')
  folderTree(@Req() request: OpenApiRequest): ReturnType<FilesService['listFolderTreeForProject']> {
    return this.filesService.listFolderTreeForProject(request.openProject.id);
  }

  @Get('search')
  search(
    @Req() request: OpenApiRequest,
    @Query('q') q: string | undefined,
    @Query('page') page: string | undefined,
    @Query('pageSize') pageSize: string | undefined,
  ): ReturnType<FilesService['searchForProject']> {
    return this.filesService.searchForProject(request.openProject.id, q ?? '', {
      page: page === undefined ? undefined : Number(page),
      pageSize: pageSize === undefined ? undefined : Number(pageSize),
    });
  }

  @Get('quota')
  quota(@Req() request: OpenApiRequest): ReturnType<FilesService['getUsageForProject']> {
    return this.filesService.getUsageForProject(request.openProject.id);
  }

  @Post('batch/recycle')
  batchRecycle(
    @Req() request: OpenApiRequest,
    @Body() dto: BatchFileOperationDto,
  ): ReturnType<FilesService['batchRecycleForProject']> {
    return this.filesService.batchRecycleForProject(dto.fileIds, request.openProject.id);
  }

  @Post('batch/restore')
  batchRestore(
    @Req() request: OpenApiRequest,
    @Body() dto: BatchFileOperationDto,
  ): ReturnType<FilesService['batchRestoreForProject']> {
    return this.filesService.batchRestoreForProject(dto.fileIds, request.openProject.id);
  }

  @Post()
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(UploadFilesInterceptor)
  upload(
    @Req() request: OpenApiRequest,
    @Query('folderPath') folderPath: string | undefined,
    @Query('duplicateStrategy') duplicateStrategy: 'reject' | 'reuse' | 'replace' | undefined,
    @Query('targetFileId') targetFileId: string | undefined,
    @UploadedFiles() files: Express.Multer.File[],
  ): ReturnType<FilesService['uploadByCredential']> {
    return this.filesService.uploadByCredential(request.openProject.id, files, {
      duplicateStrategy,
      folderPath,
      targetFileId,
    });
  }

  @Put('shares/:shareId')
  updateShare(
    @Req() request: OpenApiRequest,
    @Param('shareId') shareId: string,
    @Body() dto: UpdateShareLinkDto,
  ): ReturnType<FilesService['updateShareLinkForProject']> {
    return this.filesService.updateShareLinkForProject(shareId, request.openProject.id, dto, this.requestBaseUrl(request));
  }

  @Delete('shares/:shareId')
  disableShare(
    @Req() request: OpenApiRequest,
    @Param('shareId') shareId: string,
  ): ReturnType<FilesService['disableShareLinkForProject']> {
    return this.filesService.disableShareLinkForProject(shareId, request.openProject.id);
  }

  @Get(':fileId')
  get(
    @Req() request: OpenApiRequest,
    @Param('fileId') fileId: string,
  ): ReturnType<FilesService['getForProject']> {
    return this.filesService.getForProject(fileId, request.openProject.id);
  }

  @Put(':fileId')
  update(
    @Req() request: OpenApiRequest,
    @Param('fileId') fileId: string,
    @Body() dto: UpdateFileDto,
  ): ReturnType<FilesService['updateForProject']> {
    return this.filesService.updateForProject(fileId, request.openProject.id, dto);
  }

  @Get(':fileId/download')
  async download(
    @Req() request: OpenApiRequest,
    @Param('fileId') fileId: string,
    @Res() response: Response,
  ): Promise<void> {
    const fileMeta = await this.filesService.getForProject(fileId, request.openProject.id);
    const size = Number(fileMeta.size ?? 0);
    const rangeHeader = typeof request.headers.range === 'string' ? request.headers.range : undefined;
    const parsed = parseByteRange(rangeHeader, size);
    if (parsed === 'unsatisfiable') {
      writeUnsatisfiableRange(response, size);
      return;
    }

    const range =
      parsed && typeof parsed === 'object'
        ? { start: parsed.start, end: parsed.end }
        : undefined;
    const { file, target } = await this.filesService.getDownloadTargetForProject(
      fileId,
      request.openProject.id,
      range,
    );

    this.downloadStatsService.record({
      projectId: file.projectId,
      fileId: file.id,
      originalName: file.originalName,
      bytes: parsed && typeof parsed === 'object' ? parsed.length : size,
      source: DownloadSource.OPEN_API,
      ip: getClientIp(request),
      userAgent: request.get('user-agent') ?? null,
    });

    if (target.type === 'redirect' && target.url && !range) {
      response.redirect(target.url);
      return;
    }

    if (!target.stream) {
      response.status(404).send('File stream not found.');
      return;
    }

    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    applyRangeHeaders(
      response,
      file.mimeType,
      size,
      parsed && typeof parsed === 'object' ? parsed : null,
      'attachment',
      file.originalName,
    );
    pipeStreamToResponse(Readable.from(target.stream), response, (error) => {
      if (!response.headersSent) {
        response.status(404).send('File stream not found.');
        return;
      }
      response.destroy(error);
    });
  }

  @Delete(':fileId')
  recycle(
    @Req() request: OpenApiRequest,
    @Param('fileId') fileId: string,
  ): ReturnType<FilesService['recycleForProject']> {
    return this.filesService.recycleForProject(fileId, request.openProject.id);
  }

  @Post(':fileId/restore')
  restore(
    @Req() request: OpenApiRequest,
    @Param('fileId') fileId: string,
  ): ReturnType<FilesService['restoreForProject']> {
    return this.filesService.restoreForProject(fileId, request.openProject.id);
  }

  @Get(':fileId/versions')
  listVersions(
    @Req() request: OpenApiRequest,
    @Param('fileId') fileId: string,
  ): ReturnType<FilesService['listVersionsForProject']> {
    return this.filesService.listVersionsForProject(fileId, request.openProject.id);
  }

  @Post(':fileId/versions/:version/restore')
  restoreVersion(
    @Req() request: OpenApiRequest,
    @Param('fileId') fileId: string,
    @Param('version') version: string,
  ): ReturnType<FilesService['restoreVersionForProject']> {
    return this.filesService.restoreVersionForProject(
      fileId,
      Number(version),
      request.openProject.id,
    );
  }

  @Get(':fileId/shares')
  listShares(
    @Req() request: OpenApiRequest,
    @Param('fileId') fileId: string,
  ): ReturnType<FilesService['listShareLinksForProject']> {
    return this.filesService.listShareLinksForProject(fileId, request.openProject.id, this.requestBaseUrl(request));
  }

  @Post(':fileId/shares')
  createShare(
    @Req() request: OpenApiRequest,
    @Param('fileId') fileId: string,
    @Body() dto: CreateShareLinkDto,
  ): ReturnType<FilesService['createShareLinkForProject']> {
    return this.filesService.createShareLinkForProject(fileId, request.openProject.id, dto, this.requestBaseUrl(request));
  }

  private requestBaseUrl(request: OpenApiRequest): string {
    return `${request.protocol}://${request.get('host')}`;
  }
}
