import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class CreateFolderDto {
  @ApiProperty({ description: '要创建的目录路径，例如 contracts/2026', example: 'contracts/2026' })
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  folderPath!: string;
}
