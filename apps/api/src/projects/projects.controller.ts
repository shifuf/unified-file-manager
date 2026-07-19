import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { RequestUser } from '../common/types/request-user.type';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AccessStatsService } from '../files/access-stats.service';
import { CreateProjectSecretDto } from './dto/create-project-secret.dto';
import { CreateProjectDto } from './dto/create-project.dto';
import { ListProjectsDto } from './dto/list-projects.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { ProjectsService } from './projects.service';

@ApiTags('项目管理')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('projects')
export class ProjectsController {
  constructor(
    private readonly projectsService: ProjectsService,
    private readonly accessStatsService: AccessStatsService,
  ) {}

  @Get()
  list(@Query() query: ListProjectsDto, @CurrentUser() user: RequestUser): ReturnType<ProjectsService['list']> {
    return this.projectsService.list(query, user);
  }

  @Post()
  create(
    @Body() dto: CreateProjectDto,
    @CurrentUser() user: RequestUser,
  ): ReturnType<ProjectsService['create']> {
    return this.projectsService.create(dto, user);
  }

  @Post('import')
  importProject(
    @Body() payload: Record<string, unknown>,
    @CurrentUser() user: RequestUser,
  ): ReturnType<ProjectsService['importProject']> {
    return this.projectsService.importProject(payload, user);
  }

  @Get(':projectId')
  get(
    @Param('projectId') projectId: string,
    @CurrentUser() user: RequestUser,
  ): ReturnType<ProjectsService['get']> {
    return this.projectsService.get(projectId, user);
  }

  @Get(':projectId/stats')
  stats(
    @Param('projectId') projectId: string,
    @CurrentUser() user: RequestUser,
  ): ReturnType<ProjectsService['getStats']> {
    return this.projectsService.getStats(projectId, user);
  }

  @Get(':projectId/hotspots')
  async hotspots(
    @Param('projectId') projectId: string,
    @Query('days') days: string | undefined,
    @Query('limit') limit: string | undefined,
    @CurrentUser() user: RequestUser,
  ): Promise<Awaited<ReturnType<AccessStatsService['hotspotReport']>>> {
    // Super-admin gate runs inside projectsService.get.
    await this.projectsService.get(projectId, user);
    return this.accessStatsService.hotspotReport({
      projectId,
      days: days === undefined ? undefined : Number(days),
      limit: limit === undefined ? undefined : Number(limit),
    });
  }

  @Get(':projectId/export')
  exportProject(
    @Param('projectId') projectId: string,
    @CurrentUser() user: RequestUser,
  ): ReturnType<ProjectsService['exportProject']> {
    return this.projectsService.exportProject(projectId, user);
  }

  @Get(':projectId/secrets')
  listProjectSecrets(
    @Param('projectId') projectId: string,
    @CurrentUser() user: RequestUser,
  ): ReturnType<ProjectsService['listProjectSecrets']> {
    return this.projectsService.listProjectSecrets(projectId, user);
  }

  @Post(':projectId/secrets')
  createProjectSecret(
    @Param('projectId') projectId: string,
    @Body() dto: CreateProjectSecretDto,
    @CurrentUser() user: RequestUser,
  ): ReturnType<ProjectsService['createProjectSecret']> {
    return this.projectsService.createProjectSecret(projectId, dto, user);
  }

  @Delete(':projectId/secrets/:secretId')
  disableProjectSecret(
    @Param('projectId') projectId: string,
    @Param('secretId') secretId: string,
    @CurrentUser() user: RequestUser,
  ): ReturnType<ProjectsService['disableProjectSecret']> {
    return this.projectsService.disableProjectSecret(projectId, secretId, user);
  }

  @Put(':projectId')
  update(
    @Param('projectId') projectId: string,
    @Body() dto: UpdateProjectDto,
    @CurrentUser() user: RequestUser,
  ): ReturnType<ProjectsService['update']> {
    return this.projectsService.update(projectId, dto, user);
  }

  @Delete(':projectId')
  remove(
    @Param('projectId') projectId: string,
    @CurrentUser() user: RequestUser,
  ): ReturnType<ProjectsService['remove']> {
    return this.projectsService.remove(projectId, user);
  }

  @Post(':projectId/secret/reset')
  resetSecret(
    @Param('projectId') projectId: string,
    @CurrentUser() user: RequestUser,
  ): ReturnType<ProjectsService['resetSecret']> {
    return this.projectsService.resetSecret(projectId, user);
  }
}
