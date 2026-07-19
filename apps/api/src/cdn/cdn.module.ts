import { Module } from '@nestjs/common';

import { ProjectsModule } from '../projects/projects.module';
import { AliyunOssAdapter } from '../storage/adapters/aliyun-oss.adapter';
import { QiniuAdapter } from '../storage/adapters/qiniu.adapter';
import { S3Adapter } from '../storage/adapters/s3.adapter';
import { UpyunAdapter } from '../storage/adapters/upyun.adapter';
import { CdnController } from './cdn.controller';
import { CdnService } from './cdn.service';

@Module({
  imports: [ProjectsModule],
  controllers: [CdnController],
  providers: [AliyunOssAdapter, CdnService, QiniuAdapter, S3Adapter, UpyunAdapter],
  exports: [CdnService],
})
export class CdnModule {}
