const { CdnProvider, PrismaClient, UserRole } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const { ensureDatabaseUrl } = require('./ensure-database-url');

ensureDatabaseUrl();
const prisma = new PrismaClient();

function normalizeEnvValue(value, fallback) {
  const normalized = value && value.trim();
  const resolved = normalized || fallback;

  if (!resolved) {
    throw new Error('ADMIN_USERNAME and ADMIN_PASSWORD must be set in production.');
  }

  return resolved;
}

function isProduction() {
  return String(process.env.NODE_ENV || '').trim().toLowerCase() === 'production';
}

async function ensureAdministrator() {
  const username = normalizeEnvValue(process.env.ADMIN_USERNAME, isProduction() ? undefined : 'admin');
  const password = normalizeEnvValue(process.env.ADMIN_PASSWORD, isProduction() ? undefined : 'Admin@123456');

  const passwordHash = await bcrypt.hash(password, 12);

  const user = await prisma.user.upsert({
    where: { username },
    update: {
      passwordHash,
      enabled: true,
      role: UserRole.SUPER_ADMIN,
    },
    create: {
      username,
      displayName: '系统管理员',
      passwordHash,
      role: UserRole.SUPER_ADMIN,
    },
    select: {
      username: true,
      passwordHash: true,
      enabled: true,
      totpEnabled: true,
    },
  });

  const validPassword = await bcrypt.compare(password, user.passwordHash);
  if (!user.enabled || !validPassword) {
    throw new Error(`Administrator "${username}" was not synchronized correctly from .env.`);
  }

  console.warn(
    `Administrator "${username}" is ready from .env; password length ${password.length}; 2FA ${user.totpEnabled ? 'enabled' : 'disabled'}.`,
  );
}

async function ensureDefaultLocalStorageConfig() {
  const config = {
    root: process.env.LOCAL_STORAGE_ROOT || '/app/storage',
    domain: process.env.PUBLIC_URL || '',
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
          ...(typeof existing.config === 'object' && existing.config && !Array.isArray(existing.config)
            ? existing.config
            : {}),
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

async function main() {
  await ensureAdministrator();
  await ensureDefaultLocalStorageConfig();
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
