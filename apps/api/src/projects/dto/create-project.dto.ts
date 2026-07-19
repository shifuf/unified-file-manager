import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateProjectDto {
  @ApiProperty({ example: '支付中心' })
  @IsString()
  @MinLength(2)
  @MaxLength(128)
  name!: string;

  @ApiPropertyOptional({ example: '统一管理支付中心的合同、凭证与静态资源。' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  description?: string;

  @ApiPropertyOptional({ example: ['files.example.com', '*.example.com'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allowedDomains?: string[];

  @ApiPropertyOptional({ description: '是否接收系统通知（消息通知平台）' })
  @IsOptional()
  @IsBoolean()
  notifyEnabled?: boolean;

  @ApiPropertyOptional({ description: '是否启用公开资源库' })
  @IsOptional()
  @IsBoolean()
  publicLibraryEnabled?: boolean;

  @ApiPropertyOptional({ description: '公开资源库 slug，仅字母数字与连字符' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/i, { message: '公开资源库标识格式无效。' })
  publicLibrarySlug?: string;

  @ApiPropertyOptional({ description: '项目存储配额（字节），空表示不限制' })
  @IsOptional()
  @IsInt()
  @Min(0)
  quotaBytes?: number | null;

  @ApiPropertyOptional({ description: '项目文件数量配额，空表示不限制' })
  @IsOptional()
  @IsInt()
  @Min(0)
  quotaFiles?: number | null;
}
