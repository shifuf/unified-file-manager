import { Module } from '@nestjs/common';

import { ProjectsModule } from '../projects/projects.module';
import { LifecycleController } from './lifecycle.controller';
import { LifecycleService } from './lifecycle.service';

@Module({
  imports: [ProjectsModule],
  controllers: [LifecycleController],
  providers: [LifecycleService],
  exports: [LifecycleService],
})
export class LifecycleModule {}
