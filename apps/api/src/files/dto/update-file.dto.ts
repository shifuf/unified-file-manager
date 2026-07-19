import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateFileDto {
  @ApiPropertyOptional({ description: '展示文件名' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  originalName?: string;

  @ApiPropertyOptional({ description: '备注' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  remark?: string;

  @ApiPropertyOptional({ type: [String], description: '标签' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  tags?: string[];

  @ApiPropertyOptional({ description: '虚拟目录' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  folderPath?: string;

  @ApiPropertyOptional({ description: '是否公开（公共库/无签名直链）' })
  @Transform(({ value }) => {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (['true', '1', 'yes', 'on'].includes(normalized)) {
        return true;
      }
      if (['false', '0', 'no', 'off'].includes(normalized)) {
        return false;
      }
    }
    return value;
  })
  @IsOptional()
  @IsBoolean()
  isPublic?: boolean;
}
