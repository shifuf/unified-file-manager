import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class RemoveFolderDto {
  @ApiProperty({ description: '待删除的空目录路径；根目录、有文件或子目录的目录不可删除', example: 'contracts/2026' })
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  folderPath!: string;
}
