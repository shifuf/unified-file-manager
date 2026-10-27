import { Module } from '@nestjs/common';

import { ProjectsModule } from '../projects/projects.module';
import { SearchModule } from '../search/search.module';
import { SettingsModule } from '../settings/settings.module';
import { StorageModule } from '../storage/storage.module';
import { TasksModule } from '../tasks/tasks.module';
import { AccessStatsModule } from './access-stats.module';
import { DownloadStatsController } from './download-stats.controller';
import { DownloadStatsService } from './download-stats.service';
import { FolderManagerService } from './folder-manager.service';
import { FilesController, PublicFilesController, PublicSharesController } from './files.controller';
import { FilesService } from './files.service';
import { FolderPublicController } from './folder-public.controller';
import { FolderPublicService } from './folder-public.service';
import { FolderShareAdminController, PublicFolderSharesController } from './folder-share.controller';
import { FolderShareService } from './folder-share.service';
import { UploadFilesInterceptor } from './interceptors/upload-files.interceptor';
import { PublicLibraryController } from './public-library.controller';
import { ShareIpAbuseController } from './share-ip-abuse.controller';
import { ShareIpAbuseService } from './share-ip-abuse.service';
import { UploadCredentialController } from './upload-credential.controller';
import { UploadCredentialService } from './upload-credential.service';
import { UploadCredentialGuard } from './guards/upload-credential.guard';

@Module({
  imports: [ProjectsModule, SettingsModule, StorageModule, TasksModule, SearchModule, AccessStatsModule],
  controllers: [
    FilesController,
    PublicFilesController,
    PublicSharesController,
    PublicLibraryController,
    UploadCredentialController,
    FolderPublicController,
    FolderShareAdminController,
    PublicFolderSharesController,
    ShareIpAbuseController,
    DownloadStatsController,
  ],
  providers: [
    FilesService,
    UploadFilesInterceptor,
    UploadCredentialService,
    UploadCredentialGuard,
    FolderPublicService,
    FolderShareService,
    ShareIpAbuseService,
    DownloadStatsService,
    FolderManagerService,
  ],
  exports: [
    FilesService,
    AccessStatsModule,
    UploadFilesInterceptor,
    UploadCredentialService,
    FolderPublicService,
    FolderShareService,
    ShareIpAbuseService,
    DownloadStatsService,
    FolderManagerService,
  ],
})
export class FilesModule {}
