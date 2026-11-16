import { Module } from '@nestjs/common';

import { ProjectsModule } from '../projects/projects.module';
import { StorageModule } from '../storage/storage.module';
import { CdnController } from './cdn.controller';
import { CdnService } from './cdn.service';

@Module({
  imports: [ProjectsModule, StorageModule],
  controllers: [CdnController],
  providers: [CdnService],
  exports: [CdnService],
})
export class CdnModule {}
