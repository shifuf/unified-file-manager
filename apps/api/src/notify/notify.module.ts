import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';
import { NotifyService } from './notify.service';

@Module({
  imports: [AuditModule],
  providers: [NotifyService],
  exports: [NotifyService],
})
export class NotifyModule {}
