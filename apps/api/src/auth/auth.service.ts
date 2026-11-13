import { createHash, createHmac, randomBytes } from 'node:crypto';

import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { AuditAction, Prisma, UserRole } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

import { AuditService } from '../audit/audit.service';
import { PASSWORD_SALT_ROUNDS } from '../common/constants';
import type { RequestUser } from '../common/types/request-user.type';
import { decryptText, encryptText } from '../common/utils/crypto.util';
import { InMemoryAttemptLimiter } from '../common/utils/in-memory-attempt-limiter';
import { getAppCryptoKey, getJwtSecret } from '../common/utils/security-config.util';
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

type SessionUser = Omit<LoginSuccess['user'], 'mustChangePassword'> & { mustChangePassword?: boolean };

const REFRESH_GRACE_MS = 5000;

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
      userAgent: this.deviceUserAgent(meta.userAgent) ?? undefined,
    });

    return this.issueSession(user, meta);
  }

  /** Rotate one device row; concurrent tabs share its replacement for five seconds. */
  async refresh(
    refreshToken: string | undefined,
    meta: { ip?: string; userAgent?: string },
  ): Promise<LoginSuccess> {
    if (!refreshToken) {
      throw new UnauthorizedException('刷新令牌无效，请重新登录。');
    }

    const tokenHash = this.hashToken(refreshToken);
    const candidate =
      (await this.prisma.refreshToken.findUnique({ where: { tokenHash } })) ??
      (await this.prisma.refreshToken.findFirst({
        where: { replacedById: { startsWith: 'rotate:', endsWith: `:${tokenHash}` } },
      }));
    if (!candidate) {
      throw new UnauthorizedException('刷新令牌无效，请重新登录。');
    }
    return this.prisma.$transaction(async (tx) => {
      // Serialize device creation and rotation across API instances, without a schema change.
      await tx.$queryRaw(Prisma.sql`SELECT id FROM \`User\` WHERE id = ${candidate.userId} FOR UPDATE`);
      const existing = await tx.refreshToken.findUnique({ where: { id: candidate.id } });
      const user = await tx.user.findUnique({ where: { id: candidate.userId } });
      const now = Date.now();
      if (
        !existing || existing.revokedAt || existing.expiresAt.getTime() <= now ||
        !user?.enabled || user.role !== UserRole.SUPER_ADMIN ||
        existing.ip !== (meta.ip ?? null) || existing.userAgent !== this.deviceUserAgent(meta.userAgent)
      ) {
        throw new UnauthorizedException('刷新令牌已失效，请重新登录。');
      }

      if (existing.tokenHash !== tokenHash) {
        const replacement = this.rotationGraceToken(refreshToken, existing, now);
        if (!replacement) {
          throw new UnauthorizedException('刷新令牌已失效，请重新登录。');
        }
        // Reissue only the current credentials; never revive the presented old token.
        return this.sessionResponse(user, replacement);
      }

      const replacement = this.rotatedRefreshToken(refreshToken, existing.id, now);
      const changed = await tx.refreshToken.updateMany({
        where: { id: existing.id, tokenHash, revokedAt: null, expiresAt: { gt: new Date(now) } },
        data: {
          tokenHash: this.hashToken(replacement),
          expiresAt: new Date(now + this.refreshTtlMs()),
          replacedById: `rotate:${now}:${tokenHash}`,
        },
      });
      if (changed.count !== 1) {
        throw new UnauthorizedException('刷新令牌已失效，请重新登录。');
      }
      await tx.refreshToken.updateMany({
        where: { ...this.deviceWhere(user.id, meta), id: { not: existing.id }, revokedAt: null },
        data: { revokedAt: new Date(now) },
      });
      return this.sessionResponse(user, replacement);
    });
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
      const tokenHash = this.hashToken(refreshToken);
      const candidate =
        (await this.prisma.refreshToken.findUnique({ where: { tokenHash } })) ??
        (await this.prisma.refreshToken.findFirst({
          where: { replacedById: { startsWith: 'rotate:', endsWith: `:${tokenHash}` } },
        }));
      if (candidate) {
        await this.prisma.$transaction(async (tx) => {
          await tx.$queryRaw(Prisma.sql`SELECT id FROM \`User\` WHERE id = ${candidate.userId} FOR UPDATE`);
          const row = await tx.refreshToken.findUnique({ where: { id: candidate.id } });
          const now = new Date(Date.now());
          if (!row || row.revokedAt || row.expiresAt <= now) return;
          if (row.tokenHash !== tokenHash && !this.rotationGraceToken(refreshToken, row, now.getTime())) return;
          const changed = await tx.refreshToken.updateMany({
            where: { id: row.id, tokenHash: row.tokenHash, revokedAt: null },
            data: { revokedAt: now },
          });
          if (changed.count === 1) {
            await tx.refreshToken.updateMany({
              where: { userId: row.userId, ip: row.ip, userAgent: row.userAgent, id: { not: row.id }, revokedAt: null },
              data: { revokedAt: now },
            });
          }
        });
      }
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
    user: SessionUser,
    meta: { ip?: string; userAgent?: string },
  ): Promise<LoginSuccess> {
    const refreshToken = randomBytes(48).toString('base64url');
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM \`User\` WHERE id = ${user.id} FOR UPDATE`);
      const now = new Date(Date.now());
      const device = this.deviceWhere(user.id, meta);
      const existing = await tx.refreshToken.findFirst({
        where: { ...device, revokedAt: null, expiresAt: { gt: now } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      const data = {
        tokenHash: this.hashToken(refreshToken),
        expiresAt: new Date(now.getTime() + this.refreshTtlMs()),
        replacedById: null,
      };
      if (existing) {
        const changed = await tx.refreshToken.updateMany({
          where: { id: existing.id, tokenHash: existing.tokenHash, revokedAt: null, expiresAt: { gt: now } },
          data,
        });
        if (changed.count !== 1) throw new UnauthorizedException('登录状态刚刚变更，请重试。');
        await tx.refreshToken.updateMany({
          where: { ...device, id: { not: existing.id }, revokedAt: null },
          data: { revokedAt: now },
        });
      } else {
        await tx.refreshToken.create({ data: { ...device, ...data } });
      }
      return this.sessionResponse(user, refreshToken);
    });
  }

  private deviceUserAgent(userAgent?: string): string | null {
    if (!userAgent) return null;
    if (userAgent.length <= 255 && !userAgent.includes(' [ufm-ua-sha256:')) return userAgent;
    // The existing column is 255 chars: keep a readable prefix and fingerprint the full UA.
    const suffix = ` [ufm-ua-sha256:${this.hashToken(userAgent)}]`;
    return userAgent.slice(0, 255 - suffix.length) + suffix;
  }

  private deviceWhere(userId: string, meta: { ip?: string; userAgent?: string }) {
    return { userId, ip: meta.ip ?? null, userAgent: this.deviceUserAgent(meta.userAgent) };
  }

  private rotatedRefreshToken(previous: string, sessionId: string, rotatedAt: number): string {
    return createHmac('sha384', getJwtSecret(this.configService))
      .update(`ufm-device-refresh\n${sessionId}\n${rotatedAt}\n${previous}`)
      .digest('base64url');
  }

  private rotationGraceToken(
    previous: string,
    row: { id: string; tokenHash: string; replacedById: string | null },
    now: number,
  ): string | null {
    const rotation = /^rotate:(\d+):([a-f0-9]{64})$/.exec(row.replacedById ?? '');
    const rotatedAt = rotation ? Number(rotation[1]) : NaN;
    if (
      !rotation || rotation[2] !== this.hashToken(previous) || !Number.isSafeInteger(rotatedAt) ||
      now < rotatedAt || now - rotatedAt > REFRESH_GRACE_MS
    ) return null;
    const replacement = this.rotatedRefreshToken(previous, row.id, rotatedAt);
    return this.hashToken(replacement) === row.tokenHash ? replacement : null;
  }

  private async sessionResponse(user: SessionUser, refreshToken: string): Promise<LoginSuccess> {
    const accessToken = await this.jwtService.signAsync({ sub: user.id, username: user.username, role: user.role });

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
    });
    const devices = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      const key = JSON.stringify([row.ip, row.userAgent]);
      if (!devices.has(key) || row.tokenHash === currentHash) devices.set(key, row);
    }
    return [...devices.values()]
      .sort((a, b) => Number(b.tokenHash === currentHash) - Number(a.tokenHash === currentHash) || b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, 50)
      .map((row) => ({
        id: row.id,
        ip: row.ip,
        userAgent: row.userAgent,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
        current: currentHash ? row.tokenHash === currentHash : false,
      }));
  }

  async revokeSession(user: RequestUser, sessionId: string): Promise<{ success: boolean }> {
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM \`User\` WHERE id = ${user.id} FOR UPDATE`);
      const row = await tx.refreshToken.findFirst({
        where: { id: sessionId, userId: user.id, revokedAt: null },
      });
      if (!row) throw new BadRequestException('会话不存在或已失效。');
      // A displayed legacy device can represent several rows; revoke that device as a group.
      await tx.refreshToken.updateMany({
        where: { userId: user.id, ip: row.ip, userAgent: row.userAgent, revokedAt: null },
        data: { revokedAt: new Date(Date.now()) },
      });
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
