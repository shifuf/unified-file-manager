import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { RequestUser } from '../common/types/request-user.type';
import { WebhooksService } from './webhooks.service';

class UpsertWebhookDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  name!: string;

  @ApiProperty()
  @IsString()
  @MinLength(8)
  @MaxLength(1024)
  url!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  secret?: string | null;

  @ApiProperty({ type: [String] })
  @IsArray()
  @IsString({ each: true })
  events!: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  projectId?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

@ApiTags('出站 Webhook')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooksService: WebhooksService) {}

  @Get()
  list(
    @Query('projectId') projectId: string | undefined,
    @CurrentUser() user: RequestUser,
  ): ReturnType<WebhooksService['list']> {
    return this.webhooksService.list(user, projectId);
  }

  @Post()
  create(
    @Body() dto: UpsertWebhookDto,
    @CurrentUser() user: RequestUser,
  ): ReturnType<WebhooksService['create']> {
    return this.webhooksService.create(dto, user);
  }

  @Put(':id')
  update(
    @Param('id') id: string,
    @Body() dto: Partial<UpsertWebhookDto>,
    @CurrentUser() user: RequestUser,
  ): ReturnType<WebhooksService['update']> {
    return this.webhooksService.update(id, dto, user);
  }

  @Delete(':id')
  remove(
    @Param('id') id: string,
    @CurrentUser() user: RequestUser,
  ): ReturnType<WebhooksService['remove']> {
    return this.webhooksService.remove(id, user);
  }

  @Post(':id/test')
  test(
    @Param('id') id: string,
    @CurrentUser() user: RequestUser,
  ): ReturnType<WebhooksService['test']> {
    return this.webhooksService.test(id, user);
  }

  @Get(':id/deliveries')
  deliveries(
    @Param('id') id: string,
    @Query('page') page: string | undefined,
    @Query('pageSize') pageSize: string | undefined,
    @CurrentUser() user: RequestUser,
  ): ReturnType<WebhooksService['listDeliveries']> {
    return this.webhooksService.listDeliveries(
      id,
      user,
      page === undefined ? 1 : Number(page),
      pageSize === undefined ? 20 : Number(pageSize),
    );
  }
}
