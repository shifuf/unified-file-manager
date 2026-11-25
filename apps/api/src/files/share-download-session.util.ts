import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import type { PrismaService } from '../prisma/prisma.service';
import type { StorageDownloadTarget } from '../storage/storage.types';

type SharePolicy = {
  id: string;
  enabled: boolean;
  passwordHash: string | null;
  expiresAt: Date | null;
  allowedIps: Prisma.JsonValue;
  previewOnly: boolean;
  watermarkText?: string | null;
  maxDownloads: number | null;
  downloadCount: number;
  folderPath?: string;
  file?: { id: string; status: string; storageKey?: string; project?: { enabled?: boolean; deletedAt?: Date | null } | null } | null;
  project?: { enabled?: boolean; deletedAt?: Date | null } | null;
};

export function sharePolicyHash(share: SharePolicy): string {
  const project = share.project ?? share.file?.project;
  return createHash('sha256').update(JSON.stringify({
    id: share.id, enabled: share.enabled, password: share.passwordHash,
    expires: share.expiresAt?.toISOString(), ips: share.allowedIps,
    previewOnly: share.previewOnly, watermarkText: share.watermarkText, maxDownloads: share.maxDownloads,
    folderPath: share.folderPath, fileId: share.file?.id,
    key: share.file?.storageKey, status: share.file?.status,
    projectEnabled: project?.enabled, projectDeletedAt: project?.deletedAt,
  })).digest('hex');
}

export function shareSessionIp(ip?: string): string {
  return (ip || 'unknown').trim().replace(/^::ffff:/i, '') || 'unknown';
}

export async function issueShareDownloadSession(
  prisma: PrismaService,
  share: SharePolicy,
  fileId: string,
  ip: string | undefined,
  kind: 'file' | 'folder',
) {
  const ticket = randomBytes(32).toString('hex');
  const expiresAt = new Date(Math.min(Date.now() + 60_000, share.expiresAt?.getTime() ?? Infinity));
  await prisma.shareDownloadSession.create({ data: {
    ticketHash: createHash('sha256').update(ticket).digest('hex'),
    shareId: kind === 'file' ? share.id : null,
    folderShareId: kind === 'folder' ? share.id : null,
    fileId, policyHash: sharePolicyHash(share), ip: shareSessionIp(ip), expiresAt,
  } });
  return { ticket, expiresAt };
}

export async function findShareDownloadSession(
  prisma: PrismaService,
  share: SharePolicy,
  fileId: string,
  ip: string | undefined,
  kind: 'file' | 'folder',
  ticket?: string,
  expires?: number,
) {
  if (!ticket) return null;
  if (!/^[a-f0-9]{64}$/.test(ticket)) throw new ForbiddenException('下载会话无效或已过期。');
  const session = await prisma.shareDownloadSession.findUnique({ where: {
    ticketHash: createHash('sha256').update(ticket).digest('hex'),
  } });
  if (!session || session.expiresAt.getTime() <= Date.now() ||
      (expires !== undefined && expires !== Math.floor(session.expiresAt.getTime() / 1000)) ||
      session.fileId !== fileId || session.ip !== shareSessionIp(ip) ||
      (kind === 'file' ? session.shareId !== share.id : session.folderShareId !== share.id) ||
      session.policyHash !== sharePolicyHash(share)) {
    throw new ForbiddenException('下载会话无效或分享策略已改变。');
  }
  return session;
}

/** Claim quota and a ticket together; the transaction survives server restarts. */
export async function consumeShareDownload(
  prisma: PrismaService,
  share: SharePolicy,
  kind: 'file' | 'folder',
  sessionId?: string,
): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(async tx => {
        const current = kind === 'file'
          ? await tx.shareLink.findUnique({ where: { id: share.id }, include: { file: { include: { project: { select: { enabled: true, deletedAt: true } } } } } })
          : await tx.folderShareLink.findUnique({ where: { id: share.id }, include: { project: { select: { enabled: true, deletedAt: true } } } });
        if (!current || !current.enabled || (current.expiresAt && current.expiresAt.getTime() <= Date.now()) || sharePolicyHash(current) !== sharePolicyHash(share)) {
          throw new ForbiddenException('分享已失效或访问策略已改变。');
        }
        if (sessionId) {
          const claimed = await tx.shareDownloadSession.updateMany({
            where: { id: sessionId, consumedAt: null, expiresAt: { gt: new Date() }, policyHash: sharePolicyHash(current) },
            data: { consumedAt: new Date() },
          });
          if (!claimed.count) {
            const session = await tx.shareDownloadSession.findUnique({ where: { id: sessionId } });
            if (!session?.consumedAt || session.expiresAt.getTime() <= Date.now() || session.policyHash !== sharePolicyHash(current)) {
              throw new ForbiddenException('下载会话无效或已过期。');
            }
            return false;
          }
        }
        const where = { id: share.id, enabled: true, ...(current.maxDownloads === null ? {} : { downloadCount: { lt: current.maxDownloads } }) };
        const result = kind === 'file'
          ? await tx.shareLink.updateMany({ where, data: { downloadCount: { increment: 1 } } })
          : await tx.folderShareLink.updateMany({ where, data: { downloadCount: { increment: 1 } } });
        if (!result.count) throw new BadRequestException('分享下载次数已用完。');
        return true;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (attempt < 3 && error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') continue;
      throw error;
    }
  }
}

/** ReplicaService normally returns verified streams. Verify legacy adapters before quota. */
export async function requireVerifiedShareTarget(target: StorageDownloadTarget, expectedLength: number): Promise<StorageDownloadTarget> {
  if (target.type === 'redirect' && target.url && target.verified === true && target.contentLength === expectedLength) return target;
  if (!target.stream || target.type !== 'stream') throw new NotFoundException('文件内容不可读取。');
  if (target.contentLength !== undefined && target.contentLength !== expectedLength) {
    target.stream.destroy();
    throw new BadRequestException('文件内容长度不一致。');
  }
  if ('verified' in target && target.verified === true) return target;
  const directory = await mkdtemp(join(tmpdir(), 'ufm-share-'));
  const output = join(directory, 'content');
  let size = 0;
  const counter = new Transform({ transform(chunk, _encoding, callback) { size += chunk.length; callback(null, chunk); } });
  try {
    await pipeline(target.stream, counter, createWriteStream(output));
    if (size !== expectedLength) throw new BadRequestException('文件内容长度不一致。');
    const stream = createReadStream(output);
    stream.once('close', () => { void rm(directory, { recursive: true, force: true }); });
    return { type: 'stream', stream, contentLength: size };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
