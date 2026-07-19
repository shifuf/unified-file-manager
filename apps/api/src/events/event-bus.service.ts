import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter } from 'node:events';

import type { DomainEventName, DomainEventPayload } from './domain-events';

type Listener<T extends DomainEventName> = (payload: DomainEventPayload<T>) => void | Promise<void>;

@Injectable()
export class EventBusService {
  private readonly logger = new Logger(EventBusService.name);
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(50);
  }

  on<T extends DomainEventName>(event: T, listener: Listener<T>): void {
    this.emitter.on(event, (payload: DomainEventPayload<T>) => {
      void Promise.resolve()
        .then(() => listener(payload))
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.error(`Handler failed for ${event}: ${message}`);
        });
    });
  }

  emit<T extends DomainEventName>(event: T, payload: DomainEventPayload<T>): void {
    this.emitter.emit(event, payload);
  }
}
