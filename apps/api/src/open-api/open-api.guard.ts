import { BadRequestException, CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type ProjectSecret } from '@prisma/client';

import { SIGNATURE_EXPIRE_SECONDS } from '../common/constants';
import {
  buildSignedPayload,
  decryptText,
  hmacSha256Hex,
  safeCompare,
} from '../common/utils/crypto.util';
import {
  getAppCryptoKey,
  getPreviousAppCryptoKeys,
} from '../common/utils/security-config.util';
import { PrismaService } from '../prisma/prisma.service';
import type { OpenApiRequest } from './open-api.types';

@Injectable()
export class OpenApiGuard implements CanActivate {
  private nextNonceCleanupAt = 0;
  private readonly nonceCleanupIntervalMs = 60_000;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<OpenApiRequest>();
    const appId = this.readHeader(request, 'x-app-id');
    const timestamp = this.readHeader(request, 'x-timestamp');
    const nonce = this.readHeader(request, 'x-nonce');
    const signature = this.readHeader(request, 'x-signature');

    if (!appId || !timestamp || !nonce || !signature) {
      throw new UnauthorizedException('缺少开放接口签名头。');
    }

    if (nonce.length > 128) {
      throw new BadRequestException('Nonce 不能超过 128 个字符。');
    }

    const timestampSeconds = Number(timestamp);
    if (!Number.isFinite(timestampSeconds)) {
      throw new BadRequestException('时间戳格式错误。');
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSeconds - timestampSeconds) > SIGNATURE_EXPIRE_SECONDS) {
      throw new UnauthorizedException('请求时间戳已过期。');
    }

    const project = await this.prisma.project.findFirst({
      where: { appId, enabled: true, deletedAt: null },
      include: {
        apiSecrets: {
          where: { enabled: true },
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!project) {
      throw new UnauthorizedException('AppID 无效。');
    }

    const method = request.method;
    // Prefer originalUrl path (strips query) so a reverse-proxy rewrite of
    // req.url still signs the path the client actually used.
    const path = (request.originalUrl || request.url || request.path || '').split('?')[0] || request.path;
    const query = (request.query || {}) as Record<string, unknown>;
    const body = request.rawBody ? request.rawBody.toString('utf8') : '';

    // Open API signature is v2 only: method + path + timestamp + nonce + query + bodySha256.
    const payloads = [buildSignedPayload({ method, path, timestamp, nonce, query, body })];
    // When Nest's global prefix is stripped from request.path in some adapters,
    // also try the client-facing /api/... form that integrators actually sign.
    if (!path.startsWith('/api/') && path.startsWith('/')) {
      payloads.push(buildSignedPayload({ method, path: `/api${path}`, timestamp, nonce, query, body }));
    }

    let matchedSecretId: string | null | undefined;
    for (const payload of payloads) {
      matchedSecretId = this.findMatchedSecretId(
        signature,
        payload,
        project.apiSecrets,
        project.appSecretVault,
      );
      if (matchedSecretId !== undefined) {
        break;
      }
    }

    if (matchedSecretId === undefined) {
      throw new UnauthorizedException('接口签名校验失败。');
    }

    await this.assertNonceUnused(appId, nonce, nowSeconds);
    if (matchedSecretId) {
      await this.prisma.projectSecret.update({
        where: { id: matchedSecretId },
        data: { lastUsedAt: new Date() },
      });
    }
    request.openProject = project;
    return true;
  }

  private readHeader(request: OpenApiRequest, key: string): string | undefined {
    const value = request.headers[key];

    if (Array.isArray(value)) {
      return value[0];
    }

    return value;
  }

  private async assertNonceUnused(appId: string, nonce: string, nowSeconds: number): Promise<void> {
    await this.cleanupExpiredNonces(nowSeconds);

    try {
      await this.createNonce(appId, nonce, nowSeconds);
    } catch (error) {
      if (this.isUniqueConstraintError(error)) {
        await this.retryExpiredNonce(appId, nonce, nowSeconds);
        return;
      }

      throw error;
    }
  }

  private async cleanupExpiredNonces(nowSeconds: number): Promise<void> {
    const nowMs = nowSeconds * 1000;
    if (Date.now() < this.nextNonceCleanupAt) {
      return;
    }

    this.nextNonceCleanupAt = Date.now() + this.nonceCleanupIntervalMs;
    await this.prisma.openApiNonce.deleteMany({
      where: { expiresAt: { lte: new Date(nowMs) } },
    });
  }

  private async retryExpiredNonce(appId: string, nonce: string, nowSeconds: number): Promise<void> {
    const existing = await this.prisma.openApiNonce.findUnique({
      where: { appId_nonce: { appId, nonce } },
      select: { expiresAt: true },
    });

    if (!existing || existing.expiresAt.getTime() > nowSeconds * 1000) {
      throw new UnauthorizedException('请求已被使用，请重新生成签名。');
    }

    await this.prisma.openApiNonce.deleteMany({
      where: { appId, nonce, expiresAt: { lte: new Date(nowSeconds * 1000) } },
    });

    try {
      await this.createNonce(appId, nonce, nowSeconds);
    } catch (error) {
      if (this.isUniqueConstraintError(error)) {
        throw new UnauthorizedException('请求已被使用，请重新生成签名。');
      }

      throw error;
    }
  }

  private async createNonce(appId: string, nonce: string, nowSeconds: number): Promise<void> {
    await this.prisma.openApiNonce.create({
      data: {
        appId,
        nonce,
        // A signature is accepted while |now - timestamp| <= EXPIRE, and the timestamp
        // may lead by up to EXPIRE. So a signature minted now can stay valid until
        // now + 2*EXPIRE. The nonce must outlive that whole window, otherwise it would
        // be cleaned up while the signature is still replayable.
        expiresAt: new Date((nowSeconds + 2 * SIGNATURE_EXPIRE_SECONDS) * 1000),
      },
    });
  }

  private isUniqueConstraintError(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
  }

  private findMatchedSecretId(
    signature: string,
    payload: string,
    activeSecrets: Array<Pick<ProjectSecret, 'id' | 'secretVault'>>,
    legacyVault: string,
  ): string | null | undefined {
    for (const secret of activeSecrets) {
      const expectedSignature = this.buildExpectedSignature(secret.secretVault, payload);
      if (expectedSignature && safeCompare(signature, expectedSignature)) {
        return secret.id;
      }
    }

    const legacySignature = this.buildExpectedSignature(legacyVault, payload);
    if (legacySignature && safeCompare(signature, legacySignature)) {
      return null;
    }

    return undefined;
  }

  private buildExpectedSignature(vault: string, payload: string): string | undefined {
    const cryptoKeys = [
      getAppCryptoKey(this.configService),
      ...getPreviousAppCryptoKeys(this.configService),
    ];

    for (const cryptoKey of cryptoKeys) {
      try {
        return hmacSha256Hex(decryptText(vault, cryptoKey), payload);
      } catch {
        // Try the next configured key.
      }
    }

    return undefined;
  }
}
