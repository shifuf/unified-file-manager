import { IsInt, IsString, MaxLength, Min } from 'class-validator';

export class UpdateFileContentDto {
  @IsString()
  @MaxLength(2 * 1024 * 1024)
  content!: string;

  @IsInt()
  @Min(1)
  expectedVersion!: number;
}
