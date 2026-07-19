import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import { DOMAIN_EVENTS, type DomainEventName } from '../events/domain-events';
import { EventBusService } from '../events/event-bus.service';
import { WebhooksService } from './webhooks.service';

@Injectable()
export class WebhookDeliveryService implements OnModuleInit {
  private readonly logger = new Logger(WebhookDeliveryService.name);

  constructor(
    private readonly eventBus: EventBusService,
    private readonly webhooksService: WebhooksService,
  ) {}

  onModuleInit(): void {
    for (const event of Object.values(DOMAIN_EVENTS) as DomainEventName[]) {
      this.eventBus.on(event, (payload) => {
        void this.webhooksService
          .deliverForEvent(event, payload as unknown as Record<string, unknown>)
          .catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.warn(`Webhook fan-out failed for ${event}: ${message}`);
          });
      });
    }
  }
}
