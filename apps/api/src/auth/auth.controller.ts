import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Throttle } from '../common/guards/throttle.decorator';
import type { RequestUser } from '../common/types/request-user.type';
import { getConfigBoolean } from '../common/utils/security-config.util';
import { ACCESS_COOKIE, parseCookieHeader, REFRESH_COOKIE } from './auth-cookies';
import { AuthService } from './auth.service';
import { ChangePasswordDto } from './dto/change-password.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { VerifyTotpDto } from './dto/verify-totp.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';

@ApiTags('认证')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
  ) {}

  @Post('login')
  @Throttle({ limit: 20, windowMs: 60_000 })
  async login(
    @Body() dto: LoginDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ requiresTotp: true } | Record<string, unknown>> {
    const result = await this.authService.login(dto, {
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    });

    if (result.requiresTotp) {
      return { requiresTotp: true };
    }

    this.setSessionCookies(response, result.accessToken, result.refreshToken);
    // Cookie session only — do not put tokens in JSON (XSS would undo httpOnly hardening).
    // API clients that need Bearer tokens should authenticate via dedicated open-api secrets.
    return {
      requiresTotp: false,
      user: result.user,
    };
  }

  @Post('refresh')
  @Throttle({ limit: 30, windowMs: 60_000 })
  async refresh(
    @Body() dto: RefreshTokenDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Record<string, unknown>> {
    const refreshToken =
      dto.refreshToken || parseCookieHeader(request.headers.cookie, REFRESH_COOKIE) || undefined;
    const result = await this.authService.refresh(refreshToken, {
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    });

    this.setSessionCookies(response, result.accessToken, result.refreshToken);
    return {
      requiresTotp: false,
      user: result.user,
    };
  }

  @Post('logout')
  @HttpCode(200)
  async logout(
    @Body() dto: RefreshTokenDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ success: boolean }> {
    const refreshToken =
      dto.refreshToken || parseCookieHeader(request.headers.cookie, REFRESH_COOKIE) || undefined;
    const result = await this.authService.revokeRefreshToken(refreshToken);
    this.clearSessionCookies(response);
    return result;
  }

  @Get('profile')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  profile(@CurrentUser() user: RequestUser): ReturnType<AuthService['getProfile']> {
    return this.authService.getProfile(user.id);
  }

  @Get('sessions')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  listSessions(
    @CurrentUser() user: RequestUser,
    @Req() request: Request,
  ): ReturnType<AuthService['listSessions']> {
    const refreshToken = parseCookieHeader(request.headers.cookie, REFRESH_COOKIE) || undefined;
    return this.authService.listSessions(user, refreshToken);
  }

  @Delete('sessions/:id')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  revokeSession(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
  ): ReturnType<AuthService['revokeSession']> {
    return this.authService.revokeSession(user, id);
  }

  @Delete('sessions')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  revokeOtherSessions(
    @CurrentUser() user: RequestUser,
    @Req() request: Request,
  ): ReturnType<AuthService['revokeOtherSessions']> {
    const refreshToken = parseCookieHeader(request.headers.cookie, REFRESH_COOKIE) || undefined;
    return this.authService.revokeOtherSessions(user, refreshToken);
  }

  @Post('2fa/setup')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  setupTotp(@CurrentUser() user: RequestUser): ReturnType<AuthService['setupTotp']> {
    return this.authService.setupTotp(user);
  }

  @Post('2fa/enable')
  @ApiBearerAuth()
  @Throttle({ limit: 15, windowMs: 60_000 })
  @UseGuards(JwtAuthGuard)
  enableTotp(
    @CurrentUser() user: RequestUser,
    @Body() dto: VerifyTotpDto,
  ): ReturnType<AuthService['enableTotp']> {
    return this.authService.enableTotp(user, dto.code);
  }

  @Post('2fa/disable')
  @ApiBearerAuth()
  @Throttle({ limit: 15, windowMs: 60_000 })
  @UseGuards(JwtAuthGuard)
  disableTotp(
    @CurrentUser() user: RequestUser,
    @Body() dto: VerifyTotpDto,
  ): ReturnType<AuthService['disableTotp']> {
    return this.authService.disableTotp(user, dto.code);
  }

  @Get('2fa/status')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  totpStatus(@CurrentUser() user: RequestUser): ReturnType<AuthService['getTotpStatus']> {
    return this.authService.getTotpStatus(user);
  }

  @Post('password')
  @ApiBearerAuth()
  @Throttle({ limit: 10, windowMs: 60_000 })
  @UseGuards(JwtAuthGuard)
  changePassword(
    @CurrentUser() user: RequestUser,
    @Body() dto: ChangePasswordDto,
  ): ReturnType<AuthService['changePassword']> {
    return this.authService.changePassword(user, dto);
  }

  private setSessionCookies(response: Response, accessToken: string, refreshToken: string): void {
    // Secure cookies only when REQUIRE_HTTPS=true. Production HTTP/IP deploys must
    // keep Secure=false or browsers drop the session cookie and every request looks expired.
    const secure = this.sessionCookieSecure();
    const accessMaxAge = this.accessCookieMaxAgeMs();
    const refreshMaxAge = this.refreshCookieMaxAgeMs();

    response.cookie(ACCESS_COOKIE, accessToken, {
      httpOnly: true,
      secure,
      sameSite: 'lax',
      path: '/',
      maxAge: accessMaxAge,
    });
    response.cookie(REFRESH_COOKIE, refreshToken, {
      httpOnly: true,
      secure,
      sameSite: 'lax',
      path: '/api/auth',
      maxAge: refreshMaxAge,
    });
  }

  private clearSessionCookies(response: Response): void {
    const secure = this.sessionCookieSecure();
    response.cookie(ACCESS_COOKIE, '', {
      httpOnly: true,
      secure,
      sameSite: 'lax',
      path: '/',
      maxAge: 0,
    });
    response.cookie(REFRESH_COOKIE, '', {
      httpOnly: true,
      secure,
      sameSite: 'lax',
      path: '/api/auth',
      maxAge: 0,
    });
  }

  /** Match cookie Secure flag to actual transport policy (HTTPS domain vs HTTP/IP). */
  private sessionCookieSecure(): boolean {
    return getConfigBoolean(this.configService, 'REQUIRE_HTTPS', false);
  }

  private accessCookieMaxAgeMs(): number {
    const raw = this.configService.get<string>('JWT_EXPIRES_IN', '2h');
    const match = /^(\d+)([smhd])$/i.exec(raw.trim());
    if (!match) {
      return 2 * 60 * 60 * 1000;
    }
    const amount = Number(match[1]);
    const unit = match[2].toLowerCase();
    const mult = unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
    return amount * mult;
  }

  private refreshCookieMaxAgeMs(): number {
    const days = Number(this.configService.get<number>('JWT_REFRESH_EXPIRES_DAYS', 30)) || 30;
    return Math.max(1, days) * 24 * 60 * 60 * 1000;
  }
}
