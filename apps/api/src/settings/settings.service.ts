import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditAction, UserRole, type Prisma } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../common/types/request-user.type';
import { normalizeDomainAllowlist } from '../common/utils/domain-allowlist.util';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateSettingDto } from './dto/update-setting.dto';

export interface UploadLimits {
  maxFileSizeMb: number;
  maxFileSizeBytes: number;
  maxBatchUploadCount: number;
}

export interface SharePageBrand {
  /** Brand heading above file/folder title. Empty = hide. */
  title: string;
  /** Short line under brand title. */
  subtitle: string;
  /** Optional logo URL (http/https only). */
  logoUrl: string;
  /** Accent color (hex). */
  primaryColor: string;
  /** Page background (hex or css gradient string, max 128). */
  background: string;
  /** Card/panel background (hex). */
  panelBackground: string;
  /** Footer text under the panel. */
  footerText: string;
  /** Show the product credit line on the public share page. */
  showPoweredBy: boolean;
}

interface DefaultSettings {
  maxFileSizeMb: number;
  maxBatchUploadCount: number;
  recycleRetentionDays: number;
  requireHttps: boolean;
  publicFileAllowedDomains: string[];
  /** Base URL of Office online preview (OnlyOffice / KKFileView). Empty = download-only. */
  officePreviewBaseUrl: string;
  sharePageBrand: SharePageBrand;
}

@Injectable()
export class SettingsService {
  constructor(
    private readonly auditService: AuditService,
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async list(): Promise<Record<string, unknown>> {
    const settings = await this.prisma.systemSetting.findMany();
    const entries = settings.map((setting) => [setting.key, setting.value]);
    const merged: Record<string, unknown> = {
      ...this.defaultSettings(),
      ...Object.fromEntries(entries),
    };
    merged.sharePageBrand = this.normalizeSharePageBrand(merged.sharePageBrand);
    return merged;
  }

  async update(dto: UpdateSettingDto, user: RequestUser): Promise<Record<string, unknown>> {
    const value = this.normalizeSettingValue(dto.key, dto.value);
    const setting = await this.prisma.systemSetting.upsert({
      where: { key: dto.key },
      update: { value: value as Prisma.InputJsonValue },
      create: { key: dto.key, value: value as Prisma.InputJsonValue },
    });

    await this.auditService.write({
      action: AuditAction.SETTING_UPDATE,
      actorId: user.id,
      detail: { key: dto.key },
    });

    return {
      key: setting.key,
      value: setting.value,
      updatedAt: setting.updatedAt,
    };
  }

  async getUploadLimits(): Promise<UploadLimits> {
    const settings = await this.list();
    const defaults = this.defaultSettings();
    const maxFileSizeMb = this.toPositiveInteger(
      settings.maxFileSizeMb,
      defaults.maxFileSizeMb,
      1,
    );
    const maxBatchUploadCount = this.toPositiveInteger(
      settings.maxBatchUploadCount,
      defaults.maxBatchUploadCount,
      1,
    );

    return {
      maxFileSizeMb,
      maxFileSizeBytes: maxFileSizeMb * 1024 * 1024,
      maxBatchUploadCount,
    };
  }

  async getRecycleRetentionDays(): Promise<number> {
    const settings = await this.list();
    return this.toPositiveInteger(
      settings.recycleRetentionDays,
      this.defaultSettings().recycleRetentionDays,
      1,
    );
  }

  async getPublicFileAllowedDomains(): Promise<string[]> {
    const settings = await this.list();
    return normalizeDomainAllowlist(settings.publicFileAllowedDomains);
  }

  async isHttpsRequired(): Promise<boolean> {
    const settings = await this.list();
    return typeof settings.requireHttps === 'boolean' ? settings.requireHttps : this.defaultSettings().requireHttps;
  }

  /**
   * Optional Office online preview base URL.
   * - KKFileView: http://host:8012/onlinePreview?url=
   * - OnlyOffice Document Server embeds use their own JS config; still store base for docs.
   */
  async getOfficePreviewBaseUrl(): Promise<string> {
    const settings = await this.list();
    const raw = settings.officePreviewBaseUrl;
    if (typeof raw === 'string' && raw.trim()) {
      return raw.trim().replace(/\/+$/, '');
    }
    return this.defaultSettings().officePreviewBaseUrl;
  }

  /** Public share page branding (safe to expose without auth). */
  async getSharePageBrand(): Promise<SharePageBrand> {
    const settings = await this.list();
    return this.normalizeSharePageBrand(settings.sharePageBrand);
  }

  async health(user: RequestUser): Promise<Record<string, unknown>> {
    const checkedAt = new Date();
    let database: Record<string, unknown> = { status: 'OK' };

    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch (error) {
      database = {
        status: 'FAIL',
        message: error instanceof Error && error.message ? error.message : '数据库连接失败。',
      };
    }

    const [projectCount, activeFileCount, recycledFileCount, taskCount, failedTaskCount] = await Promise.all([
      this.prisma.project.count({ where: { deletedAt: null } }),
      this.prisma.managedFile.count({ where: { status: 'ACTIVE' } }),
      this.prisma.managedFile.count({ where: { status: 'RECYCLED' } }),
      this.prisma.task.count(),
      this.prisma.task.count({ where: { status: 'FAILED' } }),
    ]);

    await this.auditService.write({
      action: AuditAction.SYSTEM_HEALTH_CHECK,
      actorId: user.id,
      detail: { database: String(database.status) },
    });

    return {
      status: database.status === 'OK' ? 'OK' : 'DEGRADED',
      checkedAt,
      database,
      runtime: {
        nodeVersion: process.version,
        environment: this.configService.get<string>('NODE_ENV', 'development'),
      },
      counts: {
        projects: projectCount,
        activeFiles: activeFileCount,
        recycledFiles: recycledFileCount,
        tasks: taskCount,
        failedTasks: failedTaskCount,
      },
      settings: await this.list(),
    };
  }

  canManage(user: RequestUser): boolean {
    return user.role === UserRole.SUPER_ADMIN;
  }

  private defaultSettings(): DefaultSettings {
    return {
      maxFileSizeMb: this.getConfigInteger('MAX_FILE_SIZE_MB', 200),
      maxBatchUploadCount: this.getConfigInteger('MAX_BATCH_UPLOAD_COUNT', 20),
      recycleRetentionDays: this.getConfigInteger('RECYCLE_RETENTION_DAYS', 30),
      requireHttps: this.getConfigBoolean('REQUIRE_HTTPS', true),
      publicFileAllowedDomains: normalizeDomainAllowlist(
        this.configService.get<string>('PUBLIC_FILE_ALLOWED_DOMAINS', ''),
      ),
      officePreviewBaseUrl: String(this.configService.get<string>('OFFICE_PREVIEW_BASE_URL', '') || '').trim(),
      sharePageBrand: {
        title: '',
        subtitle: '',
        logoUrl: '',
        primaryColor: '#2563eb',
        background: '#f8fafc',
        panelBackground: '#ffffff',
        footerText: '',
        showPoweredBy: true,
      },
    };
  }

  private normalizeSettingValue(key: string, value: unknown): unknown {
    const labels: Record<string, string> = {
      maxFileSizeMb: '单个文件大小',
      maxBatchUploadCount: '单次上传数量',
      recycleRetentionDays: '回收站保留天数',
    };

    if (key in labels) {
      return this.requirePositiveInteger(value, labels[key], 1);
    }

    if (key === 'requireHttps') {
      if (typeof value !== 'boolean') {
        throw new BadRequestException('是否要求 HTTPS 只能填写 true 或 false。');
      }

      return value;
    }

    if (key === 'publicFileAllowedDomains') {
      if (typeof value !== 'string' && !Array.isArray(value)) {
        throw new BadRequestException('公开文件允许访问域名必须是文本或文本数组。');
      }

      return normalizeDomainAllowlist(value);
    }

    if (key === 'officePreviewBaseUrl') {
      if (value === null || value === undefined || value === '') {
        return '';
      }
      if (typeof value !== 'string') {
        throw new BadRequestException('Office 预览服务地址必须是字符串。');
      }
      const trimmed = value.trim();
      if (!trimmed) {
        return '';
      }
      try {
        // Allow bare host with path query template; require absolute URL when non-empty.
        new URL(trimmed.includes('://') ? trimmed : `http://${trimmed}`);
      } catch {
        throw new BadRequestException('Office 预览服务地址不是合法 URL。');
      }
      return trimmed.replace(/\/+$/, '');
    }

    if (key === 'sharePageBrand') {
      return this.normalizeSharePageBrand(value);
    }

    return value;
  }

  private normalizeSharePageBrand(value: unknown): SharePageBrand {
    const defaults = this.defaultSettings().sharePageBrand;
    const source =
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};

    const title = this.clampText(source.title, 64, defaults.title);
    const subtitle = this.clampText(source.subtitle, 160, defaults.subtitle);
    const footerText = this.clampText(source.footerText, 160, defaults.footerText);
    const primaryColor = this.normalizeCssColor(source.primaryColor, defaults.primaryColor, '主题色');
    const background = this.normalizeCssBackground(source.background, defaults.background);
    const panelBackground = this.normalizeCssColor(
      source.panelBackground,
      defaults.panelBackground,
      '面板背景色',
    );
    const logoUrl = this.normalizeHttpUrl(source.logoUrl, 512, 'Logo 地址');
    const showPoweredBy =
      typeof source.showPoweredBy === 'boolean' ? source.showPoweredBy : defaults.showPoweredBy;

    return {
      title,
      subtitle,
      logoUrl,
      primaryColor,
      background,
      panelBackground,
      footerText,
      showPoweredBy,
    };
  }

  private clampText(value: unknown, max: number, fallback: string): string {
    if (value === null || value === undefined) {
      return fallback;
    }
    if (typeof value !== 'string') {
      throw new BadRequestException('文本字段必须是字符串。');
    }
    return value.trim().slice(0, max);
  }

  private normalizeHttpUrl(value: unknown, max: number, label: string): string {
    if (value === null || value === undefined || value === '') {
      return '';
    }
    if (typeof value !== 'string') {
      throw new BadRequestException(`${label}必须是字符串。`);
    }
    const trimmed = value.trim().slice(0, max);
    if (!trimmed) {
      return '';
    }
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new BadRequestException(`${label}不是合法 URL。`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new BadRequestException(`${label}仅支持 http/https。`);
    }
    return trimmed;
  }

  private normalizeCssColor(value: unknown, fallback: string, label: string): string {
    if (value === null || value === undefined || value === '') {
      return fallback;
    }
    if (typeof value !== 'string') {
      throw new BadRequestException(`${label}必须是字符串。`);
    }
    const trimmed = value.trim();
    if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(trimmed)) {
      return trimmed;
    }
    if (/^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)$/.test(trimmed)) {
      return trimmed.slice(0, 64);
    }
    throw new BadRequestException(`${label}请使用 #RGB / #RRGGBB 或 rgb()/rgba()。`);
  }

  private normalizeCssBackground(value: unknown, fallback: string): string {
    if (value === null || value === undefined || value === '') {
      return fallback;
    }
    if (typeof value !== 'string') {
      throw new BadRequestException('页面背景必须是字符串。');
    }
    const trimmed = value.trim().slice(0, 160);
    if (!trimmed) {
      return fallback;
    }
    // Allow solid color or simple linear-gradient; block urls()/javascript to avoid CSS injection.
    if (/url\s*\(|expression\s*\(|javascript:/i.test(trimmed)) {
      throw new BadRequestException('页面背景不允许使用 url() 或脚本表达式。');
    }
    if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(trimmed)) {
      return trimmed;
    }
    if (/^rgba?\(/i.test(trimmed) || /^linear-gradient\(/i.test(trimmed)) {
      return trimmed;
    }
    throw new BadRequestException('页面背景请使用颜色或 linear-gradient(...)。');
  }

  private getConfigInteger(key: string, fallback: number): number {
    return this.toPositiveInteger(this.configService.get<unknown>(key), fallback, 1);
  }

  private getConfigBoolean(key: string, fallback: boolean): boolean {
    const value = this.configService.get<unknown>(key);

    if (typeof value === 'boolean') {
      return value;
    }

    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (['true', '1', 'yes', 'on'].includes(normalized)) {
        return true;
      }
      if (['false', '0', 'no', 'off'].includes(normalized)) {
        return false;
      }
    }

    return fallback;
  }

  private requirePositiveInteger(value: unknown, label: string, min: number): number {
    const parsed = this.parseNumber(value);

    if (!Number.isFinite(parsed) || parsed < min) {
      throw new BadRequestException(`${label}必须是不小于 ${min} 的数字。`);
    }

    return Math.floor(parsed);
  }

  private toPositiveInteger(value: unknown, fallback: number, min: number): number {
    const parsed = this.parseNumber(value);

    if (!Number.isFinite(parsed) || parsed < min) {
      return fallback;
    }

    return Math.floor(parsed);
  }

  private parseNumber(value: unknown): number {
    if (typeof value === 'number') {
      return value;
    }

    if (typeof value === 'string' && value.trim()) {
      return Number(value);
    }

    return Number.NaN;
  }
}
