import { Controller, ForbiddenException, Get, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UserRole } from '@prisma/client';

import { SkipThrottle } from './common/guards/throttle.decorator';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { CurrentUser } from './common/decorators/current-user.decorator';
import type { RequestUser } from './common/types/request-user.type';
import { safeFetch } from './common/utils/ssrf-guard.util';
import { compareVersions } from './version/version-check.util';

@Controller()
@SkipThrottle()
export class HealthController {
  private versionCache: { expiresAt: number; latestVersion: string | null; state: string } | null = null;

  constructor(private readonly configService: ConfigService) {}

  @Get('healthz')
  check(): { status: 'ok'; service: string; checkedAt: string } {
    return {
      status: 'ok',
      service: 'ufm-api',
      checkedAt: new Date().toISOString(),
    };
  }

  @Get('version')
  @UseGuards(JwtAuthGuard)
  async version(@CurrentUser() user: RequestUser): Promise<{
    currentVersion: string;
    latestVersion: string | null;
    updateAvailable: boolean | null;
    state: 'available' | 'not_configured' | 'unavailable' | 'invalid_version';
  }> {
    if (user.role !== UserRole.SUPER_ADMIN) throw new ForbiddenException('只有超级管理员可以查看版本更新信息。');
    const currentVersion = process.env.UFM_VERSION || process.env.npm_package_version || 'dev';
    const endpoint = (this.configService.get<string>('UPDATE_CHECK_URL') ?? '').trim();
    if (!endpoint) return { currentVersion, latestVersion: null, updateAvailable: null, state: 'not_configured' };

    let latestVersion: string | null;
    let state: 'available' | 'unavailable' | 'invalid_version';
    const cached = this.versionCache;
    if (cached && cached.expiresAt > Date.now()) {
      latestVersion = cached.latestVersion;
      state = cached.state as typeof state;
    } else {
      try {
        const response = await safeFetch(endpoint, {
          headers: { accept: 'application/json', 'user-agent': 'unified-file-manager-update-check' },
          signal: AbortSignal.timeout(4000),
        });
        if (!response.ok) throw new Error(`release endpoint returned ${response.status}`);
        const data: unknown = await response.json();
        const record = data && typeof data === 'object' ? data as Record<string, unknown> : {};
        const candidate = record.tag_name ?? record.version ?? record.name;
        latestVersion = typeof candidate === 'string' && candidate.trim() ? candidate.trim() : null;
        state = latestVersion ? 'available' : 'invalid_version';
      } catch {
        latestVersion = null;
        state = 'unavailable';
      }
      this.versionCache = { expiresAt: Date.now() + (state === 'unavailable' ? 60_000 : 10 * 60_000), latestVersion, state };
    }
    const comparison = latestVersion ? compareVersions(latestVersion, currentVersion) : null;
    if (comparison === null && state === 'available') state = 'invalid_version';
    return {
      currentVersion,
      latestVersion,
      updateAvailable: comparison === null ? null : comparison > 0,
      state,
    };
  }
}
