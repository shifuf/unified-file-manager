import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CdnProvider } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsInt, IsNumber, IsObject, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

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

  @ApiPropertyOptional({ example: 100, minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  priority?: number;

  @ApiPropertyOptional({ example: 90, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(100)
  failoverThresholdPercent?: number;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  autoFailover?: boolean;

  @ApiPropertyOptional({ example: 107374182400 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  storageQuotaBytes?: number | null;

  @ApiPropertyOptional({ example: 53687091200 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  manualStorageUsedBytes?: number | null;

  @ApiPropertyOptional({ example: 1073741824000 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  trafficQuotaBytes?: number | null;

  @ApiPropertyOptional({ example: 536870912000 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  manualTrafficUsedBytes?: number | null;
}
