import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsOptional, IsString } from 'class-validator';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { RequestUser } from '../common/types/request-user.type';
import { NotificationsService } from './notifications.service';

class MarkReadDto {
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  ids?: string[];

  @IsOptional()
  @IsBoolean()
  all?: boolean;
}

@ApiTags('站内通知')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get()
  list(
    @CurrentUser() user: RequestUser,
    @Query('unreadOnly') unreadOnly?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ): ReturnType<NotificationsService['list']> {
    return this.notificationsService.list(user.id, {
      unreadOnly: unreadOnly === '1' || unreadOnly === 'true',
      page: page === undefined ? undefined : Number(page),
      pageSize: pageSize === undefined ? undefined : Number(pageSize),
    });
  }

  @Get('unread-count')
  unreadCount(@CurrentUser() user: RequestUser): ReturnType<NotificationsService['unreadCount']> {
    return this.notificationsService.unreadCount(user.id);
  }

  @Post('read')
  markRead(
    @CurrentUser() user: RequestUser,
    @Body() dto: MarkReadDto,
  ): ReturnType<NotificationsService['markRead']> {
    return this.notificationsService.markRead(user.id, dto);
  }
}
