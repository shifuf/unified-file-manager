import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class ListProjectsDto {
  @ApiPropertyOptional({ description: '项目名称关键词' })
  @IsOptional()
  @IsString()
  keyword?: string;
}
