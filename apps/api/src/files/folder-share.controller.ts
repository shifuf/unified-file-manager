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
  parseByteRange,
  pipeStreamToResponse,
  writeUnsatisfiableRange,
} from '../common/utils/http-range.util';
import { buildRequestPublicBaseUrl } from '../common/utils/origin.util';
import { CreateShareLinkDto } from './dto/create-share-link.dto';
import { DownloadSource } from '@prisma/client';

import { DownloadStatsService } from './download-stats.service';
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
    const clientIp = getClientIp(request);
    const meta = await this.folderShareService.getFileDownloadTarget(token, fileId, password, {
      ip: clientIp,
    });
    const size = Number(meta.file.size ?? 0);
    const parsed = parseByteRange(getRequestRangeHeader(request), size);
    if (parsed === 'unsatisfiable') {
      writeUnsatisfiableRange(response, size);
      return;
    }

    // Re-fetch with range when seeking — do not double-count download / rate limit.
    const { file, target } =
      parsed && typeof parsed === 'object'
        ? await this.folderShareService.getFileDownloadTarget(token, fileId, password, {
            ip: clientIp,
            range: { start: parsed.start, end: parsed.end },
            skipCount: true,
          })
        : meta;
    // Share downloads always stream via API (preferRedirect:false) so rate limits apply.
    if (target.type === 'redirect' && target.url && !(parsed && typeof parsed === 'object')) {
      response.redirect(target.url);
      return;
    }
    if (!target.stream) {
      response.status(404).send('File stream not found.');
      return;
    }
    this.downloadStatsService.record({
      projectId: file.projectId,
      fileId: file.id,
      originalName: file.originalName,
      bytes: parsed && typeof parsed === 'object' ? parsed.length : size,
      source: DownloadSource.FOLDER_SHARE,
      ip: clientIp,
      userAgent: request.get('user-agent') ?? null,
    });
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
}
