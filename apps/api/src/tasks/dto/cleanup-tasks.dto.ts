import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CleanupTasksDto {
  @IsOptional()
  @IsString()
  @MaxLength(191)
  projectId?: string;
}
