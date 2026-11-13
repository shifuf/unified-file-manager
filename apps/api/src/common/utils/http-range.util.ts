import { Readable } from 'node:stream';
import type { Request, Response } from 'express';

export type ByteRange = {
  start: number;
  end: number;
  size: number;
  length: number;
};

export function parseByteRange(header: string | undefined, size: number): ByteRange | 'unsatisfiable' | null {
  if (!header) {
    return null;
  }
  if (!/^bytes=/i.test(header.trim())) return null;
  if (!Number.isSafeInteger(size) || size <= 0) return 'unsatisfiable';

  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match) {
    return 'unsatisfiable';
  }

  const startRaw = match[1];
  const endRaw = match[2];

  let start: number;
  let end: number;

  if (startRaw === '' && endRaw === '') {
    return 'unsatisfiable';
  }

  if (startRaw === '') {
    // suffix: bytes=-N
    const suffix = Number.parseInt(endRaw, 10);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) {
      return 'unsatisfiable';
    }
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number.parseInt(startRaw, 10);
    end = endRaw === '' ? size - 1 : Number.parseInt(endRaw, 10);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
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

/** Slice an already verified full-object stream without reopening its cloud source. */
export function sliceByteRange(stream: Readable, range: ByteRange): Readable {
  const sliced = Readable.from((async function* () {
    let offset = 0;
    try {
      for await (const value of stream) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        const start = Math.max(0, range.start - offset);
        const end = Math.min(chunk.length, range.end + 1 - offset);
        if (end > start) yield chunk.subarray(start, end);
        offset += chunk.length;
        if (offset > range.end) break;
      }
    } finally {
      stream.destroy();
    }
  })());
  const destroy = sliced._destroy.bind(sliced);
  sliced._destroy = (error, callback): void => {
    stream.destroy();
    destroy(error, callback);
  };
  return sliced;
}

export function pipeStreamToResponse(
  stream: Readable,
  response: Response,
  onError: (error: Error) => void,
): void {
  if (response.destroyed || response.writableEnded) {
    stream.destroy();
    return;
  }
  const closeSource = (): void => {
    response.removeListener('close', closeSource);
    response.removeListener('finish', closeSource);
    stream.destroy();
  };
  response.once('close', closeSource);
  response.once('finish', closeSource);
  stream.once('error', onError);
  stream.pipe(response);
}

export function getRequestRangeHeader(request: Request): string | undefined {
  const value = request.headers.range;
  return typeof value === 'string' ? value : undefined;
}
