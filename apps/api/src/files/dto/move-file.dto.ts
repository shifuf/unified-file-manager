import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class MoveFileDto {
  @ApiPropertyOptional({ description: '目标虚拟目录，留空表示根目录' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  folderPath?: string | null;
}
