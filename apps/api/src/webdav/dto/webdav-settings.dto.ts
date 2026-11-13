import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class UpdateWebdavSettingsDto {
  @ApiPropertyOptional({ description: 'DAV 地址后缀，英文或数字；空白随机生成' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(/^\s*[A-Za-z0-9]*\s*$/, { message: 'DAV 地址后缀仅支持英文字母或数字。' })
  slug?: string | null;

  @ApiPropertyOptional({ description: '是否启用该项目的 WebDAV 入口' })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ description: 'WebDAV 登录用户名（1-64 字符）' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  username?: string | null;

  @ApiPropertyOptional({ description: 'WebDAV 登录密码（8-128 字符）' })
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password?: string | null;
}

export class WebdavStatusResponseDto {
  @ApiProperty({ nullable: true })
  slug!: string | null;

  @ApiProperty()
  projectId!: string;

  @ApiProperty()
  enabled!: boolean;

  @ApiProperty({ nullable: true })
  username!: string | null;

  @ApiProperty()
  hasPassword!: boolean;

  @ApiProperty({ description: 'WebDAV 挂载地址（不含账号密码）' })
  baseUrl!: string;
}
