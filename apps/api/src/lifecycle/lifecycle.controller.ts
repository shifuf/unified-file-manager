import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { FileCategory } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { RequestUser } from '../common/types/request-user.type';
import { LifecycleService } from './lifecycle.service';

class CreateLifecycleDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(512)
  folderPath?: string | null;

  @ApiPropertyOptional({ enum: FileCategory })
  @IsOptional()
  @IsEnum(FileCategory)
  category?: FileCategory | null;

  @ApiProperty()
  @IsInt()
  @Min(1)
  ttlDays!: number;

  @ApiProperty({ enum: ['RECYCLE', 'PURGE'] })
  @IsIn(['RECYCLE', 'PURGE'])
  action!: 'RECYCLE' | 'PURGE';

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

@ApiTags('生命周期策略')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('projects/:projectId/lifecycle-policies')
export class LifecycleController {
  constructor(private readonly lifecycleService: LifecycleService) {}

  @Get()
  list(
    @Param('projectId') projectId: string,
    @CurrentUser() user: RequestUser,
  ): ReturnType<LifecycleService['list']> {
    return this.lifecycleService.list(projectId, user);
  }

  @Post()
  create(
    @Param('projectId') projectId: string,
    @Body() dto: CreateLifecycleDto,
    @CurrentUser() user: RequestUser,
  ): ReturnType<LifecycleService['create']> {
    return this.lifecycleService.create(projectId, dto, user);
  }

  @Delete(':policyId')
  remove(
    @Param('projectId') projectId: string,
    @Param('policyId') policyId: string,
    @CurrentUser() user: RequestUser,
  ): ReturnType<LifecycleService['remove']> {
    return this.lifecycleService.remove(projectId, policyId, user);
  }

  @Post(':policyId/run')
  run(
    @Param('projectId') projectId: string,
    @Param('policyId') policyId: string,
    @CurrentUser() user: RequestUser,
  ): ReturnType<LifecycleService['run']> {
    return this.lifecycleService.run(projectId, policyId, user);
  }
}
