import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

function emptyStringToUndefined(value: unknown): unknown {
  return value === '' ? undefined : value;
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === '') {
    return undefined;
  }

  return Number(value);
}

export class ListShareLinksDto {
  @ApiPropertyOptional()
  @Transform(({ value }) => emptyStringToUndefined(value))
  @IsOptional()
  @IsString()
  projectId?: string;

  @ApiPropertyOptional()
  @Transform(({ value }) => emptyStringToUndefined(value))
  @IsOptional()
  @IsString()
  keyword?: string;

  @ApiPropertyOptional({ enum: ['ACTIVE', 'DISABLED', 'EXPIRED', 'EXHAUSTED'] })
  @Transform(({ value }) => emptyStringToUndefined(value))
  @IsOptional()
  @IsIn(['ACTIVE', 'DISABLED', 'EXPIRED', 'EXHAUSTED'])
  status?: 'ACTIVE' | 'DISABLED' | 'EXPIRED' | 'EXHAUSTED';

  @ApiPropertyOptional({ default: 1 })
  @Transform(({ value }) => optionalNumber(value))
  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20 })
  @Transform(({ value }) => optionalNumber(value))
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number = 20;
}
