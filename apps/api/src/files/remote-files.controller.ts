import { pipeline } from 'node:stream/promises';
import { Body, Controller, Get, Header, HttpCode, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { RequestUser } from '../common/types/request-user.type';
import { ImportRemoteFilesDto, ListRemoteFilesDto } from './dto/remote-files.dto';
import { RemoteFilesService, type RemoteFileDownload } from './remote-files.service';

@ApiTags('云端文件')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('storage-configs/:configId/remote-files')
export class RemoteFilesController {
  constructor(private readonly remoteFilesService: RemoteFilesService) {}

  @Get()
  list(@Param('configId') configId: string, @Query() query: ListRemoteFilesDto, @CurrentUser() user: RequestUser): ReturnType<RemoteFilesService['list']> {
    return this.remoteFilesService.list(configId, query, user);
  }

  @Post('import')
  import(@Param('configId') configId: string, @Body() dto: ImportRemoteFilesDto, @CurrentUser() user: RequestUser): ReturnType<RemoteFilesService['import']> {
    return this.remoteFilesService.import(configId, dto, user);
  }

  @Post('import-jobs')
  @HttpCode(202)
  startImport(@Param('configId') configId: string, @Body() dto: ImportRemoteFilesDto, @CurrentUser() user: RequestUser): ReturnType<RemoteFilesService['startImportJob']> {
    return this.remoteFilesService.startImportJob(configId, dto, user);
  }

  @Post(':fileId/download-jobs')
  @HttpCode(202)
  startDownload(@Param('configId') configId: string, @Param('fileId') fileId: string, @CurrentUser() user: RequestUser): ReturnType<RemoteFilesService['startDownloadJob']> {
    return this.remoteFilesService.startDownloadJob(configId, fileId, user);
  }

  @Get('jobs/:jobId')
  @Header('Cache-Control', 'no-store')
  job(@Param('configId') configId: string, @Param('jobId') jobId: string, @CurrentUser() user: RequestUser): ReturnType<RemoteFilesService['getJob']> {
    return this.remoteFilesService.getJob(configId, jobId, user);
  }

  @Get('jobs/:jobId/download')
  async preparedDownload(@Param('configId') configId: string, @Param('jobId') jobId: string, @CurrentUser() user: RequestUser, @Res() response: Response): Promise<void> {
    await this.send(await this.remoteFilesService.takeDownload(configId, jobId, user), response);
  }

  @Get(':fileId/download')
  async download(@Param('configId') configId: string, @Param('fileId') fileId: string, @CurrentUser() user: RequestUser, @Res() response: Response): Promise<void> {
    const file = await this.remoteFilesService.download(configId, fileId, user);
    await this.send(file, response);
  }

  private async send(file: RemoteFileDownload, response: Response): Promise<void> {
    try {
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Content-Type', file.mimeType);
      response.setHeader('Content-Length', String(file.size));
      response.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.name).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`);
      await pipeline(file.stream, response);
    } finally { await file.cleanup(); }
  }
}
