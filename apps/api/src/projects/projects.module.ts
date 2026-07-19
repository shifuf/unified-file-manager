import { Module } from '@nestjs/common';

import { AccessStatsModule } from '../files/access-stats.module';
import { ProjectsController } from './projects.controller';
import { ProjectAccessService } from './project-access.service';
import { ProjectsService } from './projects.service';

@Module({
  imports: [AccessStatsModule],
  controllers: [ProjectsController],
  providers: [ProjectsService, ProjectAccessService],
  exports: [ProjectsService, ProjectAccessService],
})
export class ProjectsModule {}
