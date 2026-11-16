import type { INestApplication } from '@nestjs/common';
import { json } from 'express';

export function registerJsonBodyParsers(app: Pick<INestApplication, 'use'>): void {
  // JSON escaping can expand a 2 MiB document to 12 MiB on the wire.
  app.use('/api/files/:fileId/content', json({ limit: '13mb' }));
  // Nest detects the parser above and skips its automatic JSON parser.
  app.use(json());
}
