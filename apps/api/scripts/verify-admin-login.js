const { PrismaClient, UserRole } = require('@prisma/client');
const { ensureDatabaseUrl } = require('./ensure-database-url');
ensureDatabaseUrl();
const bcrypt = require('bcryptjs');

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

async function main() {
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
  });

  if (!user.enabled) {
    throw new Error(`Admin login check failed: user "${username}" is disabled.`);
  }

  const validPassword = await bcrypt.compare(password, user.passwordHash);
  if (!validPassword) {
    throw new Error(
      `Admin login check failed: ADMIN_PASSWORD does not match database password hash for "${username}".`,
    );
  }

  console.warn(
    `Admin password check passed for "${username}" with ADMIN_PASSWORD length ${password.length}; 2FA ${user.totpEnabled ? 'enabled' : 'disabled'}.`,
  );
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
