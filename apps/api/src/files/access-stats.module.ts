import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { AccessStatsService } from './access-stats.service';

@Module({
  imports: [PrismaModule],
  providers: [AccessStatsService],
  exports: [AccessStatsService],
})
export class AccessStatsModule {}
