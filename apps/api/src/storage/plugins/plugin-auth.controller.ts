import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Param, Post, UseGuards } from '@nestjs/common';
import { IsOptional, IsString, Matches } from 'class-validator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/types/request-user.type';
import { StorageAdapterRegistry } from '../storage-registry.service';
import { PrismaService } from '../../prisma/prisma.service';
import { PluginLoginSessions } from './plugin-login-sessions';

class StartLoginDto {
  @IsOptional() @IsString() @Matches(/^[A-Za-z0-9_-]{1,128}$/)
  accountId?: string;
}

@UseGuards(JwtAuthGuard)
@Controller('storage-plugins/:id/auth')
export class PluginAuthController {
  private readonly sessions = new PluginLoginSessions();
  constructor(private readonly registry: StorageAdapterRegistry, private readonly prisma: PrismaService) {}

  @Post('sessions')
  async start(@Param('id') id: string, @Body() body: StartLoginDto, @CurrentUser() user: RequestUser) {
    this.admin(user);
    try { this.sessions.assertCapacity(user.id); }
    catch { throw new BadRequestException('请先取消已有登录会话。'); }
    const adapter = this.registry.store.authAdapter(id);
    const session = await this.safe(() => adapter.startLogin!(body.accountId));
    this.sessions.add(id, user.id, session);
    return session;
  }
  @Get('sessions/:sessionId')
  async poll(@Param('id') id: string, @Param('sessionId') sessionId: string, @CurrentUser() user: RequestUser) {
    this.admin(user);
    if (!this.sessions.owns(id, user.id, sessionId)) throw new ForbiddenException('登录会话不存在或已过期。');
    return this.safe(() => this.registry.store.authAdapter(id).pollLogin!(sessionId));
  }
  @Delete('sessions/:sessionId')
  async cancel(@Param('id') id: string, @Param('sessionId') sessionId: string, @CurrentUser() user: RequestUser) {
    this.admin(user);
    if (!this.sessions.owns(id, user.id, sessionId)) throw new ForbiddenException('登录会话不存在或已过期。');
    this.sessions.remove(sessionId);
    await this.safe(() => this.registry.store.authAdapter(id).cancelLogin!(sessionId));
    return { success: true };
  }
  @Get('accounts/:accountId')
  async status(@Param('id') id: string, @Param('accountId') accountId: string, @CurrentUser() user: RequestUser) {
    this.admin(user);
    return this.safe(() => this.registry.store.authAdapter(id).accountStatus!(accountId));
  }
  @Delete('accounts/:accountId')
  async disconnect(@Param('id') id: string, @Param('accountId') accountId: string, @CurrentUser() user: RequestUser) {
    this.admin(user);
    const configs = await this.prisma.cdnConfig.findMany({ where: { provider: id }, select: { config: true } });
    if (configs.some(c => (c.config as Record<string, unknown>)?.accountId === accountId)) {
      throw new BadRequestException('账号仍被存储配置引用，请先迁移文件并移除配置。登录失效可使用重新登录。');
    }
    await this.safe(() => this.registry.store.authAdapter(id).disconnectAccount!(accountId));
    return { success: true };
  }
  private admin(user: RequestUser) { if (user.role !== 'SUPER_ADMIN') throw new ForbiddenException('仅超级管理员可连接存储账号。'); }
  private async safe<T>(action: () => Promise<T>): Promise<T> {
    try { return await action(); }
    catch { throw new BadRequestException('网盘认证操作失败，请检查网络并刷新二维码；重新登录时请扫描原账号。'); }
  }
}
