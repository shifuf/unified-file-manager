import { Module } from '@nestjs/common';

import { ProjectsModule } from '../projects/projects.module';
import { StorageModule } from '../storage/storage.module';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';
import { StorageMigrationWorker } from './storage-migration.worker';

@Module({
  imports: [ProjectsModule, StorageModule],
  controllers: [TasksController],
  providers: [TasksService, StorageMigrationWorker],
  exports: [TasksService],
})
export class TasksModule {}
