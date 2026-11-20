import { Body, Controller, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { RequestUser } from '../common/types/request-user.type';
import { StorageProjectSyncDto } from './dto/storage-project-sync.dto';
import { StorageProjectSyncService, type StorageProjectSyncResult } from './storage-project-sync.service';

@ApiTags('存储配置')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('storage-configs/:configId/project-sync')
export class StorageProjectSyncController {
  constructor(private readonly sync: StorageProjectSyncService) {}

  @Post()
  @HttpCode(202)
  enqueue(@Param('configId') configId: string, @Body() dto: StorageProjectSyncDto, @CurrentUser() user: RequestUser): Promise<StorageProjectSyncResult> {
    return this.sync.enqueue(configId, dto.projectIds, user);
  }
}
