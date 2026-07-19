import { ApiPropertyOptional } from '@nestjs/swagger';
import { CdnProvider, FileCategory, FileStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsDateString, IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

function emptyStringToUndefined(value: unknown): unknown {
  return value === '' ? undefined : value;
}

function optionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === '') {
    return undefined;
  }

  return value === true || value === 'true';
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === '') {
    return undefined;
  }

  return Number(value);
}

export class ListFilesDto {
  @ApiPropertyOptional({ description: '项目 ID，不传时返回当前账号可访问的全部项目文件' })
  @Transform(({ value }) => emptyStringToUndefined(value))
  @IsOptional()
  @IsString()
  projectId?: string;

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

  @ApiPropertyOptional({ enum: FileStatus, default: FileStatus.ACTIVE })
  @Transform(({ value }) => emptyStringToUndefined(value))
  @IsOptional()
  @IsEnum(FileStatus)
  status?: FileStatus = FileStatus.ACTIVE;

  @ApiPropertyOptional({ description: '标签关键词' })
  @Transform(({ value }) => emptyStringToUndefined(value))
  @IsOptional()
  @IsString()
  tag?: string;

  /**
   * Virtual folder filter.
   * - undefined / omitted: no folder filter (all files)
   * - empty string: root only (DB folderPath IS NULL)
   * - non-empty string: exact folder path
   */
  @ApiPropertyOptional({
    description: '虚拟目录；传空字符串表示仅根目录；不传表示不过滤',
  })
  @Transform(({ value }) => {
    // Preserve empty string so listByProject can distinguish root vs no filter.
    if (value === undefined || value === null) {
      return undefined;
    }
    return typeof value === 'string' ? value : String(value);
  })
  @IsOptional()
  @IsString()
  folderPath?: string;

  @ApiPropertyOptional({ description: '扩展名，例如 png' })
  @Transform(({ value }) => emptyStringToUndefined(value))
  @IsOptional()
  @IsString()
  extension?: string;

  @ApiPropertyOptional({ enum: CdnProvider })
  @Transform(({ value }) => emptyStringToUndefined(value))
  @IsOptional()
  @IsEnum(CdnProvider)
  cdnProvider?: CdnProvider;

  @ApiPropertyOptional({ description: '最小文件大小，单位字节' })
  @Transform(({ value }) => optionalNumber(value))
  @IsOptional()
  @IsInt()
  @Min(0)
  minSize?: number;

  @ApiPropertyOptional({ description: '最大文件大小，单位字节' })
  @Transform(({ value }) => optionalNumber(value))
  @IsOptional()
  @IsInt()
  @Min(0)
  maxSize?: number;

  @ApiPropertyOptional({ description: '上传开始时间' })
  @IsOptional()
  @IsDateString()
  uploadedStartAt?: string;

  @ApiPropertyOptional({ description: '上传结束时间' })
  @IsOptional()
  @IsDateString()
  uploadedEndAt?: string;

  @ApiPropertyOptional({ description: '只看重复文件' })
  @Transform(({ value }) => optionalBoolean(value))
  @IsOptional()
  @IsBoolean()
  duplicateOnly?: boolean;

  @ApiPropertyOptional({ default: 1 })
  @Transform(({ value }) => optionalNumber(value))
  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20 })
  @Transform(({ value }) => optionalNumber(value))
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number = 20;
}
