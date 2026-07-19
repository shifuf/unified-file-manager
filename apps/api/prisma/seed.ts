import { CdnProvider, PrismaClient, UserRole, type Prisma } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { ensureDatabaseUrl } from '../src/common/utils/database-url.util';

ensureDatabaseUrl();
const prisma = new PrismaClient();

async function main(): Promise<void> {
  const username = normalizeEnvValue(process.env.ADMIN_USERNAME, 'admin');
  const password = normalizeEnvValue(process.env.ADMIN_PASSWORD, 'Admin@123456');
  const passwordHash = await bcrypt.hash(password, 12);
  const existingAdmin = await prisma.user.findUnique({ where: { username } });

  if (existingAdmin) {
    await prisma.user.update({
      where: { username },
      data: {
        passwordHash,
        enabled: true,
        role: UserRole.SUPER_ADMIN,
        totpEnabled: false,
        totpSecret: null,
      },
    });
    console.warn(`Administrator "${username}" password synchronized from ADMIN_PASSWORD.`);
  } else {
    await prisma.user.create({
      data: {
        username,
        displayName: '系统管理员',
        passwordHash,
        role: UserRole.SUPER_ADMIN,
      },
    });
    console.warn(`Administrator "${username}" created from ADMIN_USERNAME and ADMIN_PASSWORD.`);
  }

  await ensureDefaultLocalStorageConfig();
}

function normalizeEnvValue(value: string | undefined, fallback: string): string {
  const normalized = value?.trim();
  return normalized || fallback;
}

async function ensureDefaultLocalStorageConfig(): Promise<void> {
  const config = {
    root: process.env.LOCAL_STORAGE_ROOT ?? './storage',
    domain: process.env.PUBLIC_URL ?? '',
  };
  const existing = await prisma.cdnConfig.findFirst({
    where: { provider: CdnProvider.LOCAL, projectId: null, enabled: true },
    orderBy: { createdAt: 'asc' },
  });

  if (existing) {
    await prisma.cdnConfig.update({
      where: { id: existing.id },
      data: {
        name: existing.name || '本地存储',
        config: {
          ...asRecord(existing.config),
          ...config,
        },
      },
    });
    return;
  }

  await prisma.cdnConfig.create({
    data: {
      provider: CdnProvider.LOCAL,
      name: '本地存储',
      active: false,
      config,
    },
  });
}

function asRecord(value: Prisma.JsonValue): Record<string, Prisma.JsonValue> {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    return {};
  }

  return value as Record<string, Prisma.JsonValue>;
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
