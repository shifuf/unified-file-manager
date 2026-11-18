import type { INestApplication } from '@nestjs/common';
import { json, type Request } from 'express';
import type { IncomingMessage } from 'node:http';

export function registerJsonBodyParsers(app: Pick<INestApplication, 'use'>): void {
  // JSON escaping can expand a 2 MiB document to 12 MiB on the wire.
  app.use('/api/files/:fileId/content', json({ limit: '13mb' }));
  // Nest detects the parser above and skips its automatic JSON parser.
  // A custom parser disables Nest's built-in rawBody capture. HMAC v2 must
  // authenticate the original JSON bytes, including whitespace and key order.
  app.use(json({
    type: (request) => {
      const req = request as Request;
      // A DAV upload stores the original stream, including files with a JSON MIME type.
      if (req.method === 'PUT' && req.path.startsWith('/api/dav/')) return false;
      return Boolean(req.is('application/json'));
    },
    verify: (request: IncomingMessage & { rawBody?: Buffer }, _response, buffer) => {
      request.rawBody = Buffer.from(buffer);
    },
  }));
}
