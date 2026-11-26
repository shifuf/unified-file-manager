import { Module } from '@nestjs/common';

import { ProjectsModule } from '../projects/projects.module';
import { StorageModule } from '../storage/storage.module';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';
import { StorageMigrationWorker } from './storage-migration.worker';
import { FilePurgeWorker } from './file-purge.worker';

@Module({
  imports: [ProjectsModule, StorageModule],
  controllers: [TasksController],
  providers: [TasksService, StorageMigrationWorker, FilePurgeWorker],
  exports: [TasksService],
})
export class TasksModule {}
