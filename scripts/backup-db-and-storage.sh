#!/usr/bin/env bash
# 完整业务备份（Linux 服务器）：
#   1) MySQL 库（项目 / 文件元数据 / 分享 / 设置 / 用户 / 存储配置密文）
#   2) 本地 storage 实体文件（直链本地源、非纯 CDN 对象）
#   3) .env（必须含 APP_CRYPTO_KEY，否则 CDN/项目密钥无法解密）
#
# 用法：
#   bash scripts/backup-db-and-storage.sh
#   bash scripts/backup-db-and-storage.sh /root/ufm-backups
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
OUT_ROOT="${1:-$ROOT/backups}"
PKG_DIR="$OUT_ROOT/ufm-full-$STAMP"
mkdir -p "$PKG_DIR/db" "$PKG_DIR/storage" "$PKG_DIR/config"

echo "===== package: $PKG_DIR ====="

# ---------- 1) MySQL ----------
find_mysql_cid() {
  local name
  for name in ufm-mysql unified-file-manager-mysql-1; do
    if docker inspect "$name" >/dev/null 2>&1; then
      echo "$name"
      return 0
    fi
  done
  # 宽松匹配
  docker ps --format '{{.Names}}' | grep -E 'mysql' | grep -E 'ufm|unified-file' | head -n1 || true
}

CID="$(find_mysql_cid)"
if [[ -z "${CID}" ]]; then
  echo "ERROR: 找不到运行中的 MySQL 容器" >&2
  exit 1
fi
echo "[db] container=$CID database=$DB_NAME"
SQL_FILE="$PKG_DIR/db/${DB_NAME}.sql"
docker exec "$CID" mysqldump \
  -u"$DB_USER" -p"$DB_PASS" \
  --single-transaction --routines --triggers --events \
  --default-character-set=utf8mb4 \
  "$DB_NAME" >"$SQL_FILE"
gzip -f "$SQL_FILE"
echo "[db] ok -> ${SQL_FILE}.gz"

# ---------- 2) storage 实体 ----------
# 优先级：项目 data/storage、./storage、命名卷 ufm_storage_data、旧 bind 容器挂载
copy_storage_from_dir() {
  local src="$1"
  if [[ -d "$src" ]] && [[ -n "$(find "$src" -mindepth 1 -print -quit 2>/dev/null)" ]]; then
    echo "[storage] copy from dir: $src"
    tar -C "$src" -cf - . | tar -C "$PKG_DIR/storage" -xf -
    return 0
  fi
  return 1
}

copy_storage_from_volume() {
  local vol="$1"
  if ! docker volume inspect "$vol" >/dev/null 2>&1; then
    return 1
  fi
  echo "[storage] copy from docker volume: $vol"
  docker run --rm \
    -v "${vol}:/from:ro" \
    -v "$PKG_DIR/storage:/to" \
    alpine sh -c 'cd /from && tar -cf - . | tar -C /to -xf -'
  return 0
}

STORAGE_OK=0
if copy_storage_from_dir "$ROOT/data/storage"; then
  STORAGE_OK=1
elif copy_storage_from_dir "$ROOT/storage"; then
  STORAGE_OK=1
elif copy_storage_from_volume "ufm_storage_data"; then
  STORAGE_OK=1
else
  # 尝试从正在跑的 api 容器拷 /app/storage
  API_CID="$(docker ps --format '{{.Names}}' | grep -E 'ufm-api|unified-file-manager-api' | head -n1 || true)"
  if [[ -n "$API_CID" ]]; then
    echo "[storage] copy from container $API_CID:/app/storage"
    docker exec "$API_CID" sh -c 'cd /app/storage 2>/dev/null && tar -cf - .' \
      | tar -C "$PKG_DIR/storage" -xf - && STORAGE_OK=1 || true
  fi
fi

if [[ "$STORAGE_OK" -ne 1 ]]; then
  echo "[storage] WARN: 未找到本地 storage（若文件全在七牛/又拍可忽略）"
  echo "none" >"$PKG_DIR/storage/.empty"
else
  du -sh "$PKG_DIR/storage" || true
fi

# ---------- 3) .env（直链/CDN 解密必需）----------
if [[ -f "$ROOT/.env" ]]; then
  cp -a "$ROOT/.env" "$PKG_DIR/config/env.backup"
  echo "[config] .env copied (keep APP_CRYPTO_KEY secret)"
else
  echo "[config] WARN: no .env"
fi

# ---------- 4) 清单 ----------
{
  echo "createdAt=$STAMP"
  echo "mysqlContainer=$CID"
  echo "database=$DB_NAME"
  echo "storageOk=$STORAGE_OK"
  echo "note=Restore needs same APP_CRYPTO_KEY; CDN objects stay on cloud; local objects in storage/"
} >"$PKG_DIR/MANIFEST.txt"

# ---------- 5) 打包 ----------
ARCHIVE="$OUT_ROOT/ufm-full-$STAMP.tar.gz"
tar -C "$OUT_ROOT" -czf "$ARCHIVE" "ufm-full-$STAMP"
echo "===== DONE ====="
echo "archive: $ARCHIVE"
ls -lh "$ARCHIVE"
echo
echo "内含："
echo "  db/${DB_NAME}.sql.gz     # 库（项目/分享/设置/文件元数据）"
echo "  storage/                 # 本地实体文件"
echo "  config/env.backup        # 含 APP_CRYPTO_KEY（务必保密）"
