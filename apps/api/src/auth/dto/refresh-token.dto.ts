import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class RefreshTokenDto {
  @ApiPropertyOptional({ description: '登录或上次刷新返回的 refreshToken。' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  refreshToken?: string;
}
