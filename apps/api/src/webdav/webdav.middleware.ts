import { Injectable, Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

import { DownloadStatsService } from '../files/download-stats.service';
import type { WebdavAccount } from './webdav-account.service';
import { WebdavAccountService } from './webdav-account.service';
import { WebdavFileService } from './webdav-file.service';
import { dispatchDav } from './webdav-verbs';
import { WebdavTreeService } from './webdav-tree.service';
import { normalizeDavPath } from './webdav.utils';

const DAV_METHODS = [
  'OPTIONS',
  'PROPFIND',
  'GET',
  'HEAD',
  'PUT',
  'DELETE',
  'MKCOL',
  'MOVE',
  'COPY',
  'LOCK',
  'UNLOCK',
] as const;

type DavMethod = (typeof DAV_METHODS)[number];

/**
 * Express-level WebDAV endpoint.
 *
 * Nest's HTTP decorators cannot express PROPFIND / MKCOL / COPY / MOVE / LOCK /
 * UNLOCK, so WebDAV is implemented as a middleware mounted in `main.ts`. Every
 * request under `/api/dav/:projectId` is authenticated with Basic auth using the
 * per-project credentials stored on `Project`.
 */
@Injectable()
export class WebdavMiddleware {
  private readonly logger = new Logger(WebdavMiddleware.name);

  constructor(
    private readonly accountService: WebdavAccountService,
    private readonly fileService: WebdavFileService,
    private readonly statsService: DownloadStatsService,
    private readonly treeService: WebdavTreeService,
  ) {}

  handle = async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    const url = (request.originalUrl || request.url || '').split('?')[0];

    if (!url.startsWith('/api/dav/')) {
      next();
      return;
    }

    try {
      await this.dispatchRequest(request, response, url);
    } catch (error) {
      this.logger.error(
        `WebDAV 未捕获错误：${error instanceof Error ? error.message : String(error)}`,
      );
      if (!response.headersSent) {
        response.status(500).end();
      }
    }
  };

  private async dispatchRequest(request: Request, response: Response, url: string): Promise<void> {
    const projectId = url.split('/')[3] ?? '';
    const davPath = normalizeDavPath(url.replace(`/api/dav/${projectId}`, '').replace(/^\/+/, ''));
    const method = (request.method || '').toUpperCase() as DavMethod;

    if (!DAV_METHODS.includes(method)) {
      response.status(405).end();
      return;
    }

    const account = await this.accountService.loadAccount(projectId);
    if (!account) {
      response.status(404).end();
      return;
    }

    if (method === 'OPTIONS') {
      this.writeDavHeaders(response);
      response.status(200).end();
      return;
    }

    if (!(await this.authenticate(account, request, response))) {
      return;
    }

    try {
      await dispatchDav(
        { fileService: this.fileService, statsService: this.statsService, treeService: this.treeService },
        method,
        account,
        davPath,
        request,
        response,
      );
    } catch (error) {
      const status =
        error && typeof error === 'object' && typeof (error as { getStatus?: () => number }).getStatus === 'function'
          ? Number((error as { getStatus: () => number }).getStatus())
          : 500;
      const message = error instanceof Error ? error.message : 'WebDAV 请求失败。';
      this.logger.warn(`WebDAV ${method} /${davPath} 失败：${message}`);
      if (!response.headersSent) {
        response.status(Number.isFinite(status) && status >= 400 ? status : 500).send(message);
      } else {
        response.end();
      }
    }
  }

  private async authenticate(account: WebdavAccount, request: Request, response: Response): Promise<boolean> {
    const header = String(request.headers.authorization ?? '');
    const match = /^Basic\s+(.+)$/i.exec(header);

    if (!match) {
      this.challenge(response);
      return false;
    }

    const decoded = Buffer.from(match[1], 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    const username = separator < 0 ? decoded : decoded.slice(0, separator);
    const password = separator < 0 ? '' : decoded.slice(separator + 1);

    if (username !== account.username) {
      this.challenge(response);
      return false;
    }

    const valid = await this.accountService.verifyPassword(password, account.passwordHash);
    if (!valid) {
      this.challenge(response);
      return false;
    }

    return true;
  }

  private challenge(response: Response): void {
    response.setHeader('WWW-Authenticate', 'Basic realm="UFM WebDAV"');
    response.status(401).end();
  }

  private writeDavHeaders(response: Response): void {
    response.setHeader('DAV', '1, 2');
    response.setHeader('MS-Author-Via', 'DAV');
    response.setHeader('Accept-Ranges', 'bytes');
    response.setHeader('Allow', DAV_METHODS.join(', '));
  }
}
