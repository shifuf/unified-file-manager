import { ApiPropertyOptional } from '@nestjs/swagger';
import { AuditAction } from '@prisma/client';
import { IsBoolean, IsDateString, IsEnum, IsOptional, IsString } from 'class-validator';

export class CleanupAuditLogsDto {
  @ApiPropertyOptional({ description: '只清理早于该时间的日志，必须包含时区' })
  @IsOptional()
  @IsDateString()
  beforeAt?: string;

  @ApiPropertyOptional({ description: '明确清理全部匹配日志，无需截止时间' })
  @IsOptional()
  @IsBoolean()
  all?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  projectId?: string;

  @ApiPropertyOptional({ enum: AuditAction })
  @IsOptional()
  @IsEnum(AuditAction)
  action?: AuditAction;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  keyword?: string;
}
