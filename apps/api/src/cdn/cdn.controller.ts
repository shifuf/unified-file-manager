import { Body, Controller, Delete, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { RequestUser } from '../common/types/request-user.type';
import { CdnService } from './cdn.service';
import { CreateCdnConfigDto } from './dto/create-cdn-config.dto';
import { UpdateCdnConfigDto } from './dto/update-cdn-config.dto';

@ApiTags('存储配置')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
export class CdnController {
  constructor(private readonly cdnService: CdnService) {}

  @Get('storage-configs')
  list(@CurrentUser() user: RequestUser): ReturnType<CdnService['list']> {
    return this.cdnService.list(user);
  }

  @Post('storage-configs')
  create(
    @Body() dto: CreateCdnConfigDto,
    @CurrentUser() user: RequestUser,
  ): ReturnType<CdnService['create']> {
    return this.cdnService.create(dto, user);
  }

  @Put('storage-configs/:configId')
  update(
    @Param('configId') configId: string,
    @Body() dto: UpdateCdnConfigDto,
    @CurrentUser() user: RequestUser,
  ): ReturnType<CdnService['update']> {
    return this.cdnService.update(configId, dto, user);
  }

  @Delete('storage-configs/:configId')
  remove(
    @Param('configId') configId: string,
    @CurrentUser() user: RequestUser,
  ): ReturnType<CdnService['remove']> {
    return this.cdnService.remove(configId, user);
  }

  @Post('storage-configs/:configId/test')
  test(
    @Param('configId') configId: string,
    @CurrentUser() user: RequestUser,
  ): ReturnType<CdnService['test']> {
    return this.cdnService.test(configId, user);
  }

  @Get('storage-configs/:configId/usage')
  usage(
    @Param('configId') configId: string,
    @CurrentUser() user: RequestUser,
  ): ReturnType<CdnService['getUsage']> {
    return this.cdnService.getUsage(configId, user);
  }

  @Get('projects/:projectId/storage-configs')
  listForProject(
    @Param('projectId') projectId: string,
    @CurrentUser() user: RequestUser,
  ): ReturnType<CdnService['listForProject']> {
    return this.cdnService.listForProject(projectId, user);
  }

  @Post('projects/:projectId/storage-configs/:configId/select')
  selectForProject(
    @Param('projectId') projectId: string,
    @Param('configId') configId: string,
    @CurrentUser() user: RequestUser,
  ): ReturnType<CdnService['selectForProject']> {
    return this.cdnService.selectForProject(projectId, configId, user);
  }

  @Post('projects/:projectId/storage-configs/:configId/test')
  testForProject(
    @Param('projectId') projectId: string,
    @Param('configId') configId: string,
    @CurrentUser() user: RequestUser,
  ): ReturnType<CdnService['testForProject']> {
    return this.cdnService.testForProject(projectId, configId, user);
  }

  @Get('projects/:projectId/storage-configs/:configId/usage')
  usageForProject(
    @Param('projectId') projectId: string,
    @Param('configId') configId: string,
    @CurrentUser() user: RequestUser,
  ): ReturnType<CdnService['getUsageForProject']> {
    return this.cdnService.getUsageForProject(projectId, configId, user);
  }

  @Post('projects/:projectId/storage-configs')
  createForProject(
    @Param('projectId') projectId: string,
    @Body() dto: CreateCdnConfigDto,
    @CurrentUser() user: RequestUser,
  ): ReturnType<CdnService['createForProject']> {
    return this.cdnService.createForProject(projectId, dto, user);
  }

  @Put('projects/:projectId/storage-configs/:configId')
  updateForProject(
    @Param('projectId') projectId: string,
    @Param('configId') configId: string,
    @Body() dto: UpdateCdnConfigDto,
    @CurrentUser() user: RequestUser,
  ): ReturnType<CdnService['updateForProject']> {
    return this.cdnService.updateForProject(projectId, configId, dto, user);
  }

  @Delete('projects/:projectId/storage-configs/:configId')
  removeForProject(
    @Param('projectId') projectId: string,
    @Param('configId') configId: string,
    @CurrentUser() user: RequestUser,
  ): ReturnType<CdnService['removeForProject']> {
    return this.cdnService.removeForProject(projectId, configId, user);
  }

  @Get('projects/:projectId/cdn-configs')
  legacyListForProject(
    @Param('projectId') projectId: string,
    @CurrentUser() user: RequestUser,
  ): ReturnType<CdnService['listForProject']> {
    return this.cdnService.listForProject(projectId, user);
  }

  @Post('projects/:projectId/cdn-configs/:configId/activate')
  legacyActivate(
    @Param('projectId') projectId: string,
    @Param('configId') configId: string,
    @CurrentUser() user: RequestUser,
  ): ReturnType<CdnService['selectForProject']> {
    return this.cdnService.selectForProject(projectId, configId, user);
  }

  @Post('projects/:projectId/cdn-configs')
  legacyCreateForProject(
    @Param('projectId') projectId: string,
    @Body() dto: CreateCdnConfigDto,
    @CurrentUser() user: RequestUser,
  ): ReturnType<CdnService['createForProject']> {
    return this.cdnService.createForProject(projectId, dto, user);
  }

  @Put('projects/:projectId/cdn-configs/:configId')
  legacyUpdateForProject(
    @Param('projectId') projectId: string,
    @Param('configId') configId: string,
    @Body() dto: UpdateCdnConfigDto,
    @CurrentUser() user: RequestUser,
  ): ReturnType<CdnService['updateForProject']> {
    return this.cdnService.updateForProject(projectId, configId, dto, user);
  }

  @Delete('projects/:projectId/cdn-configs/:configId')
  legacyRemoveForProject(
    @Param('projectId') projectId: string,
    @Param('configId') configId: string,
    @CurrentUser() user: RequestUser,
  ): ReturnType<CdnService['removeForProject']> {
    return this.cdnService.removeForProject(projectId, configId, user);
  }
}
