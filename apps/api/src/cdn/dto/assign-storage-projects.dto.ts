import { ArrayUnique, IsArray, IsString } from 'class-validator';

export class AssignStorageProjectsDto {
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  projectIds!: string[];
}
