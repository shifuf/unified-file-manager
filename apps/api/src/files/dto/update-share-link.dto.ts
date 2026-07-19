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

export class UpdateShareLinkDto {
  @ApiPropertyOptional({ description: '新访问密码，不传则保持原密码' })
  @IsOptional()
  @IsString()
  @MinLength(MIN_PASSWORD_LENGTH)
  @MaxLength(128)
  password?: string;

  @ApiPropertyOptional({ description: '是否清除访问密码' })
  @IsOptional()
  @IsBoolean()
  clearPassword?: boolean;

  @ApiPropertyOptional({ description: '过期时间，传 null 表示不限制' })
  @IsOptional()
  @IsDateString()
  expiresAt?: string | null;

  @ApiPropertyOptional({ description: '最大下载次数，传 null 表示不限制' })
  @IsOptional()
  @IsInt()
  @Min(1)
  maxDownloads?: number | null;

  @ApiPropertyOptional({ description: '是否启用分享链接' })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ description: '仅允许在线预览，禁止下载' })
  @IsOptional()
  @IsBoolean()
  previewOnly?: boolean;

  @ApiPropertyOptional({ description: '访问 IP 白名单（IP 或 IPv4 CIDR），传空数组表示清除', type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  allowedIps?: string[];

  @ApiPropertyOptional({ description: '图片水印文字，传空字符串表示清除' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  watermarkText?: string;

  @ApiPropertyOptional({
    description: '自定义分享页路径后缀（如 docs/readme），全局唯一；传空字符串表示清除',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  customPath?: string | null;
}
