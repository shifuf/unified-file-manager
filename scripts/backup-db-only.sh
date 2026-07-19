#!/usr/bin/env bash
# 仅备份 MySQL（不含 storage 实体）。
# 若需要直链本地文件 + 分享 + 设置一并带走，请用：
#   bash scripts/backup-db-and-storage.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

DB_NAME="${MYSQL_DATABASE:-unified_file_manager}"
DB_USER="${MYSQL_USER:-ufm}"
DB_PASS="${MYSQL_PASSWORD:-ufm_password}"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT_DIR="${1:-$ROOT/backups}"
mkdir -p "$OUT_DIR"
OUT_FILE="$OUT_DIR/ufm-db-${STAMP}.sql"

# 优先当前 compose 容器名，其次历史/默认名
CANDIDATES=(
  "ufm-mysql"
  "unified-file-manager-mysql-1"
  "$(docker compose ps -q mysql 2>/dev/null | head -n1 || true)"
)

CID=""
for c in "${CANDIDATES[@]}"; do
  [[ -z "$c" ]] && continue
  if docker inspect "$c" >/dev/null 2>&1; then
    CID="$c"
    break
  fi
  # id style
  if docker ps --format '{{.ID}}' | grep -qx "$c"; then
    CID="$c"
    break
  fi
done

if [[ -z "$CID" ]]; then
  echo "ERROR: 找不到运行中的 mysql 容器（ufm-mysql / unified-file-manager-mysql-1）" >&2
  exit 1
fi

echo "Using container: $CID"
echo "Dumping database: $DB_NAME -> $OUT_FILE"

docker exec "$CID" mysqldump \
  -u"$DB_USER" -p"$DB_PASS" \
  --single-transaction \
  --routines \
  --triggers \
  --events \
  --default-character-set=utf8mb4 \
  "$DB_NAME" >"$OUT_FILE"

# 去掉可能的 mysqldump 警告行写到 stdout 的情况（一般在 stderr）
gzip -f "$OUT_FILE"
echo "OK: ${OUT_FILE}.gz"
ls -lh "${OUT_FILE}.gz"
