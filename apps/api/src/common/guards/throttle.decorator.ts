import { SetMetadata } from '@nestjs/common';

export const THROTTLE_OPTIONS_KEY = 'throttle:options';
export const SKIP_THROTTLE_KEY = 'throttle:skip';

export interface ThrottleOptions {
  /** Max requests allowed per window, per client IP, per handler. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

/** Override the default rate limit for a controller or route handler. */
export const Throttle = (options: ThrottleOptions): MethodDecorator & ClassDecorator =>
  SetMetadata(THROTTLE_OPTIONS_KEY, options);

/** Exempt a controller or route handler from rate limiting. */
export const SkipThrottle = (): MethodDecorator & ClassDecorator => SetMetadata(SKIP_THROTTLE_KEY, true);
