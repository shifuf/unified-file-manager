import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateBackupDto {
  @ApiPropertyOptional({ description: '备份名称，留空按时间自动命名', example: '发布前全量备份' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  name?: string;

  @ApiPropertyOptional({
    description: '要备份的数据范围（不传=全部）：projects / storage / shares / credentials / automation / users / settings / security / analytics / openapi',
    isArray: true,
    example: ['projects', 'storage', 'shares'],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  scopes?: string[];

  @ApiPropertyOptional({
    description: '是否把本地存储(LOCAL)的文件内容一起打包（体积大，受 BACKUP_MAX_OBJECT_BYTES 限制）',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  includeObjects?: boolean;

  @ApiPropertyOptional({ description: '上传目标存储配置，留空仅保存在本地' })
  @IsOptional()
  @IsString()
  @MaxLength(191)
  storageConfigId?: string;

  @ApiPropertyOptional({ description: '云端确认后是否继续保留本地副本', default: true })
  @IsOptional()
  @IsBoolean()
  retainLocal?: boolean;
}
