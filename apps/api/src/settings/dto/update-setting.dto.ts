import { ApiProperty } from '@nestjs/swagger';
import { IsDefined, IsString, MaxLength } from 'class-validator';

export class UpdateSettingDto {
  @ApiProperty({ example: 'maxFileSizeMb' })
  @IsString()
  @MaxLength(128)
  key!: string;

  @ApiProperty({ example: 200 })
  @IsDefined()
  value!: unknown;
}
