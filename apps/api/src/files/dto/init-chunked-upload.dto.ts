import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class InitChunkedUploadDto {
  @ApiProperty({ description: '原始文件名' })
  @IsString()
  @MaxLength(255)
  fileName!: string;

  @ApiProperty({ description: '文件总字节数' })
  @IsInt()
  @Min(1)
  size!: number;

  @ApiProperty({ description: '分片总数' })
  @IsInt()
  @Min(1)
  @Max(10000)
  totalChunks!: number;

  @ApiPropertyOptional({ description: 'MIME 类型' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  mimeType?: string;

  @ApiPropertyOptional({ description: '目标目录' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  folderPath?: string;

  @ApiPropertyOptional({
    enum: ['reject', 'reuse', 'replace'],
    description: '重复文件处理策略。replace=按同名同目录覆盖，保持 fileId/直链/分享不变',
  })
  @IsOptional()
  @IsIn(['reject', 'reuse', 'replace'])
  duplicateStrategy?: 'reject' | 'reuse' | 'replace';

  @ApiPropertyOptional({ description: '指定要覆盖的文件 ID（保持 fileId/直链/分享不变）' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  targetFileId?: string;
}
