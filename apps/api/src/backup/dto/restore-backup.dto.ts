import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsIn, IsOptional, IsString } from 'class-validator';

export class RestoreBackupDto {
  @ApiPropertyOptional({
    enum: ['merge', 'replace'],
    default: 'merge',
    description:
      'merge: 仅补齐缺失记录；replace: 先清空所选范围内的业务数据再恢复（用户、审计、统计与备份记录始终保留）',
  })
  @IsOptional()
  @IsIn(['merge', 'replace'])
  mode?: 'merge' | 'replace';

  @ApiPropertyOptional({
    description: '要恢复的数据范围（不传=该备份包含的全部范围），必须是备份中已包含的范围子集',
    isArray: true,
    example: ['projects', 'storage'],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  scopes?: string[];
}
