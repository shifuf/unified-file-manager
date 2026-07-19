import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import type { UserRole } from '@prisma/client';
import type { Request } from 'express';
import { ExtractJwt, Strategy } from 'passport-jwt';

import { getJwtSecret } from '../common/utils/security-config.util';
import { PrismaService } from '../prisma/prisma.service';
import { ACCESS_COOKIE, parseCookieHeader } from './auth-cookies';

interface JwtPayload {
  sub: string;
  username: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private readonly prisma: PrismaService,
    configService: ConfigService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        (request: Request) => parseCookieHeader(request?.headers?.cookie, ACCESS_COOKIE) ?? null,
        ExtractJwt.fromAuthHeaderAsBearerToken(),
      ]),
      ignoreExpiration: false,
      secretOrKey: getJwtSecret(configService),
    });
  }

  async validate(payload: JwtPayload): Promise<{
    id: string;
    username: string;
    displayName: string;
    role: UserRole;
    totpEnabled: boolean;
  }> {
    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });

    // Single super-admin product: only SUPER_ADMIN sessions are valid for the console.
    if (!user || !user.enabled || user.role !== 'SUPER_ADMIN') {
      throw new UnauthorizedException('登录状态无效，请重新登录。');
    }

    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      role: user.role,
      totpEnabled: user.totpEnabled,
    };
  }
}
