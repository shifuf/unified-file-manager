import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { RequestUser } from '../common/types/request-user.type';
import { ShareIpAbuseService } from './share-ip-abuse.service';

class BanShareIpDto {
  @IsString()
  @MaxLength(64)
  ip!: string;

  @IsOptional()
  @IsBoolean()
  permanent?: boolean;

  /** Temporary ban duration in minutes (ignored when permanent). Default 60. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(60 * 24 * 365)
  minutes?: number;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  reason?: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  notes?: string;
}

class UnbanShareIpDto {
  @IsString()
  @MaxLength(64)
  ip!: string;
}

@ApiTags('分享 IP 防刷')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('admin/share-ip-stats')
export class ShareIpAbuseController {
  constructor(private readonly shareIpAbuseService: ShareIpAbuseService) {}

  @Get()
  list(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('keyword') keyword?: string,
    @Query('bannedOnly') bannedOnly?: string,
  ): ReturnType<ShareIpAbuseService['list']> {
    return this.shareIpAbuseService.list({
      page: page === undefined ? undefined : Number(page),
      pageSize: pageSize === undefined ? undefined : Number(pageSize),
      keyword,
      bannedOnly: bannedOnly === '1' || bannedOnly === 'true',
    });
  }

  @Post('ban')
  ban(@Body() body: BanShareIpDto, @CurrentUser() user: RequestUser): ReturnType<ShareIpAbuseService['ban']> {
    return this.shareIpAbuseService.ban(body.ip, {
      permanent: body.permanent,
      minutes: body.minutes,
      reason: body.reason,
      notes: body.notes,
      actor: user,
    });
  }

  @Post('unban')
  unban(
    @Body() body: UnbanShareIpDto,
    @CurrentUser() user: RequestUser,
  ): ReturnType<ShareIpAbuseService['unban']> {
    return this.shareIpAbuseService.unban(body.ip, user);
  }
}
