import { BadRequestException, ConflictException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';

import type { PrismaService } from '../prisma/prisma.service';

export async function resolveWebdavSlug(
  prisma: Pick<PrismaService, 'project'>,
  input: string | null | undefined,
  existing: string | null | undefined,
  projectId?: string,
): Promise<string> {
  if (input === undefined && existing) return existing;
  if (input != null && typeof input !== 'string') throw new BadRequestException('DAV 地址后缀必须是字符串。');
  const custom = input?.trim().toLowerCase() || null;
  if (custom && !/^[a-z0-9]{1,64}$/.test(custom)) {
    throw new BadRequestException('DAV 地址后缀仅支持 1–64 位英文字母或数字。');
  }
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = custom ?? randomBytes(12).toString('hex');
    const conflict = await prisma.project.findFirst({
      where: { OR: [{ webdavSlug: candidate }, { id: candidate }], ...(projectId ? { NOT: { id: projectId } } : {}) },
      select: { id: true },
    });
    if (!conflict) return candidate;
    if (custom) throw new ConflictException('DAV 地址后缀已被使用，请更换。');
  }
  throw new ConflictException('生成 DAV 地址失败，请重试。');
}

export function throwWebdavSlugConflict(error: unknown): never {
  if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') {
    const meta = 'meta' in error ? error.meta : null;
    if (meta && typeof meta === 'object' && 'target' in meta && String(meta.target).includes('webdavSlug')) {
      throw new ConflictException('DAV 地址后缀已被使用，请更换。');
    }
  }
  throw error;
}
