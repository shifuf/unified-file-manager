/**
 * Ensure process.env.DATABASE_URL for Prisma CLI / entrypoint / bootstrap scripts.
 * Prefer DATABASE_URL if set; otherwise build from MYSQL_*.
 */
function ensureDatabaseUrl(env = process.env) {
  const existing = (env.DATABASE_URL || '').trim();
  if (existing) {
    return existing;
  }

  const user = (env.MYSQL_USER || 'ufm').trim() || 'ufm';
  const password = encodeURIComponent(env.MYSQL_PASSWORD ?? '');
  const host = (env.MYSQL_HOST || 'localhost').trim() || 'localhost';
  const port = String(env.MYSQL_PORT || '3306').trim() || '3306';
  const database = (env.MYSQL_DATABASE || 'unified_file_manager').trim() || 'unified_file_manager';
  const url = `mysql://${user}:${password}@${host}:${port}/${database}`;
  env.DATABASE_URL = url;
  return url;
}

if (require.main === module) {
  process.stdout.write(ensureDatabaseUrl());
}

module.exports = { ensureDatabaseUrl };
