import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateProjectSecretDto {
  @ApiPropertyOptional({ example: 'CI 上传脚本' })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(128)
  name?: string;
}
