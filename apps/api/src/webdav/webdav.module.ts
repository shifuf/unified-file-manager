import { Module } from '@nestjs/common';

import { FilesModule } from '../files/files.module';
import { ProjectsModule } from '../projects/projects.module';
import { StorageModule } from '../storage/storage.module';
import { WebdavAccountService } from './webdav-account.service';
import { WebdavFileService } from './webdav-file.service';
import { WebdavMiddleware } from './webdav.middleware';
import { WebdavSettingsController } from './webdav-settings.controller';
import { WebdavSettingsService } from './webdav-settings.service';
import { WebdavTreeService } from './webdav-tree.service';

@Module({
  imports: [FilesModule, ProjectsModule, StorageModule],
  controllers: [WebdavSettingsController],
  providers: [
    WebdavAccountService,
    WebdavFileService,
    WebdavMiddleware,
    WebdavSettingsService,
    WebdavTreeService,
  ],
  exports: [WebdavMiddleware],
})
export class WebdavModule {}
