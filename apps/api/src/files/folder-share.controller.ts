import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Readable } from 'node:stream';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Throttle } from '../common/guards/throttle.decorator';
import type { RequestUser } from '../common/types/request-user.type';
import { getClientIp } from '../common/utils/client-ip.util';
import {
  applyRangeHeaders,
  getRequestRangeHeader,
  pipeStreamToResponse,
  writeUnsatisfiableRange,
} from '../common/utils/http-range.util';
import { buildRequestPublicBaseUrl } from '../common/utils/origin.util';
import { CreateShareLinkDto } from './dto/create-share-link.dto';
import { DownloadSource } from '@prisma/client';

import { DownloadStatsService } from './download-stats.service';
import { writeDownloadStorageHeader } from '../storage/download-source.util';
import { FolderShareService } from './folder-share.service';

@ApiTags('目录分享')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
export class FolderShareAdminController {
  constructor(private readonly folderShareService: FolderShareService) {}

  @Post('projects/:projectId/folder-shares')
  create(
    @Param('projectId') projectId: string,
    @Body() body: CreateShareLinkDto & { folderPath?: string | null },
    @Req() request: Request,
    @CurrentUser() user: RequestUser,
  ): ReturnType<FolderShareService['create']> {
    const { folderPath, ...dto } = body;
    return this.folderShareService.create(
      projectId,
      folderPath,
      dto,
      user,
      buildRequestPublicBaseUrl(request),
    );
  }

  @Get('projects/:projectId/folder-shares')
  list(
    @Param('projectId') projectId: string,
    @Req() request: Request,
    @CurrentUser() user: RequestUser,
  ): ReturnType<FolderShareService['list']> {
    return this.folderShareService.list(projectId, user, buildRequestPublicBaseUrl(request));
  }

  @Delete('folder-shares/:shareId')
  disable(
    @Param('shareId') shareId: string,
    @CurrentUser() user: RequestUser,
  ): ReturnType<FolderShareService['disable']> {
    return this.folderShareService.disable(shareId, user);
  }
}

@ApiTags('公开目录分享')
@Throttle({ limit: 600, windowMs: 60_000 })
@Controller('folder-shares')
export class PublicFolderSharesController {
  constructor(
    private readonly downloadStatsService: DownloadStatsService,
    private readonly folderShareService: FolderShareService,
  ) {}
  @Get(':token')
  getInfo(@Param('token') token: string): ReturnType<FolderShareService['getPublicInfo']> {
    return this.folderShareService.getPublicInfo(token);
  }

  @Get(':token/files')
  listFiles(
    @Param('token') token: string,
    @Query('password') password: string | undefined,
    @Query('page') page: string | undefined,
    @Query('pageSize') pageSize: string | undefined,
    @Query('q') q: string | undefined,
    @Req() request: Request,
  ): ReturnType<FolderShareService['listPublicFiles']> {
    return this.folderShareService.listPublicFiles(token, password, {
      page: page === undefined ? undefined : Number(page),
      pageSize: pageSize === undefined ? undefined : Number(pageSize),
      keyword: q,
      ip: getClientIp(request),
    });
  }

  @Post(':token/files')
  @HttpCode(200)
  listFilesWithPassword(
    @Param('token') token: string,
    @Body('password') password: string | undefined,
    @Body('page') page: number | undefined,
    @Body('pageSize') pageSize: number | undefined,
    @Body('q') q: string | undefined,
    @Req() request: Request,
  ): ReturnType<FolderShareService['listPublicFiles']> {
    return this.folderShareService.listPublicFiles(token, password, {
      page,
      pageSize,
      keyword: q,
      ip: getClientIp(request),
    });
  }

  @Post(':token/files/:fileId/download')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async download(
    @Param('token') token: string,
    @Param('fileId') fileId: string,
    @Body('password') password: string | undefined,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    await this.downloadFile(token, fileId, password, undefined, undefined, request, response);
  }

  @Get(':token/files/:fileId/download')
  async getDownload(
    @Param('token') token: string,
    @Param('fileId') fileId: string,
    @Query('password') password: string | undefined,
    @Query('ticket') ticket: string | undefined,
    @Query('expires') expires: string | undefined,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    await this.downloadFile(token, fileId, password, ticket, expires, request, response);
  }

  @Post(':token/files/:fileId/download-session')
  @HttpCode(200)
  createDownloadSession(
    @Param('token') token: string,
    @Param('fileId') fileId: string,
    @Body('password') password: string | undefined,
    @Req() request: Request,
  ): ReturnType<FolderShareService['createDownloadSession']> {
    return this.folderShareService.createDownloadSession(token, fileId, password, { ip: getClientIp(request) });
  }

  private async downloadFile(token: string, fileId: string, password: string | undefined, ticket: string | undefined, expires: string | undefined, request: Request, response: Response): Promise<void> {
    const clientIp = getClientIp(request);
    const head = request.method === 'HEAD';
    const { file, shareId, target, range, unsatisfiable, recordDownload } = await this.folderShareService.getFileDownloadTarget(token, fileId, password, {
      ip: clientIp, head, rangeHeader: getRequestRangeHeader(request),
      ticket, expires: expires === undefined ? undefined : Number(expires),
    });
    const size = Number(file.size ?? 0);
    if (unsatisfiable) {
      writeUnsatisfiableRange(response, size);
      return;
    }

    response.setHeader('Cache-Control', 'no-store');
    if (head) {
      applyRangeHeaders(response, file.mimeType, size, range, 'attachment', file.originalName);
      response.end(); return;
    }
    if (!target.stream) {
      response.status(404).send('File stream not found.');
      return;
    }
    if (recordDownload !== false) this.downloadStatsService.record({
      projectId: file.projectId,
      fileId: file.id,
      originalName: file.originalName,
      bytes: range?.length ?? size,
      source: DownloadSource.FOLDER_SHARE,
      shareId,
      storageSource: target.storageSource,
      ip: clientIp,
      userAgent: request.get('user-agent') ?? null,
      rangeStart: range?.start ?? null,
      rangeEnd: range?.end ?? null,
    });
    writeDownloadStorageHeader(response, target.storageSource);
    applyRangeHeaders(
      response,
      file.mimeType,
      size,
      range,
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
}
