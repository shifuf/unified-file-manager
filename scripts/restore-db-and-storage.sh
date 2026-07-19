#!/usr/bin/env bash
# 从 backup-db-and-storage.sh 产物恢复到「Docker 命名卷」部署
# 用法：
#   bash scripts/restore-db-and-storage.sh /root/ufm-backups/ufm-full-XXXX.tar.gz
# 要求：项目已 docker compose --profile full up -d，mysql/api 健康
set -euo pipefail

ARCHIVE="${1:-}"
if [[ -z "$ARCHIVE" || ! -f "$ARCHIVE" ]]; then
  echo "用法: $0 /path/to/ufm-full-XXXX.tar.gz" >&2
  exit 1
fi

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

WORK="$(mktemp -d /tmp/ufm-restore-XXXX)"
trap 'rm -rf "$WORK"' EXIT

echo "[1] unpack $ARCHIVE"
tar -xzf "$ARCHIVE" -C "$WORK"
PKG="$(find "$WORK" -maxdepth 1 -type d -name 'ufm-full-*' | head -n1)"
[[ -n "$PKG" ]] || { echo "invalid archive layout"; exit 1; }

# ---------- MySQL ----------
CID=""
for name in ufm-mysql unified-file-manager-mysql-1; do
  if docker inspect "$name" >/dev/null 2>&1; then
    CID="$name"
    break
  fi
done
CID="${CID:-$(docker ps --format '{{.Names}}' | grep -E 'mysql' | grep -E 'ufm|unified-file' | head -n1 || true)}"
[[ -n "$CID" ]] || { echo "mysql container not found"; exit 1; }

SQL_GZ="$(find "$PKG/db" -name '*.sql.gz' | head -n1)"
[[ -n "$SQL_GZ" ]] || { echo "no sql.gz in package"; exit 1; }
echo "[2] import $SQL_GZ -> $CID / $DB_NAME"
gunzip -c "$SQL_GZ" | docker exec -i "$CID" mysql -u"$DB_USER" -p"$DB_PASS" "$DB_NAME"
echo "[2] db ok"

# ---------- storage -> named volume ----------
if [[ -d "$PKG/storage" ]] && [[ -z "$(find "$PKG/storage" -name '.empty' -print -quit 2>/dev/null)" ]]; then
  echo "[3] restore storage into volume ufm_storage_data"
  docker volume create ufm_storage_data >/dev/null
  docker run --rm \
    -v "$PKG/storage:/from:ro" \
    -v ufm_storage_data:/to \
    alpine sh -c 'rm -rf /to/* /to/.[!.]* 2>/dev/null; cd /from && tar -cf - . | tar -C /to -xf -'
  echo "[3] storage ok"
else
  echo "[3] skip storage (empty package)"
fi

# ---------- .env 提示 ----------
if [[ -f "$PKG/config/env.backup" ]]; then
  echo "[4] backup .env is at $PKG/config/env.backup"
  echo "    生产 .env 必须保留相同 APP_CRYPTO_KEY，否则存储配置/密钥无法解密。"
  echo "    可手动对比: diff -u .env $PKG/config/env.backup | head"
fi

echo "===== restore done ====="
echo "重启 api 使缓存失效（可选）:"
echo "  docker compose restart api web"
