import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsOptional, IsString, MaxLength } from 'class-validator';

export class BatchMoveFileDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsString({ each: true })
  fileIds!: string[];

  @ApiPropertyOptional({ description: '目标虚拟目录，留空表示根目录' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  folderPath?: string | null;
}

export class BatchCopyFileDto extends BatchMoveFileDto {
  @ApiPropertyOptional({ description: '目标项目 ID，留空表示复制到各文件原项目' })
  @IsOptional()
  @IsString()
  projectId?: string;
}
