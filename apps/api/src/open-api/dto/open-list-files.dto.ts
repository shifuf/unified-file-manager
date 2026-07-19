import { ApiPropertyOptional } from '@nestjs/swagger';
import { FileCategory, FileStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

function emptyStringToUndefined(value: unknown): unknown {
  return value === '' ? undefined : value;
}

export class OpenListFilesDto {
  @ApiPropertyOptional({ description: '文件名关键词' })
  @Transform(({ value }) => emptyStringToUndefined(value))
  @IsOptional()
  @IsString()
  keyword?: string;

  @ApiPropertyOptional({ enum: FileCategory })
  @Transform(({ value }) => emptyStringToUndefined(value))
  @IsOptional()
  @IsEnum(FileCategory)
  category?: FileCategory;

  @ApiPropertyOptional({ description: '标签过滤' })
  @Transform(({ value }) => emptyStringToUndefined(value))
  @IsOptional()
  @IsString()
  tag?: string;

  @ApiPropertyOptional({ description: '虚拟目录路径，空字符串表示根目录' })
  @Transform(({ value }) => (value === undefined ? undefined : String(value)))
  @IsOptional()
  @IsString()
  folderPath?: string;

  @ApiPropertyOptional({ description: '文件扩展名，不需要点号' })
  @Transform(({ value }) => emptyStringToUndefined(value))
  @IsOptional()
  @IsString()
  extension?: string;

  @ApiPropertyOptional({ description: '只返回重复文件' })
  @Transform(({ value }) => value === true || value === 'true')
  @IsOptional()
  @IsBoolean()
  duplicateOnly?: boolean;

  @ApiPropertyOptional({ enum: FileStatus, default: FileStatus.ACTIVE })
  @Transform(({ value }) => emptyStringToUndefined(value))
  @IsOptional()
  @IsEnum(FileStatus)
  status?: FileStatus = FileStatus.ACTIVE;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number = 20;
}
