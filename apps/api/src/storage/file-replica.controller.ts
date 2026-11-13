import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsString, MaxLength } from 'class-validator';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { RequestUser } from '../common/types/request-user.type';
import { FileReplicaService } from './file-replica.service';

class SyncFileReplicasDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @IsString({ each: true }) @MaxLength(128, { each: true })
  configIds!: string[];
}

@ApiTags('文件存储副本')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('files')
export class FileReplicaController {
  constructor(private readonly replicas: FileReplicaService) {}

  @Get('storage-replicas')
  list(@Query('fileIds') fileIds: string, @CurrentUser() user: RequestUser) {
    return this.replicas.list(fileIds, user);
  }

  @Get(':fileId/storage-replicas')
  get(@Param('fileId') fileId: string, @CurrentUser() user: RequestUser) {
    return this.replicas.get(fileId, user);
  }

  @Post(':fileId/storage-replicas/sync')
  sync(@Param('fileId') fileId: string, @Body() body: SyncFileReplicasDto, @CurrentUser() user: RequestUser) {
    return this.replicas.sync(fileId, body.configIds, user);
  }
}
