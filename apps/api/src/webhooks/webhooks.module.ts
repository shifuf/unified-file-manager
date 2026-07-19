import { Module } from '@nestjs/common';

import { ProjectsModule } from '../projects/projects.module';
import { WebhookDeliveryService } from './webhook-delivery.service';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';

@Module({
  imports: [ProjectsModule],
  controllers: [WebhooksController],
  providers: [WebhooksService, WebhookDeliveryService],
  exports: [WebhooksService],
})
export class WebhooksModule {}
