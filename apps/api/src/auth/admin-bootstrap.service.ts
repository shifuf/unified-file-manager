import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UserRole } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

import { getConfigBoolean, isProduction } from '../common/utils/security-config.util';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AdminBootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AdminBootstrapService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const username = this.normalizeEnvValue(
      this.configService.get<string>('ADMIN_USERNAME'),
      isProduction(this.configService) ? undefined : 'admin',
      'ADMIN_USERNAME',
    );
    const password = this.normalizeEnvValue(
      this.configService.get<string>('ADMIN_PASSWORD'),
      isProduction(this.configService) ? undefined : 'Admin@123456',
      'ADMIN_PASSWORD',
    );

    if (isProduction(this.configService)) {
      this.assertStrongAdminPassword(password);
    }

    const existing = await this.prisma.user.findUnique({ where: { username } });
    const passwordSync = getConfigBoolean(this.configService, 'ADMIN_PASSWORD_SYNC', false);

    if (!existing) {
      const passwordHash = await bcrypt.hash(password, 12);
      await this.prisma.user.create({
        data: {
          username,
          displayName: '系统管理员',
          passwordHash,
          role: UserRole.SUPER_ADMIN,
          enabled: true,
          mustChangePassword: false,
        },
      });
      this.logger.log(`Administrator "${username}" created from .env.`);
    } else if (passwordSync) {
      const passwordHash = await bcrypt.hash(password, 12);
      await this.prisma.user.update({
        where: { id: existing.id },
        data: {
          passwordHash,
          enabled: true,
          role: UserRole.SUPER_ADMIN,
        },
      });
      // Force-sync revokes sessions so a known-stale password cannot stay live.
      await this.prisma.refreshToken.updateMany({
        where: { userId: existing.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      this.logger.warn(
        `Administrator "${username}" password synchronized from .env (ADMIN_PASSWORD_SYNC=true); sessions revoked.`,
      );
    } else {
      // Keep the console single-admin: force role/enabled, never clobber an operator-chosen password.
      await this.prisma.user.update({
        where: { id: existing.id },
        data: {
          enabled: true,
          role: UserRole.SUPER_ADMIN,
        },
      });
      this.logger.log(
        `Administrator "${username}" ready; password left unchanged (set ADMIN_PASSWORD_SYNC=true to force).`,
      );
    }

    // Single operator: disable every account that is not the env admin username.
    const disabled = await this.prisma.user.updateMany({
      where: {
        username: { not: username },
        enabled: true,
      },
      data: { enabled: false },
    });
    if (disabled.count > 0) {
      this.logger.warn(`Disabled ${disabled.count} non-primary account(s) (single super-admin mode).`);
      await this.prisma.refreshToken.updateMany({
        where: {
          revokedAt: null,
          user: { username: { not: username } },
        },
        data: { revokedAt: new Date() },
      });
    }
  }

  private assertStrongAdminPassword(password: string): void {
    if (password.length < 12) {
      throw new Error('ADMIN_PASSWORD must be at least 12 characters in production.');
    }
    const weak = new Set(['admin@123456', 'admin123456', 'password', '12345678', 'change-this-password']);
    if (weak.has(password.toLowerCase()) || password.toLowerCase().startsWith('change-this')) {
      throw new Error('ADMIN_PASSWORD is too weak for production.');
    }
  }

  private normalizeEnvValue(value: string | undefined, fallback: string | undefined, key: string): string {
    const normalized = value?.trim();
    const resolved = normalized || fallback;

    if (!resolved) {
      throw new Error(`${key} must be set before starting the API.`);
    }

    return resolved;
  }
}
