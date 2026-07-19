import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CopyFileDto {
  @ApiPropertyOptional({ description: '目标项目 ID，留空表示复制到原项目' })
  @IsOptional()
  @IsString()
  projectId?: string;

  @ApiPropertyOptional({ description: '目标虚拟目录，留空表示根目录' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  folderPath?: string | null;
}
