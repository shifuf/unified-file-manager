import { Module } from '@nestjs/common';

import { SearchModule } from '../search/search.module';
import { StorageModule } from '../storage/storage.module';
import { ContentExtractService } from './content-extract.service';
import { ImagePipelineService } from './image-pipeline.service';
import { VideoPipelineService } from './video-pipeline.service';

@Module({
  imports: [StorageModule, SearchModule],
  providers: [ImagePipelineService, ContentExtractService, VideoPipelineService],
  exports: [ImagePipelineService, ContentExtractService, VideoPipelineService],
})
export class MediaModule {}
