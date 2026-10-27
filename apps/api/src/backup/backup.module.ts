import { Module } from '@nestjs/common';

import { StorageModule } from '../storage/storage.module';
import { BackupController } from './backup.controller';
import { BackupService } from './backup.service';

@Module({
  imports: [StorageModule],
  controllers: [BackupController],
  providers: [BackupService],
  exports: [BackupService],
})
export class BackupModule {}
