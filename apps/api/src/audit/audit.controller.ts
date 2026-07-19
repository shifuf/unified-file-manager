import { Body, Controller, Get, Post, Query, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { RequestUser } from '../common/types/request-user.type';
import { AuditService } from './audit.service';
import { CleanupAuditLogsDto } from './dto/cleanup-audit-logs.dto';
import { ListAuditLogsDto } from './dto/list-audit-logs.dto';

@ApiTags('日志审计')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('audit-logs')
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get()
  list(@Query() query: ListAuditLogsDto): ReturnType<AuditService['list']> {
    return this.auditService.list(query);
  }

  @Get('export')
  async export(
    @Query() query: ListAuditLogsDto & { format?: 'csv' | 'json' },
    @CurrentUser() user: RequestUser,
    @Res() response: Response,
  ): Promise<void> {
    const result = await this.auditService.export(
      {
        format: query.format === 'csv' ? 'csv' : 'json',
        projectId: query.projectId,
        action: query.action,
        keyword: query.keyword,
        startAt: query.startAt,
        endAt: query.endAt,
      },
      user.id,
    );
    response.setHeader('Content-Type', result.contentType);
    response.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    response.send(result.body);
  }

  @Post('cleanup')
  cleanup(
    @Body() dto: CleanupAuditLogsDto,
    @CurrentUser() user: RequestUser,
  ): ReturnType<AuditService['cleanup']> {
    return this.auditService.cleanup(dto, user.id);
  }
}
