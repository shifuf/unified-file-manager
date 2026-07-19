import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';

import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { CdnModule } from './cdn/cdn.module';
import { ThrottleGuard } from './common/guards/throttle.guard';
import { EventsModule } from './events/events.module';
import { FilesModule } from './files/files.module';
import { MaintenanceModule } from './maintenance/maintenance.module';
import { MediaModule } from './media/media.module';
import { NotifyModule } from './notify/notify.module';
import { OpenApiModule } from './open-api/open-api.module';
import { PrismaModule } from './prisma/prisma.module';
import { ProjectsModule } from './projects/projects.module';
import { SearchModule } from './search/search.module';
import { SettingsModule } from './settings/settings.module';
import { StorageModule } from './storage/storage.module';
import { TasksModule } from './tasks/tasks.module';
import { HealthController } from './health.controller';
import { LifecycleModule } from './lifecycle/lifecycle.module';
import { NotificationsModule } from './notifications/notifications.module';
import { WebhooksModule } from './webhooks/webhooks.module';

/** Only `.env` is used (cwd or monorepo root). */
function resolveEnvFilePath(): string[] {
  return ['.env', '../../.env'];
}

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: resolveEnvFilePath() }),
    PrismaModule,
    EventsModule,
    NotifyModule,
    AuditModule,
    AuthModule,
    ProjectsModule,
    StorageModule,
    CdnModule,
    MediaModule,
    SearchModule,
    FilesModule,
    OpenApiModule,
    SettingsModule,
    TasksModule,
    MaintenanceModule,
    WebhooksModule,
    NotificationsModule,
    LifecycleModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: ThrottleGuard }],
})
export class AppModule {}
