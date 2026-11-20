import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsString, Matches } from 'class-validator';

export class StorageProjectSyncDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ArrayUnique()
  @IsString({ each: true })
  @Matches(/^[A-Za-z0-9_-]{1,191}$/, { each: true })
  projectIds!: string[];
}
