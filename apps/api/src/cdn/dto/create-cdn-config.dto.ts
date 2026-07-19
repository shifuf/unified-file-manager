import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CdnProvider } from '@prisma/client';
import { IsBoolean, IsEnum, IsObject, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateCdnConfigDto {
  @ApiProperty({ enum: CdnProvider, example: CdnProvider.ALIYUN })
  @IsEnum(CdnProvider)
  provider!: CdnProvider;

  @ApiProperty({ example: '生产 OSS 华东节点' })
  @IsString()
  @MinLength(2)
  @MaxLength(128)
  name!: string;

  @ApiProperty({
    example: {
      accessKey: 'LTAIxxxxxxxxxxxx',
      secretKey: 'xxxxxxxxxxxxxxxx',
      bucket: 'assets-prod',
      endpoint: 'oss-cn-hangzhou.aliyuncs.com',
      domain: 'https://cdn.example.com',
    },
  })
  @IsObject()
  config!: Record<string, unknown>;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
