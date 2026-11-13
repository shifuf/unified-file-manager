import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { RequestUser } from '../common/types/request-user.type';
import { DashboardService } from './dashboard.service';

@ApiTags('系统概览')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('summary')
  summary(@CurrentUser() user: RequestUser) {
    return this.dashboardService.summary(user);
  }

  @Get('trends')
  trends(@Query('days') days: string | undefined, @CurrentUser() user: RequestUser) {
    return this.dashboardService.trends(days, user);
  }

  @Get('storage')
  storage(
    @Query('page') page: string | undefined,
    @Query('pageSize') pageSize: string | undefined,
    @CurrentUser() user: RequestUser,
  ) {
    return this.dashboardService.storage({ page, pageSize }, user);
  }

  @Get('activity')
  activity(
    @Query('page') page: string | undefined,
    @Query('pageSize') pageSize: string | undefined,
    @CurrentUser() user: RequestUser,
  ) {
    return this.dashboardService.activity({ page, pageSize }, user);
  }
}
