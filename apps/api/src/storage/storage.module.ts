import { Module } from '@nestjs/common';

import { AliyunOssAdapter } from './adapters/aliyun-oss.adapter';
import { LocalStorageAdapter } from './adapters/local.adapter';
import { QiniuAdapter } from './adapters/qiniu.adapter';
import { S3Adapter } from './adapters/s3.adapter';
import { UpyunAdapter } from './adapters/upyun.adapter';
import { StorageAdapterRegistry } from './storage-registry.service';
import { StorageService } from './storage.service';
import { ReplicaService } from './replica.service';
import { ReplicaController } from './replica.controller';
import { FileReplicaController } from './file-replica.controller';
import { FileReplicaService } from './file-replica.service';
import { ReplicaWorker } from './replica.worker';
import { StorageLimitsService } from './storage-limits.service';
import { ProjectAccessService } from '../projects/project-access.service';

@Module({
  controllers: [ReplicaController, FileReplicaController],
  providers: [
    AliyunOssAdapter,
    LocalStorageAdapter,
    QiniuAdapter,
    S3Adapter,
    StorageAdapterRegistry,
    StorageService,
    StorageLimitsService,
    UpyunAdapter,
    ReplicaService,
    FileReplicaService,
    ReplicaWorker,
    ProjectAccessService,
  ],
  exports: [StorageAdapterRegistry, StorageService, ReplicaService, StorageLimitsService],
})
export class StorageModule {}
