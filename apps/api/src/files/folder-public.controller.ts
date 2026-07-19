import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { RequestUser } from '../common/types/request-user.type';
import {
  BatchPublishFolderDto,
  RemoveFolderPublicDto,
  UpsertFolderPublicDto,
} from './dto/folder-public.dto';
import { FolderPublicService } from './folder-public.service';

@ApiTags('文件夹公开策略')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
export class FolderPublicController {
  constructor(private readonly folderPublicService: FolderPublicService) {}

  @Get('projects/:projectId/folder-public')
  list(
    @Param('projectId') projectId: string,
    @CurrentUser() user: RequestUser,
  ): ReturnType<FolderPublicService['list']> {
    return this.folderPublicService.list(projectId, user);
  }

  @Put('projects/:projectId/folder-public')
  upsert(
    @Param('projectId') projectId: string,
    @Body() dto: UpsertFolderPublicDto,
    @CurrentUser() user: RequestUser,
  ): ReturnType<FolderPublicService['upsert']> {
    return this.folderPublicService.upsert(projectId, dto, user);
  }

  @Delete('projects/:projectId/folder-public')
  remove(
    @Param('projectId') projectId: string,
    @Body() dto: RemoveFolderPublicDto,
    @CurrentUser() user: RequestUser,
  ): ReturnType<FolderPublicService['remove']> {
    return this.folderPublicService.remove(projectId, dto.folderPath, user);
  }

  @Post('projects/:projectId/folder-public/batch-publish')
  batchPublish(
    @Param('projectId') projectId: string,
    @Body() dto: BatchPublishFolderDto,
    @CurrentUser() user: RequestUser,
  ): ReturnType<FolderPublicService['batchPublish']> {
    return this.folderPublicService.batchPublish(projectId, dto, user);
  }
}
