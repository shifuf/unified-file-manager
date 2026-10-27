import { Injectable } from '@nestjs/common';
import { CdnProvider } from '@prisma/client';

import { AliyunOssAdapter } from './adapters/aliyun-oss.adapter';
import { LocalStorageAdapter } from './adapters/local.adapter';
import { QiniuAdapter } from './adapters/qiniu.adapter';
import { S3Adapter } from './adapters/s3.adapter';
import { UpyunAdapter } from './adapters/upyun.adapter';
import type { RuntimeCdnConfig, StorageAdapter } from './storage.types';

/** Maps a provider enum onto its adapter implementation. */
@Injectable()
export class StorageAdapterRegistry {
  constructor(
    private readonly aliyunOssAdapter: AliyunOssAdapter,
    private readonly localAdapter: LocalStorageAdapter,
    private readonly qiniuAdapter: QiniuAdapter,
    private readonly s3Adapter: S3Adapter,
    private readonly upyunAdapter: UpyunAdapter,
  ) {}

  adapter(provider: CdnProvider): StorageAdapter {
    switch (provider) {
      case CdnProvider.LOCAL:
        return this.localAdapter;
      case CdnProvider.QINIU:
        return this.qiniuAdapter;
      case CdnProvider.ALIYUN:
        return this.aliyunOssAdapter;
      case CdnProvider.S3:
        return this.s3Adapter;
      case CdnProvider.UPYUN:
        return this.upyunAdapter;
      default:
        throw new Error(`不支持的存储平台：${String(provider)}`);
    }
  }

  /** Local root directory for LOCAL configs, or null for remote providers. */
  localRoot(config: RuntimeCdnConfig): string | null {
    if (config.provider !== CdnProvider.LOCAL) {
      return null;
    }

    return this.localAdapter.root(config);
  }

  supportsDirectUpload(provider: CdnProvider): boolean {
    return provider !== CdnProvider.LOCAL;
  }
}
