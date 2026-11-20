import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsBoolean, IsOptional, IsString, Matches, MaxLength, ValidateIf } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

const ID_PATTERN = /^[A-Za-z0-9_-]{1,191}$/;

export class ListRemoteFilesDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Matches(ID_PATTERN)
  parentId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  @Matches(/^\P{Cc}*$/u)
  cursor?: string;
}

export class ImportRemoteFilesDto {
  @ApiPropertyOptional({ description: '普通文件导入时必填；系统备份登记可省略。' })
  @ValidateIf((dto: ImportRemoteFilesDto) => dto.projectId !== undefined || dto.asBackup !== true && dto.projectIds === undefined)
  @IsString()
  @Matches(ID_PATTERN)
  projectId?: string;

  @ApiPropertyOptional({ description: '同步到一个或多个项目，与 projectId 二选一。', type: [String], maxItems: 20 })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ArrayUnique()
  @IsString({ each: true })
  @Matches(ID_PATTERN, { each: true })
  projectIds?: string[];

  @ApiProperty({ type: [String], maxItems: 20 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ArrayUnique()
  @IsString({ each: true })
  @Matches(ID_PATTERN, { each: true })
  fileIds!: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(512)
  folderPath?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @Transform(({ obj }: { obj: Record<string, unknown> }) => obj.asBackup)
  @IsBoolean()
  asBackup?: boolean;
}
