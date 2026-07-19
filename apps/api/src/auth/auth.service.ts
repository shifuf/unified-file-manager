import { createHash, randomBytes } from 'node:crypto';

import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { AuditAction, UserRole } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

import { AuditService } from '../audit/audit.service';
import { PASSWORD_SALT_ROUNDS } from '../common/constants';
import type { RequestUser } from '../common/types/request-user.type';
import { decryptText, encryptText } from '../common/utils/crypto.util';
import { InMemoryAttemptLimiter } from '../common/utils/in-memory-attempt-limiter';
import { getAppCryptoKey } from '../common/utils/security-config.util';
import { buildTotpUri, generateTotpSecret, verifyTotpCode } from '../common/utils/totp.util';
import { PrismaService } from '../prisma/prisma.service';
import { ChangePasswordDto } from './dto/change-password.dto';
import { LoginDto } from './dto/login.dto';

interface LoginSuccess {
  requiresTotp: false;
  accessToken: string;
  refreshToken: string;
  user: {
    id: string;
    username: string;
    displayName: string;
    role: string;
    totpEnabled: boolean;
    mustChangePassword: boolean;
  };
}

interface LoginTotpChallenge {
  requiresTotp: true;
}

@Injectable()
export class AuthService {
  // Per-(username, IP) limiter: stops a single client brute-forcing one account.
  private readonly loginAttemptLimiter = new InMemoryAttemptLimiter({
    maxAttempts: 5,
    windowMs: 15 * 60 * 1000,
    lockMs: 15 * 60 * 1000,
  });
  // Per-username limiter (IP-independent): stops distributed/IP-rotating attacks
  // from bypassing the lockout by spreading attempts across many source IPs.
  private readonly loginAccountLimiter = new InMemoryAttemptLimiter({
    maxAttempts: 15,
    windowMs: 15 * 60 * 1000,
    lockMs: 15 * 60 * 1000,
  });

  constructor(
    private readonly auditService: AuditService,
    private readonly configService: ConfigService,
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async login(dto: LoginDto, meta: { ip?: string; userAgent?: string }): Promise<LoginSuccess | LoginTotpChallenge> {
    const attemptKey = this.loginAttemptKey(dto.username, meta.ip);
    const accountKey = this.loginAccountKey(dto.username);
    this.loginAttemptLimiter.assertAllowed(attemptKey, '登录失败次数过多');
    this.loginAccountLimiter.assertAllowed(accountKey, '该账号登录失败次数过多');
    const user = await this.prisma.user.findUnique({ where: { username: dto.username } });
    const validPassword = user ? await bcrypt.compare(dto.password, user.passwordHash) : false;

    if (!user || !user.enabled || !validPassword) {
      this.recordLoginFailure(attemptKey, accountKey);
      throw new UnauthorizedException('用户名或密码错误。');
    }

    // Single super-admin console: reject every other role with the same generic error.
    if (user.role !== UserRole.SUPER_ADMIN) {
      this.recordLoginFailure(attemptKey, accountKey);
      throw new UnauthorizedException('用户名或密码错误。');
    }

    if (user.totpEnabled) {
      if (!dto.totpCode) {
        return { requiresTotp: true };
      }

      const secret = this.decryptTotpSecret(user.totpSecret);
      if (!secret || !verifyTotpCode(secret, dto.totpCode)) {
        this.recordLoginFailure(attemptKey, accountKey);
        throw new UnauthorizedException('二次验证码错误。');
      }
    }

    this.loginAttemptLimiter.reset(attemptKey);
    this.loginAccountLimiter.reset(accountKey);

    await this.auditService.write({
      action: AuditAction.LOGIN,
      actorId: user.id,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return this.issueSession(user, meta);
  }

  /**
   * Exchange a valid (non-revoked, unexpired) refresh token for a fresh access
   * token, rotating the refresh token.
   *
   * Multi-tab grace: if the presented token was already rotated but still has a
   * live replacement (replacedById points at a non-revoked, unexpired token),
   * issue one more session instead of revoking the whole family. True reuse of a
   * fully-dead rotated token still revokes all live sessions (theft detection).
   */
  async refresh(
    refreshToken: string | undefined,
    meta: { ip?: string; userAgent?: string },
  ): Promise<LoginSuccess> {
    if (!refreshToken) {
      throw new UnauthorizedException('刷新令牌无效，请重新登录。');
    }

    const tokenHash = this.hashToken(refreshToken);
    const existing = await this.prisma.refreshToken.findUnique({ where: { tokenHash } });

    if (!existing) {
      throw new UnauthorizedException('刷新令牌无效，请重新登录。');
    }

    if (existing.revokedAt) {
      // Grace path for concurrent multi-tab refresh races.
      if (existing.replacedById) {
        const replacement = await this.prisma.refreshToken.findUnique({
          where: { tokenHash: existing.replacedById },
        });
        if (
          replacement &&
          !replacement.revokedAt &&
          replacement.expiresAt.getTime() > Date.now() &&
          replacement.userId === existing.userId
        ) {
          const user = await this.prisma.user.findUnique({ where: { id: existing.userId } });
          if (user && user.enabled) {
            // Issue a fresh session; do not revoke the still-valid replacement.
            return this.issueSession(user, meta);
          }
        }
      }

      await this.prisma.refreshToken.updateMany({
        where: { userId: existing.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      throw new UnauthorizedException('刷新令牌已失效，请重新登录。');
    }

    if (existing.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException('刷新令牌已过期，请重新登录。');
    }

    const user = await this.prisma.user.findUnique({ where: { id: existing.userId } });
    if (!user || !user.enabled) {
      throw new UnauthorizedException('登录状态无效，请重新登录。');
    }

    const session = await this.issueSession(user, meta);
    await this.prisma.refreshToken.update({
      where: { id: existing.id },
      data: { revokedAt: new Date(), replacedById: this.hashToken(session.refreshToken) },
    });

    return session;
  }

  async getProfile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        displayName: true,
        role: true,
        totpEnabled: true,
        mustChangePassword: true,
      },
    });
    if (!user) {
      throw new UnauthorizedException('用户不存在。');
    }
    return user;
  }

  async revokeRefreshToken(refreshToken?: string): Promise<{ success: boolean }> {
    if (refreshToken) {
      await this.prisma.refreshToken.updateMany({
        where: { tokenHash: this.hashToken(refreshToken), revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }

    return { success: true };
  }

  async setupTotp(user: RequestUser): Promise<{
    secret: string;
    otpauthUrl: string;
    issuer: string;
    account: string;
    enabled: boolean;
  }> {
    const existing = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { username: true, enabled: true, totpEnabled: true },
    });

    if (!existing?.enabled) {
      throw new UnauthorizedException('登录状态无效，请重新登录。');
    }

    if (existing.totpEnabled) {
      throw new BadRequestException('二次验证已启用，如需重新绑定请先关闭。');
    }

    const secret = generateTotpSecret();
    const issuer = this.getTotpIssuer();
    const account = existing.username;

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        totpSecret: encryptText(secret, this.getCryptoKey()),
        totpEnabled: false,
      },
    });

    return {
      secret,
      otpauthUrl: buildTotpUri({ issuer, account, secret }),
      issuer,
      account,
      enabled: false,
    };
  }

  async enableTotp(user: RequestUser, code: string): Promise<{ enabled: boolean }> {
    const existing = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { totpEnabled: true, totpSecret: true },
    });

    if (!existing) {
      throw new UnauthorizedException('登录状态无效，请重新登录。');
    }

    if (existing.totpEnabled) {
      throw new BadRequestException('二次验证已启用。');
    }

    const secret = this.decryptTotpSecret(existing.totpSecret);
    if (!secret) {
      throw new BadRequestException('请先生成二次验证密钥。');
    }

    if (!verifyTotpCode(secret, code)) {
      throw new BadRequestException('二次验证码错误。');
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { totpEnabled: true },
    });

    await this.auditService.write({
      action: AuditAction.USER_2FA_ENABLE,
      actorId: user.id,
      detail: { username: user.username },
    });

    return { enabled: true };
  }

  async disableTotp(user: RequestUser, code: string): Promise<{ enabled: boolean }> {
    const existing = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { totpEnabled: true, totpSecret: true },
    });

    if (!existing) {
      throw new UnauthorizedException('登录状态无效，请重新登录。');
    }

    const secret = this.decryptTotpSecret(existing.totpSecret);
    if (!existing.totpEnabled || !secret) {
      throw new BadRequestException('二次验证未启用。');
    }

    if (!verifyTotpCode(secret, code)) {
      throw new BadRequestException('二次验证码错误。');
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { totpEnabled: false, totpSecret: null },
    });

    await this.auditService.write({
      action: AuditAction.USER_2FA_DISABLE,
      actorId: user.id,
      detail: { username: user.username },
    });

    return { enabled: false };
  }

  async getTotpStatus(user: RequestUser): Promise<{ enabled: boolean }> {
    const existing = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { totpEnabled: true },
    });

    if (!existing) {
      throw new UnauthorizedException('登录状态无效，请重新登录。');
    }

    return { enabled: existing.totpEnabled };
  }

  private decryptTotpSecret(secretVault: string | null): string | null {
    if (!secretVault) {
      return null;
    }

    try {
      return decryptText(secretVault, this.getCryptoKey());
    } catch {
      throw new UnauthorizedException('二次验证配置无效，请联系管理员。');
    }
  }

  private getCryptoKey(): string {
    return getAppCryptoKey(this.configService);
  }

  private getTotpIssuer(): string {
    return this.configService.get<string>('TOTP_ISSUER', '统一文件管理系统');
  }

  private loginAttemptKey(username: string, ip?: string): string {
    return `login:${username.trim().toLowerCase()}:${ip ?? 'unknown'}`;
  }

  private loginAccountKey(username: string): string {
    return `login-account:${username.trim().toLowerCase()}`;
  }

  private recordLoginFailure(attemptKey: string, accountKey: string): void {
    this.loginAttemptLimiter.recordFailure(attemptKey);
    this.loginAccountLimiter.recordFailure(accountKey);
  }

  private async issueSession(
    user: {
      id: string;
      username: string;
      displayName: string;
      role: string;
      totpEnabled: boolean;
      mustChangePassword?: boolean;
    },
    meta: { ip?: string; userAgent?: string },
  ): Promise<LoginSuccess> {
    const accessToken = await this.jwtService.signAsync({
      sub: user.id,
      username: user.username,
      role: user.role,
    });
    const refreshToken = randomBytes(48).toString('base64url');
    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: this.hashToken(refreshToken),
        expiresAt: new Date(Date.now() + this.refreshTtlMs()),
        userAgent: meta.userAgent?.slice(0, 255),
        ip: meta.ip,
      },
    });

    return {
      requiresTotp: false,
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        role: user.role,
        totpEnabled: user.totpEnabled,
        mustChangePassword: Boolean(user.mustChangePassword),
      },
    };
  }

  async listSessions(user: RequestUser, currentRefreshToken?: string) {
    const currentHash = currentRefreshToken ? this.hashToken(currentRefreshToken) : null;
    const rows = await this.prisma.refreshToken.findMany({
      where: {
        userId: user.id,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return rows.map((row) => ({
      id: row.id,
      ip: row.ip,
      userAgent: row.userAgent,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      current: currentHash ? row.tokenHash === currentHash : false,
    }));
  }

  async revokeSession(user: RequestUser, sessionId: string): Promise<{ success: boolean }> {
    const row = await this.prisma.refreshToken.findFirst({
      where: { id: sessionId, userId: user.id, revokedAt: null },
    });
    if (!row) {
      throw new BadRequestException('会话不存在或已失效。');
    }
    await this.prisma.refreshToken.update({
      where: { id: sessionId },
      data: { revokedAt: new Date() },
    });
    await this.auditService.write({
      action: AuditAction.SESSION_REVOKE,
      actorId: user.id,
      detail: { sessionId },
    });
    return { success: true };
  }

  async revokeOtherSessions(user: RequestUser, currentRefreshToken?: string): Promise<{ success: boolean; revoked: number }> {
    const currentHash = currentRefreshToken ? this.hashToken(currentRefreshToken) : null;
    const result = await this.prisma.refreshToken.updateMany({
      where: {
        userId: user.id,
        revokedAt: null,
        ...(currentHash ? { tokenHash: { not: currentHash } } : {}),
      },
      data: { revokedAt: new Date() },
    });
    await this.auditService.write({
      action: AuditAction.SESSION_REVOKE,
      actorId: user.id,
      detail: { allOthers: true, revoked: result.count },
    });
    return { success: true, revoked: result.count };
  }

  async revokeAllSessions(userId: string): Promise<number> {
    const result = await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return result.count;
  }

  async changePassword(user: RequestUser, dto: ChangePasswordDto): Promise<{ success: boolean }> {
    const existing = await this.prisma.user.findUnique({ where: { id: user.id } });
    const validPassword = existing ? await bcrypt.compare(dto.currentPassword, existing.passwordHash) : false;

    if (!existing || !existing.enabled || !validPassword) {
      throw new BadRequestException('当前密码错误。');
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: await bcrypt.hash(dto.newPassword, PASSWORD_SALT_ROUNDS),
        mustChangePassword: false,
      },
    });

    await this.prisma.refreshToken.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    await this.auditService.write({
      action: AuditAction.USER_PASSWORD_CHANGE,
      actorId: user.id,
      detail: { username: user.username },
    });

    return { success: true };
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private refreshTtlMs(): number {
    const days = Number(this.configService.get<number>('JWT_REFRESH_EXPIRES_DAYS', 30)) || 30;
    return Math.max(1, days) * 24 * 60 * 60 * 1000;
  }
}
