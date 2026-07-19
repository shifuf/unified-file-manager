import { Controller, Get } from '@nestjs/common';

import { SkipThrottle } from './common/guards/throttle.decorator';

@Controller('healthz')
@SkipThrottle()
export class HealthController {
  @Get()
  check(): { status: 'ok'; service: string; checkedAt: string } {
    return {
      status: 'ok',
      service: 'ufm-api',
      checkedAt: new Date().toISOString(),
    };
  }
}
