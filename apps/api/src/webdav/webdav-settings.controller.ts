import {
  Body,
  Controller,
  Get,
  Param,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { RequestUser } from '../common/types/request-user.type';
import { ProjectAccessService } from '../projects/project-access.service';
import { UpdateWebdavSettingsDto } from './dto/webdav-settings.dto';
import { WebdavSettingsService } from './webdav-settings.service';

@ApiTags('WebDAV 设置')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
export class WebdavSettingsController {
  constructor(
    private readonly projectAccessService: ProjectAccessService,
    private readonly settingsService: WebdavSettingsService,
  ) {}

  @Get('projects/:projectId/webdav')
  async status(
    @Param('projectId') projectId: string,
    @CurrentUser() user: RequestUser,
  ): Promise<Record<string, unknown>> {
    await this.projectAccessService.assertProjectAccess(user, projectId);
    return this.settingsService.get(projectId);
  }

  @Put('projects/:projectId/webdav')
  async update(
    @Param('projectId') projectId: string,
    @Body() dto: UpdateWebdavSettingsDto,
    @CurrentUser() user: RequestUser,
  ): Promise<Record<string, unknown>> {
    await this.projectAccessService.assertProjectAccess(user, projectId, true);
    return this.settingsService.update(projectId, dto, user.id);
  }
}
