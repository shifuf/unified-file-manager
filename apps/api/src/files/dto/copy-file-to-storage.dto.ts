import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class CopyFileToStorageDto {
  @ApiProperty({ description: '目标存储配置 ID' })
  @IsString()
  @MinLength(1)
  targetConfigId!: string;
}
