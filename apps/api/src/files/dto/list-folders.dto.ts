import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';

export class ListFoldersDto {
  @ApiPropertyOptional({ enum: ['ACTIVE', 'RECYCLED'], default: 'ACTIVE', description: '有效文件目录或回收站文件目录' })
  @IsOptional()
  @IsIn(['ACTIVE', 'RECYCLED'])
  status?: 'ACTIVE' | 'RECYCLED';
}
