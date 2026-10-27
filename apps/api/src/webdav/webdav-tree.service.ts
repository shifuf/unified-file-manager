import { Injectable } from '@nestjs/common';
import { FileStatus } from '@prisma/client';

import { folderPathKey } from '../common/utils/folder-path.util';
import { FolderManagerService } from '../files/folder-manager.service';
import { PrismaService } from '../prisma/prisma.service';
import type { WebdavAccount } from './webdav-account.service';
import { davBaseName, encodeHrefPath, xmlEscape, type DavNode } from './webdav.utils';

type ManagedFileRow = {
  id: string;
  originalName: string;
  folderPath: string | null;
  size: bigint;
  mimeType: string;
  updatedAt: Date;
  storageKey: string;
};

/** Projects `ManagedFile` + `ManagedFolder` rows into a WebDAV tree. */
@Injectable()
export class WebdavTreeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly folderManager: FolderManagerService,
  ) {}

  /** Immediate children of a collection ('' = project root). */
  async list(account: WebdavAccount, davPath: string): Promise<DavNode[]> {
    const prefix = folderPathKey(davPath);
    const [files, folders] = await Promise.all([
      this.prisma.managedFile.findMany({
        where: {
          projectId: account.projectId,
          status: FileStatus.ACTIVE,
          ...(prefix
            ? { OR: [{ folderPath: prefix }, { folderPath: { startsWith: `${prefix}/` } }] }
            : {}),
        },
        select: {
          id: true,
          originalName: true,
          folderPath: true,
          size: true,
          mimeType: true,
          updatedAt: true,
          storageKey: true,
        },
        orderBy: { originalName: 'asc' },
      }),
      this.prisma.managedFolder.findMany({
        where: {
          projectId: account.projectId,
          ...(prefix
            ? { OR: [{ path: prefix }, { path: { startsWith: `${prefix}/` } }] }
            : {}),
        },
        select: { path: true },
      }),
    ]);

    const collections = new Map<string, DavNode>();
    const nodes: DavNode[] = [];

    const addCollection = (path: string): void => {
      const relative = prefix ? path.slice(prefix.length).replace(/^\//, '') : path;
      const dirName = relative.split('/').filter(Boolean)[0];
      if (!dirName) {
        return;
      }
      const dirPath = prefix ? `${prefix}/${dirName}` : dirName;
      if (!collections.has(dirPath)) {
        collections.set(dirPath, this.directoryNode(dirPath, dirName));
      }
    };

    for (const folder of folders) {
      addCollection(folderPathKey(folder.path));
    }

    for (const file of files) {
      const folder = folderPathKey(file.folderPath);
      const relative = prefix ? folder.slice(prefix.length).replace(/^\//, '') : folder;
      const segments = relative.split('/').filter(Boolean);

      // Nested under a child directory -> expose that directory, not the file.
      if (segments.length > 0 && folder !== prefix) {
        addCollection(folder);
        continue;
      }

      nodes.push(this.fileNode(file));
    }

    return [...collections.values(), ...nodes].sort((a, b) => {
      if (a.isCollection !== b.isCollection) {
        return a.isCollection ? -1 : 1;
      }
      return a.name.localeCompare(b.name, 'zh-CN');
    });
  }

  /** Resolve one node, or null when it does not exist. */
  async stat(account: WebdavAccount, davPath: string): Promise<DavNode | null> {
    const normalized = folderPathKey(davPath);
    if (!normalized) {
      return this.directoryNode('', account.projectName);
    }

    const name = davBaseName(normalized);
    const parentSegment = normalized.slice(0, normalized.length - name.length).replace(/\/$/, '');
    const parent = folderPathKey(parentSegment);

    const file = await this.prisma.managedFile.findFirst({
      where: {
        projectId: account.projectId,
        originalName: name,
        folderPath: parent || null,
        status: FileStatus.ACTIVE,
      },
      select: {
        id: true,
        originalName: true,
        folderPath: true,
        size: true,
        mimeType: true,
        updatedAt: true,
        storageKey: true,
      },
    });

    if (file) {
      return this.fileNode(file);
    }

    const folder = await this.prisma.managedFolder.findFirst({
      where: { projectId: account.projectId, path: normalized },
      select: { id: true },
    });

    if (folder) {
      return this.directoryNode(normalized, name);
    }

    // Legacy folders that only exist because a file was uploaded into them.
    const membership = await this.prisma.managedFile.count({
      where: {
        projectId: account.projectId,
        status: FileStatus.ACTIVE,
        OR: [{ folderPath: normalized }, { folderPath: { startsWith: `${normalized}/` } }],
      },
    });

    return membership > 0 ? this.directoryNode(normalized, name) : null;
  }

  /** XML body describing a single node (PROPFIND depth 0). */
  propfindBody(account: WebdavAccount, node: DavNode): string {
    const href = `/api/dav/${account.projectId}${node.path ? `/${encodeHrefPath(node.path)}` : ''}`;
    const lastModified = (node.updatedAt ?? new Date()).toUTCString();

    return [
      '<D:response>',
      `<D:href>${xmlEscape(href)}</D:href>`,
      '<D:propstat><D:prop>',
      `<D:displayname>${xmlEscape(node.name)}</D:displayname>`,
      `<D:resourcetype>${node.isCollection ? '<D:collection/>' : ''}</D:resourcetype>`,
      `<D:getlastmodified>${lastModified}</D:getlastmodified>`,
      node.isCollection ? '' : `<D:getcontentlength>${node.size ?? 0}</D:getcontentlength>`,
      node.isCollection
        ? ''
        : `<D:getcontenttype>${xmlEscape(node.mimeType ?? 'application/octet-stream')}</D:getcontenttype>`,
      '</D:prop>',
      '<D:status>HTTP/1.1 200 OK</D:status>',
      '</D:propstat>',
      '</D:response>',
    ].join('');
  }

  private fileNode(file: ManagedFileRow): DavNode {
    const folder = folderPathKey(file.folderPath);
    return {
      path: folder ? `${folder}/${file.originalName}` : file.originalName,
      name: file.originalName,
      isCollection: false,
      size: Number(file.size),
      mimeType: file.mimeType,
      updatedAt: file.updatedAt,
      fileId: file.id,
    };
  }

  private directoryNode(path: string, name: string): DavNode {
    return {
      path,
      name: name || '根目录',
      isCollection: true,
      size: null,
      mimeType: null,
      updatedAt: null,
      fileId: null,
    };
  }

  /** MKCOL: register the collection so an empty folder is a real, listable node. */
  async createCollection(account: WebdavAccount, davPath: string): Promise<void> {
    const folderPath = folderPathKey(davPath);
    if (!folderPath) {
      return;
    }

    await this.folderManager.ensure(account.projectId, folderPath, `webdav:${account.username}`);
  }
}
