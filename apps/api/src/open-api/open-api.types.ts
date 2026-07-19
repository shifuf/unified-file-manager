import type { Project } from '@prisma/client';
import type { Request } from 'express';

export interface OpenApiRequest extends Request {
  openProject: Project;
  /** Raw request body buffer, captured via NestFactory `{ rawBody: true }` for signature verification. */
  rawBody?: Buffer;
}
