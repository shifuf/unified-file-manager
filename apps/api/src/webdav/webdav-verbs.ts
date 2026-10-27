import type { Request, Response } from 'express';
import { Readable } from 'node:stream';

import { getClientIp } from '../common/utils/client-ip.util';
import { parseByteRange } from '../common/utils/http-range.util';
import type { DownloadStatsService } from '../files/download-stats.service';
import type { WebdavFileService } from './webdav-file.service';
import type { WebdavTreeService } from './webdav-tree.service';
import type { WebdavAccount } from './webdav-account.service';
import { normalizeDavPath, parentDavPath } from './webdav.utils';


type DavDeps = {
  fileService: WebdavFileService;
  statsService: DownloadStatsService;
  treeService: WebdavTreeService;
};

/**
 * Raw DAV verbs, kept apart from the middleware shell so routing / auth stays
 * readable. Nest cannot express PROPFIND/MKCOL/COPY/MOVE/LOCK/UNLOCK.
 */
export async function dispatchDav(
  deps: DavDeps,
  method: string,
  account: WebdavAccount,
  davPath: string,
  request: Request,
  response: Response,
): Promise<void> {
  switch (method) {
    case 'GET':
      return handleGet(deps, account, davPath, request, response, true);
    case 'HEAD':
      return handleGet(deps, account, davPath, request, response, false);
    case 'PROPFIND':
      return handlePropfind(deps, account, davPath, request, response);
    case 'PUT':
      return handlePut(deps, account, davPath, request, response);
    case 'DELETE':
      return handleDelete(deps, account, davPath, response);
    case 'MKCOL':
      return handleMkcol(deps, account, davPath, response);
    case 'COPY':
      return handleMove(deps, account, davPath, request, response, true);
    case 'MOVE':
      return handleMove(deps, account, davPath, request, response, false);
    case 'LOCK':
      return handleLock(response);
    case 'UNLOCK':
      response.status(204).end();
      return;
    default:
      response.status(405).end();
  }
}
async function handleGet(
  deps: DavDeps,
  account: WebdavAccount,
  davPath: string,
  request: Request,
  response: Response,
  withBody: boolean,
): Promise<void> {
  const node = await deps.treeService.stat(account, davPath);
  if (!node) {
    response.status(404).end();
    return;
  }
  if (node.isCollection) {
    response.status(405).end();
    return;
  }

  const size = node.size ?? 0;
  const parsed = parseByteRange(
    typeof request.headers.range === 'string' ? request.headers.range : undefined,
    size,
  );
  if (parsed === 'unsatisfiable') {
    response.status(416);
    response.setHeader('Content-Range', `bytes */${size}`);
    response.end();
    return;
  }

  const range = parsed && typeof parsed === 'object' ? { start: parsed.start, end: parsed.end } : undefined;
  const result = await deps.fileService.readFile(account, davPath, range);

  // HEAD never needs the body, so answer straight from metadata.
  if (!withBody) {
    recordDownload(deps, account, request, {
      fileId: result.file.id,
      originalName: result.file.originalName,
      bytes: range ? range.end - range.start + 1 : size,
      range,
    });
    writeFileHeaders(response, result.file.mimeType, result.file.updatedAt, size, range);
    response.end();
    return;
  }

  // Cloud storage full-body reads are handed to the client as a signed redirect.
  if (result.redirectUrl && !range) {
    recordDownload(deps, account, request, {
      fileId: result.file.id,
      originalName: result.file.originalName,
      bytes: size,
      range: undefined,
    });
    response.redirect(result.redirectUrl);
    return;
  }

  let stream: Readable | undefined = result.stream;
  let contentRange = range ? `bytes ${range.start}-${range.end}/${size}` : null;
  let length = range ? range.end - range.start + 1 : size;
  let partial = Boolean(range);

  if (!stream && result.redirectUrl) {
    // Ranged cloud reads must replay the Range header upstream, otherwise the
    // whole object comes back while we advertise a 206 partial payload.
    const remote = await fetchStream(result.redirectUrl, range);
    if (!remote) {
      response.status(502).end();
      return;
    }
    stream = remote.stream;
    if (range && remote.status !== 206) {
      partial = false;
      contentRange = null;
      length = size;
    }
    if (remote.contentLength !== null) {
      length = remote.contentLength;
    }
    if (remote.contentRange) {
      contentRange = remote.contentRange;
    }
  }

  if (!stream) {
    response.status(404).end();
    return;
  }

  recordDownload(deps, account, request, {
    fileId: result.file.id,
    originalName: result.file.originalName,
    bytes: length,
    range,
  });

  response.setHeader('Content-Type', result.file.mimeType || 'application/octet-stream');
  response.setHeader('Accept-Ranges', 'bytes');
  response.setHeader('Content-Length', String(length));
  response.setHeader('Last-Modified', result.file.updatedAt.toUTCString());
  if (partial && contentRange) {
    response.status(206);
    response.setHeader('Content-Range', contentRange);
  } else {
    response.status(200);
  }

  stream.once('error', () => response.destroy());
  stream.pipe(response);
}

function writeFileHeaders(
  response: Response,
  mimeType: string,
  updatedAt: Date,
  size: number,
  range?: { start: number; end: number },
): void {
  response.setHeader('Content-Type', mimeType || 'application/octet-stream');
  response.setHeader('Accept-Ranges', 'bytes');
  response.setHeader('Last-Modified', updatedAt.toUTCString());
  if (range) {
    response.status(206);
    response.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
    response.setHeader('Content-Length', String(range.end - range.start + 1));
    return;
  }
  response.status(200);
  response.setHeader('Content-Length', String(size));
}

function recordDownload(
  deps: DavDeps,
  account: WebdavAccount,
  request: Request,
  input: {
    fileId: string;
    originalName: string;
    bytes: number;
    range?: { start: number; end: number };
  },
): void {
  deps.statsService.record({
    projectId: account.projectId,
    fileId: input.fileId,
    originalName: input.originalName,
    bytes: Math.max(0, input.bytes),
    source: 'WEBDAV',
    actorId: `webdav:${account.username}`,
    ip: getClientIp(request),
    userAgent: request.get('user-agent') ?? null,
    rangeStart: input.range?.start ?? null,
    rangeEnd: input.range?.end ?? null,
  });
}
async function handlePropfind(
  deps: DavDeps,
  account: WebdavAccount,
  davPath: string,
  request: Request,
  response: Response,
): Promise<void> {
  const depth = String(request.headers.depth ?? '1').toLowerCase();
  const node = await deps.treeService.stat(account, davPath);
  if (!node) {
    response.status(404).end();
    return;
  }

  const bodies = [deps.treeService.propfindBody(account, node)];
  if (node.isCollection && depth !== '0') {
    for (const child of await deps.treeService.list(account, node.path)) {
      bodies.push(deps.treeService.propfindBody(account, child));
    }
  }

  response.status(207);
  response.setHeader('Content-Type', 'application/xml; charset=utf-8');
  response.end(
    `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">${bodies.join('')}</D:multistatus>`,
  );
}

async function handlePut(
  deps: DavDeps,
  account: WebdavAccount,
  davPath: string,
  request: Request,
  response: Response,
): Promise<void> {
  if (!davPath) {
    response.status(405).end();
    return;
  }

  const parent = await deps.treeService.stat(account, parentDavPath(davPath));
  if (!parent) {
    response.status(409).end();
    return;
  }

  const existing = await deps.treeService.stat(account, davPath);
  const body = await readBody(request);
  const mimeType = request.get('content-type')?.split(';')[0]?.trim() || 'application/octet-stream';

  await deps.fileService.writeFile(account, davPath, body, mimeType, `webdav:${account.username}`);

  response.status(existing ? 204 : 201);
  response.end();
}

async function handleDelete(
  deps: DavDeps,
  account: WebdavAccount,
  davPath: string,
  response: Response,
): Promise<void> {
  if (!davPath) {
    response.status(403).end();
    return;
  }

  const node = await deps.treeService.stat(account, davPath);
  if (!node) {
    response.status(404).end();
    return;
  }

  if (node.isCollection) {
    await deps.fileService.deleteCollection(account, davPath);
  } else {
    await deps.fileService.deleteFile(account, davPath);
  }

  response.status(204).end();
}

async function handleMkcol(
  deps: DavDeps,
  account: WebdavAccount,
  davPath: string,
  response: Response,
): Promise<void> {
  if (!davPath) {
    response.status(405).end();
    return;
  }

  if (await deps.treeService.stat(account, davPath)) {
    response.status(405).end();
    return;
  }

  if (!(await deps.treeService.stat(account, parentDavPath(davPath)))) {
    response.status(409).end();
    return;
  }

  await deps.treeService.createCollection(account, davPath);
  response.status(201).end();
}

async function handleMove(
  deps: DavDeps,
  account: WebdavAccount,
  davPath: string,
  request: Request,
  response: Response,
  copy: boolean,
): Promise<void> {
  const destination = readDestination(request, account.projectId);
  if (!destination) {
    response.status(400).end();
    return;
  }

  const node = await deps.treeService.stat(account, davPath);
  if (!node) {
    response.status(404).end();
    return;
  }

  await deps.fileService.transferEntry(account, davPath, destination, node.isCollection, copy);
  response.status(201).end();
}

function handleLock(response: Response): void {
  response.status(200);
  response.setHeader('Content-Type', 'application/xml; charset=utf-8');
  response.setHeader('Lock-Token', '<opaquelocktoken:ufm>');
  response.end(
    '<?xml version="1.0" encoding="utf-8"?><D:prop xmlns:D="DAV:"><D:lockdiscovery><D:activelock>' +
      '<D:locktype><D:write/></D:locktype><D:lockscope><D:exclusive/></D:lockscope>' +
      '<D:depth>infinity</D:depth><D:timeout>Second-3600</D:timeout>' +
      '<D:locktoken><D:href>opaquelocktoken:ufm</D:href></D:locktoken>' +
      '</D:activelock></D:lockdiscovery></D:prop>',
  );
}

function readDestination(request: Request, projectId: string): string | null {
  const raw = request.get('destination');
  if (!raw) {
    return null;
  }

  let pathname: string;
  try {
    pathname = new URL(raw, 'http://localhost').pathname;
  } catch {
    pathname = raw;
  }

  const marker = `/api/dav/${projectId}`;
  if (!pathname.startsWith(marker)) {
    return null;
  }

  return normalizeDavPath(pathname.slice(marker.length));
}

function readBody(request: Request): Promise<Buffer> {
  return new Promise<Buffer>((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolvePromise(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

type RemoteStream = {
  stream: Readable;
  status: number;
  contentRange: string | null;
  contentLength: number | null;
};

async function fetchStream(
  url: string,
  range?: { start: number; end: number },
): Promise<RemoteStream | null> {
  try {
    const remote = await fetch(url, {
      headers: range ? { Range: `bytes=${range.start}-${range.end}` } : undefined,
      signal: AbortSignal.timeout(60_000),
    });
    if (!remote.ok || !remote.body) {
      return null;
    }

    const rawLength = remote.headers.get('content-length');
    const parsedLength = rawLength === null ? Number.NaN : Number(rawLength);

    return {
      stream: Readable.fromWeb(remote.body as unknown as Parameters<typeof Readable.fromWeb>[0]),
      status: remote.status,
      contentRange: remote.headers.get('content-range'),
      contentLength: Number.isFinite(parsedLength) ? parsedLength : null,
    };
  } catch {
    return null;
  }
}
