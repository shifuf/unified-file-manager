/**
 * Build Prisma DATABASE_URL from MYSQL_* when DATABASE_URL is not set.
 * Docker compose should set MYSQL_HOST=mysql; local defaults to localhost.
 */
export function ensureDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const existing = env.DATABASE_URL?.trim();
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
