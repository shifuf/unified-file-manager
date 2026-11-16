import { BadRequestException, Controller, Delete, ForbiddenException, Get, Param, Post, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { validateConfig } from '@ufm/storage-plugin-sdk';
import { AuditAction } from '@prisma/client';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/types/request-user.type';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { StorageAdapterRegistry } from '../storage-registry.service';
import { StorageService } from '../storage.service';

@UseGuards(JwtAuthGuard)
@Controller('storage-plugins')
export class StoragePluginsController {
  constructor(private readonly registry: StorageAdapterRegistry, private readonly prisma: PrismaService,
    private readonly storage: StorageService, private readonly audit: AuditService) {}
  @Get()
  list(@CurrentUser() user: RequestUser) { this.assertAdmin(user); return this.registry.list(); }
  @Post()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 32 * 1024 * 1024, files: 1 } }))
  async install(@UploadedFile() file: Express.Multer.File, @CurrentUser() user: RequestUser) {
    this.assertAdmin(user);
    if (!file?.buffer) throw new BadRequestException('请选择插件 ZIP 文件。');
    try {
      const plugin = await this.registry.store.install(file.buffer, async manifest => {
        const configs = await this.prisma.cdnConfig.findMany({ where: { provider: manifest.id } });
        for (const config of configs) {
          try { validateConfig(manifest, this.storage.runtimeConfig(config).config); }
          catch { throw new Error(`新插件与存储“${config.name}”配置不兼容，请先调整配置。`); }
        }
      });
      await this.audit.write({ action: AuditAction.CDN_CREATE, actorId: user.id, detail: { operation: 'PLUGIN_INSTALL', pluginId: plugin.id, version: plugin.version, sha256: plugin.sha256 } });
      return plugin;
    } catch (error) { throw new BadRequestException(error instanceof Error ? error.message : '插件安装失败。'); }
  }
  @Delete(':id')
  async uninstall(@Param('id') id: string, @CurrentUser() user: RequestUser) {
    this.assertAdmin(user);
    try {
      const result = await this.registry.store.uninstall(id, async () => {
        const configs = await this.prisma.cdnConfig.findMany({ where: { provider: id }, include: { _count: { select: { files: true, storageReplicas: true, spaceReservations: true, projectBindings: true, activeProjects: true } } } });
        if (configs.some(c => c.enabled || Object.values(c._count).some(count => count > 0))) throw new Error('插件仍被存储配置、文件或副本引用，请先迁移文件并删除相关配置后再卸载。');
        const ids = configs.map(c => c.id);
        if (ids.length) {
          const tasks = await this.prisma.task.findMany({ where: { status: { in: ['PENDING', 'RUNNING', 'PAUSED', 'FAILED'] } }, select: { detail: true } });
          if (tasks.some(task => ids.some(configId => JSON.stringify(task.detail).includes(configId)))) throw new Error('插件仍有可恢复的后台任务引用，请先处理任务。');
          if (await this.prisma.fileVersion.count({ where: { cdnConfigId: { in: ids } } })) throw new Error('插件仍有历史文件版本引用，请先迁移历史文件。');
          // Keep disabled config records for historical audit; reinstall resolves them again.
        }
      });
      await this.audit.write({ action: AuditAction.CDN_DELETE, actorId: user.id, detail: { operation: 'PLUGIN_UNINSTALL', pluginId: id } });
      return result;
    } catch (error) { throw new BadRequestException(error instanceof Error ? error.message : '插件卸载失败。'); }
  }
  @Get(':id/package')
  async download(@Param('id') id: string, @CurrentUser() user: RequestUser, @Res() response: Response) {
    this.assertAdmin(user);
    if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(id)) throw new BadRequestException('插件标识无效。');
    try { response.type('application/zip').attachment(`${id}.zip`).send(await this.registry.store.package(id)); }
    catch { throw new BadRequestException('插件包不可用。'); }
  }
  private assertAdmin(user: RequestUser) { if (user.role !== 'SUPER_ADMIN') throw new ForbiddenException('仅超级管理员可管理存储插件。'); }
}
