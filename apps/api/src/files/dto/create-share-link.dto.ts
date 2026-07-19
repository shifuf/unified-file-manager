import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { MIN_PASSWORD_LENGTH } from '../../common/constants';

export class CreateShareLinkDto {
  @ApiPropertyOptional({ description: '访问密码' })
  @IsOptional()
  @IsString()
  @MinLength(MIN_PASSWORD_LENGTH)
  @MaxLength(128)
  password?: string;

  @ApiPropertyOptional({ description: '过期时间' })
  @IsOptional()
  @IsDateString()
  expiresAt?: string;

  @ApiPropertyOptional({ description: '最大下载次数' })
  @IsOptional()
  @IsInt()
  @Min(1)
  maxDownloads?: number;

  @ApiPropertyOptional({ description: '仅允许在线预览，禁止下载' })
  @IsOptional()
  @IsBoolean()
  previewOnly?: boolean;

  @ApiPropertyOptional({ description: '访问 IP 白名单（IP 或 IPv4 CIDR），为空表示不限制', type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  allowedIps?: string[];

  @ApiPropertyOptional({ description: '图片预览/下载叠加的水印文字' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  watermarkText?: string;

  @ApiPropertyOptional({
    description: '自定义分享页路径后缀（如 docs/readme），全局唯一；留空则使用默认 /shares/{token}',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  customPath?: string;
}
