import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { FileCategory } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

import { FilesService } from './files.service';

class PublicLibraryFilesQueryDto {
  @ApiPropertyOptional({ default: 1 })
  @Transform(({ value }) => (value === '' || value === undefined ? undefined : Number(value)))
  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20 })
  @Transform(({ value }) => (value === '' || value === undefined ? undefined : Number(value)))
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number = 20;

  @ApiPropertyOptional({ description: '关键词' })
  @Transform(({ value }) => (value === '' ? undefined : value))
  @IsOptional()
  @IsString()
  q?: string;

  @ApiPropertyOptional({ description: '文件分类', enum: FileCategory })
  @Transform(({ value }) => (value === '' ? undefined : value))
  @IsOptional()
  @IsString()
  category?: string;

  @ApiPropertyOptional({ description: '目录路径' })
  @Transform(({ value }) => (value === '' ? '' : value === undefined ? undefined : value))
  @IsOptional()
  @IsString()
  folderPath?: string;

  @ApiPropertyOptional({ description: '排序', enum: ['newest', 'oldest', 'name', 'size'] })
  @Transform(({ value }) => (value === '' ? undefined : value))
  @IsOptional()
  @IsIn(['newest', 'oldest', 'name', 'size'])
  sort?: 'newest' | 'oldest' | 'name' | 'size';
}

@ApiTags('公开资源库')
@Controller('library')
export class PublicLibraryController {
  constructor(private readonly filesService: FilesService) {}

  @Get(':slug')
  getLibrary(@Param('slug') slug: string): ReturnType<FilesService['getPublicLibrary']> {
    return this.filesService.getPublicLibrary(slug);
  }

  @Get(':slug/files')
  listLibraryFiles(
    @Param('slug') slug: string,
    @Query() query: PublicLibraryFilesQueryDto,
  ): ReturnType<FilesService['listPublicLibraryFiles']> {
    return this.filesService.listPublicLibraryFiles(slug, {
      page: query.page,
      pageSize: query.pageSize,
      keyword: query.q,
      category: query.category,
      folderPath: query.folderPath,
      sort: query.sort,
    });
  }
}
