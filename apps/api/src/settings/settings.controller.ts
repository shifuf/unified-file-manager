import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { RequestUser } from '../common/types/request-user.type';
import { NotifyService } from '../notify/notify.service';
import { UpdateSettingDto } from './dto/update-setting.dto';
import { SettingsService } from './settings.service';

class UpdateNotifySettingsDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  baseUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  apiKey?: string;

  @IsOptional()
  @IsBoolean()
  clearApiKey?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  events?: string[];
}

@ApiTags('系统设置')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
export class SettingsController {
  constructor(
    private readonly notifyService: NotifyService,
    private readonly settingsService: SettingsService,
  ) {}

  @Get('settings')
  list(): ReturnType<SettingsService['list']> {
    return this.settingsService.list();
  }

  @Post('settings')
  update(
    @Body() dto: UpdateSettingDto,
    @CurrentUser() user: RequestUser,
  ): ReturnType<SettingsService['update']> {
    return this.settingsService.update(dto, user);
  }

  @Get('settings/notify')
  getNotify(): ReturnType<NotifyService['getPublicSettings']> {
    return this.notifyService.getPublicSettings();
  }

  @Post('settings/notify')
  updateNotify(
    @Body() dto: UpdateNotifySettingsDto,
    @CurrentUser() user: RequestUser,
  ): ReturnType<NotifyService['updateSettings']> {
    return this.notifyService.updateSettings({ ...dto, actorId: user.id });
  }

  @Post('settings/notify/test')
  testNotify(@CurrentUser() user: RequestUser): ReturnType<NotifyService['test']> {
    return this.notifyService.test(user.id);
  }

  @Get('system/health')
  health(@CurrentUser() user: RequestUser): ReturnType<SettingsService['health']> {
    return this.settingsService.health(user);
  }
}
