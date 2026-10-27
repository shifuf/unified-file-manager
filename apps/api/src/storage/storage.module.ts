import { Module } from '@nestjs/common';

import { AliyunOssAdapter } from './adapters/aliyun-oss.adapter';
import { LocalStorageAdapter } from './adapters/local.adapter';
import { QiniuAdapter } from './adapters/qiniu.adapter';
import { S3Adapter } from './adapters/s3.adapter';
import { UpyunAdapter } from './adapters/upyun.adapter';
import { StorageAdapterRegistry } from './storage-registry.service';
import { StorageService } from './storage.service';

@Module({
  providers: [
    AliyunOssAdapter,
    LocalStorageAdapter,
    QiniuAdapter,
    S3Adapter,
    StorageAdapterRegistry,
    StorageService,
    UpyunAdapter,
  ],
  exports: [StorageAdapterRegistry, StorageService],
})
export class StorageModule {}
