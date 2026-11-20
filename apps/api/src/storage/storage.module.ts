import { Module } from '@nestjs/common';

import { LocalStorageAdapter } from './adapters/local.adapter';
import { StoragePluginsController } from './plugins/storage-plugins.controller';
import { PluginAuthController } from './plugins/plugin-auth.controller';
import { StorageAdapterRegistry } from './storage-registry.service';
import { StorageService } from './storage.service';
import { ReplicaService } from './replica.service';
import { ReplicaController } from './replica.controller';
import { FileReplicaController } from './file-replica.controller';
import { FileReplicaService } from './file-replica.service';
import { ReplicaWorker } from './replica.worker';
import { StorageLimitsService } from './storage-limits.service';
import { ProjectAccessService } from '../projects/project-access.service';
import { StorageProjectSyncController } from './storage-project-sync.controller';
import { StorageProjectSyncService } from './storage-project-sync.service';

@Module({
  controllers: [ReplicaController, FileReplicaController, StoragePluginsController, PluginAuthController, StorageProjectSyncController],
  providers: [
    LocalStorageAdapter,
    StorageAdapterRegistry,
    StorageService,
    StorageLimitsService,
    ReplicaService,
    FileReplicaService,
    ReplicaWorker,
    ProjectAccessService,
    StorageProjectSyncService,
  ],
  exports: [StorageAdapterRegistry, StorageService, ReplicaService, StorageLimitsService],
})
export class StorageModule {}
