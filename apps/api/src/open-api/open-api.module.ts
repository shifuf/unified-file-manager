import { Module } from '@nestjs/common';

import { FilesModule } from '../files/files.module';
import { SettingsModule } from '../settings/settings.module';
import { OpenApiController } from './open-api.controller';
import { OpenApiGuard } from './open-api.guard';

@Module({
  imports: [FilesModule, SettingsModule],
  controllers: [OpenApiController],
  providers: [OpenApiGuard],
})
export class OpenApiModule {}
