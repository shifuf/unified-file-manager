import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MinLength } from 'class-validator';

import { MIN_PASSWORD_LENGTH } from '../../common/constants';

export class LoginDto {
  @ApiProperty({ example: 'admin' })
  @IsString()
  username!: string;

  @ApiProperty({ example: 'Admin@123456' })
  @IsString()
  @MinLength(MIN_PASSWORD_LENGTH)
  password!: string;

  @ApiProperty({ example: '123456', required: false })
  @IsOptional()
  @IsString()
  @Matches(/^\d{6}$/)
  totpCode?: string;
}
