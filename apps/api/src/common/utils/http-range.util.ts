import type { Readable } from 'node:stream';
import type { Request, Response } from 'express';

export type ByteRange = {
  start: number;
  end: number;
  size: number;
  length: number;
};

export function parseByteRange(header: string | undefined, size: number): ByteRange | 'unsatisfiable' | null {
  if (!header || size <= 0) {
    return null;
  }

  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match) {
    return null;
  }

  const startRaw = match[1];
  const endRaw = match[2];

  let start: number;
  let end: number;

  if (startRaw === '' && endRaw === '') {
    return null;
  }

  if (startRaw === '') {
    // suffix: bytes=-N
    const suffix = Number.parseInt(endRaw, 10);
    if (!Number.isFinite(suffix) || suffix <= 0) {
      return 'unsatisfiable';
    }
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number.parseInt(startRaw, 10);
    end = endRaw === '' ? size - 1 : Number.parseInt(endRaw, 10);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) {
      return 'unsatisfiable';
    }
    if (start >= size) {
      return 'unsatisfiable';
    }
    end = Math.min(end, size - 1);
  }

  return {
    start,
    end,
    size,
    length: end - start + 1,
  };
}

export function applyRangeHeaders(
  response: Response,
  mimeType: string,
  size: number,
  range: ByteRange | null,
  disposition: 'inline' | 'attachment',
  filename: string,
): void {
  response.setHeader('Accept-Ranges', 'bytes');
  response.setHeader('Content-Type', mimeType);
  response.setHeader(
    'Content-Disposition',
    `${disposition}; filename*=UTF-8''${encodeURIComponent(filename)}`,
  );

  if (range) {
    response.status(206);
    response.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
    response.setHeader('Content-Length', String(range.length));
  } else {
    response.status(200);
    response.setHeader('Content-Length', String(size));
  }
}

export function writeUnsatisfiableRange(response: Response, size: number): void {
  response.status(416);
  response.setHeader('Content-Range', `bytes */${size}`);
  response.setHeader('Accept-Ranges', 'bytes');
  response.end();
}

export function pipeStreamToResponse(
  stream: Readable,
  response: Response,
  onError: (error: Error) => void,
): void {
  stream.once('error', onError);
  stream.pipe(response);
}

export function getRequestRangeHeader(request: Request): string | undefined {
  const value = request.headers.range;
  return typeof value === 'string' ? value : undefined;
}
