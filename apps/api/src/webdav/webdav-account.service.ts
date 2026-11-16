import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';

import { PASSWORD_SALT_ROUNDS } from '../common/constants';
import { encryptText } from '../common/utils/crypto.util';
import { getAppCryptoKey } from '../common/utils/security-config.util';
import { PrismaService } from '../prisma/prisma.service';
import { StorageAdapterRegistry } from '../storage/storage-registry.service';
import { StorageService } from '../storage/storage.service';

export type WebdavAccount = {
  projectId: string;
  /** Actual URL mount used by this request (alias or legacy project ID). */
  mountId?: string;
  projectName: string;
  username: string;
  passwordHash: string;
  provider: string;
  cdnConfigId: string | null;
  /** Local disk root when the project uses LOCAL storage; null for remote. */
  localRoot: string | null;
};

/** Password hashing / mounting URL helpers plus the project WebDAV record loader. */
@Injectable()
export class WebdavAccountService {
  private readonly logger = new Logger(WebdavAccountService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly registry: StorageAdapterRegistry,
    private readonly storageService: StorageService,
  ) {}

  hashPassword(plain: string): Promise<string> {
    return bcrypt.hash(plain, PASSWORD_SALT_ROUNDS);
  }

  verifyPassword(plain: string, hash: string): Promise<boolean> {
    return bcrypt.compare(plain, hash);
  }

  vaultPassword(plain: string): string {
    return encryptText(plain, getAppCryptoKey(this.configService));
  }

  /** Public WebDAV mount URL for a project (no credentials). */
  mountUrl(projectId: string, slug?: string | null): string {
    const publicUrl = (this.configService.get<string>('PUBLIC_URL') ?? '').trim().replace(/\/+$/, '');
    const path = `/api/dav/${slug || projectId}`;
    return publicUrl ? `${publicUrl}${path}` : path;
  }

  /** Settings view without password material. */
  async describe(projectId: string): Promise<{ enabled: boolean; username: string | null } | null> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, deletedAt: null },
      select: { webdavEnabled: true, webdavUsername: true },
    });

    if (!project) {
      return null;
    }

    return {
      enabled: Boolean(project.webdavEnabled),
      username: project.webdavUsername ?? null,
    };
  }

  /**
   * Authenticate the DAV account for a project. Returns null when WebDAV is off,
   * credentials are unset, or the supplied username does not match.
   */
  async authenticate(
    projectId: string,
    username: string,
    password: string,
  ): Promise<WebdavAccount | null> {
    const account = await this.loadAccount(projectId);
    if (!account || account.username !== username) {
      return null;
    }

    const ok = await this.verifyPassword(password, account.passwordHash);
    return ok ? account : null;
  }

  /** Load the WebDAV account, or null when disabled / not fully configured. */
  async loadAccount(mountId: string): Promise<WebdavAccount | null> {
    const project = await this.prisma.project.findFirst({
      where: { OR: [{ id: mountId }, { webdavSlug: mountId.toLowerCase() }], deletedAt: null, enabled: true, webdavEnabled: true },
      select: {
        id: true,
        name: true,
        webdavUsername: true,
        webdavPasswordHash: true,
        activeCdnConfigId: true,
      },
    });

    if (!project || !project.webdavUsername || !project.webdavPasswordHash) {
      return null;
    }

    let storage: Awaited<ReturnType<StorageService['getActiveStorage']>>;
    try {
      storage = await this.storageService.getActiveStorage(project.id);
    } catch (error) {
      this.logger.warn(
        `WebDAV 项目 ${project.id} 无法解析存储：${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }

    return {
      projectId: project.id,
      mountId,
      projectName: project.name,
      username: project.webdavUsername,
      passwordHash: project.webdavPasswordHash,
      provider: storage.provider,
      cdnConfigId: project.activeCdnConfigId ?? null,
      localRoot: this.registry.localRoot(storage),
    };
  }
}
