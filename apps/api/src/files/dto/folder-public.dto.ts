import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

function emptyToUndefined(value: unknown): unknown {
  return value === '' ? undefined : value;
}

export class UpsertFolderPublicDto {
  @ApiPropertyOptional({ description: '文件夹路径，空表示项目根目录' })
  @Transform(({ value }) => emptyToUndefined(value))
  @IsOptional()
  @IsString()
  @MaxLength(512)
  folderPath?: string | null;

  @ApiProperty({ description: '是否公开' })
  @IsBoolean()
  isPublic!: boolean;
}

export class RemoveFolderPublicDto {
  @ApiPropertyOptional({ description: '文件夹路径，空表示项目根目录' })
  @Transform(({ value }) => emptyToUndefined(value))
  @IsOptional()
  @IsString()
  @MaxLength(512)
  folderPath?: string | null;
}

export class BatchPublishFolderDto {
  @ApiPropertyOptional({ description: '文件夹路径，空表示项目根目录' })
  @Transform(({ value }) => emptyToUndefined(value))
  @IsOptional()
  @IsString()
  @MaxLength(512)
  folderPath?: string | null;

  @ApiProperty({ description: '批量设置 isPublic' })
  @IsBoolean()
  isPublic!: boolean;

  @ApiPropertyOptional({ description: '是否包含子目录，默认 true' })
  @IsOptional()
  @IsBoolean()
  recursive?: boolean;
}
