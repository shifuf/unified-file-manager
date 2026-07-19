#!/bin/sh
set -eu

export PATH="/app/node_modules/.bin:$PATH"

run_with_retry() {
  description="$1"
  shift
  attempt=1
  max_attempts=30

  until "$@"; do
    if [ "$attempt" -ge "$max_attempts" ]; then
      echo "$description failed after $attempt attempts."
      return 1
    fi

    echo "$description failed, retrying in 2s... ($attempt/$max_attempts)"
    attempt=$((attempt + 1))
    sleep 2
  done
}

# Build DATABASE_URL from MYSQL_* when not provided (compose sets MYSQL_HOST=mysql).
export DATABASE_URL="$(node /app/apps/api/scripts/ensure-database-url.js)"

echo "Waiting for database migrations..."
run_with_retry "Database migration" sh -c "cd /app/apps/api && prisma migrate deploy --schema prisma/schema.prisma"

echo "Ensuring administrator and default storage from .env..."
run_with_retry "Application bootstrap" sh -c "cd /app && node apps/api/scripts/ensure-admin.js"

echo "Verifying administrator login from .env..."
run_with_retry "Administrator login verification" sh -c "cd /app && node apps/api/scripts/verify-admin-login.js"

echo "Starting API..."
# The migration/bootstrap steps above need root (they only touch the DB/network).
# Before launching the long-running server, make the bind-mounted storage writable
# by the unprivileged runtime user and drop root privileges.
chown -R node:node /app/storage 2>/dev/null || true
exec su-exec node "$@"
