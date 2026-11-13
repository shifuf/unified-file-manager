import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { RequestUser } from '../common/types/request-user.type';
import { ProjectAccessService } from '../projects/project-access.service';
import { ReplicaService } from './replica.service';

class ReplicaBatchDto {
  @IsOptional() @IsString() @MaxLength(128) cursor?: string;
  @IsOptional() @IsInt() @Min(1) @Max(50) limit?: number;
}

@ApiTags('存储副本')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('projects/:projectId/storage/replicas')
export class ReplicaController {
  constructor(private readonly access: ProjectAccessService, private readonly replicas: ReplicaService) {}

  @Get()
  async list(@Param('projectId') projectId: string, @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined, @CurrentUser() user: RequestUser,
    @Query('page') page?: string, @Query('pageSize') pageSize?: string): Promise<Record<string, unknown>> {
    await this.access.assertProjectAccess(user, projectId);
    const pagination = page !== undefined || pageSize !== undefined || (cursor === undefined && limit === undefined)
      ? { page, pageSize } : undefined;
    return this.replicas.listProject(projectId, cursor, Number(limit) || 100, pagination);
  }

  @Post('sync')
  async sync(@Param('projectId') projectId: string, @Body() body: ReplicaBatchDto, @CurrentUser() user: RequestUser): Promise<Record<string, unknown>> {
    await this.access.assertProjectAccess(user, projectId, true);
    const result = await this.replicas.ensureProjectReplicas(projectId, body.cursor, body.limit);
    if (typeof result.nextCursor === 'string') return { ...result, ...await this.replicas.enqueueProject(projectId, result.nextCursor) };
    return result;
  }

  @Post('inspect')
  async inspect(@Param('projectId') projectId: string, @Body() body: ReplicaBatchDto, @CurrentUser() user: RequestUser): Promise<Record<string, unknown>> {
    await this.access.assertProjectAccess(user, projectId, true);
    return this.replicas.inspectProject(projectId, body.cursor, body.limit);
  }

  @Post('retry')
  async retry(@Param('projectId') projectId: string, @CurrentUser() user: RequestUser): Promise<{ queued: number }> {
    await this.access.assertProjectAccess(user, projectId, true);
    return this.replicas.retryProject(projectId);
  }
}
