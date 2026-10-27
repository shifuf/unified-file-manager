import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { RequestUser } from '../common/types/request-user.type';
import { ProjectAccessService } from '../projects/project-access.service';
import { DownloadStatsService, DOWNLOAD_SOURCE_LABELS } from './download-stats.service';
import type { DownloadSourceValue } from './download-stats.types';

const VALID_SOURCES = new Set(Object.keys(DOWNLOAD_SOURCE_LABELS));

@ApiTags('下载流量统计')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
export class DownloadStatsController {
  constructor(
    private readonly projectAccessService: ProjectAccessService,
    private readonly statsService: DownloadStatsService,
  ) {}

  @Get('projects/:projectId/download-stats/summary')
  async summary(
    @Param('projectId') projectId: string,
    @Query('days') days: string | undefined,
    @Query('source') source: string | undefined,
    @Query('fileId') fileId: string | undefined,
    @CurrentUser() user: RequestUser,
  ): Promise<Record<string, unknown>> {
    await this.projectAccessService.assertProjectAccess(user, projectId);
    const summary = await this.statsService.summary({
      projectId,
      ...this.parseRange(days),
      ...(source && VALID_SOURCES.has(source) ? { source: source as DownloadSourceValue } : {}),
      ...(fileId ? { fileId } : {}),
    });

    return {
      ...summary,
      labels: DOWNLOAD_SOURCE_LABELS,
      days: Number(days) > 0 ? Number(days) : 30,
    };
  }

  @Get('projects/:projectId/download-stats')
  async list(
    @Param('projectId') projectId: string,
    @Query('page') page: string | undefined,
    @Query('pageSize') pageSize: string | undefined,
    @Query('days') days: string | undefined,
    @Query('source') source: string | undefined,
    @Query('fileId') fileId: string | undefined,
    @CurrentUser() user: RequestUser,
  ): Promise<Record<string, unknown>> {
    await this.projectAccessService.assertProjectAccess(user, projectId);
    const result = await this.statsService.list(
      {
        projectId,
        ...this.parseRange(days),
        ...(source && VALID_SOURCES.has(source) ? { source: source as DownloadSourceValue } : {}),
        ...(fileId ? { fileId } : {}),
      },
      Number(page) || 1,
      Number(pageSize) || 20,
    );

    return { ...result, labels: DOWNLOAD_SOURCE_LABELS };
  }

  private parseRange(days?: string): { from?: Date; to?: Date } {
    const value = Number(days);
    if (!Number.isFinite(value) || value <= 0) {
      return {};
    }
    const from = new Date();
    from.setUTCHours(0, 0, 0, 0);
    from.setUTCDate(from.getUTCDate() - (Math.min(365, Math.floor(value)) - 1));
    return { from, to: new Date() };
  }
}
