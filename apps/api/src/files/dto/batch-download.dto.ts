import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsString } from 'class-validator';

export class BatchDownloadDto {
  @ApiProperty({ type: [String], example: ['clx0000000000000000000001'] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsString({ each: true })
  fileIds!: string[];
}
