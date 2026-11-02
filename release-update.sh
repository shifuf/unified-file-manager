#!/bin/sh
# One-command release updater for the Docker deployment on this host.
# Release images are read from GitHub Release assets through gh-proxy, so the
# update path does not wait for GHCR or a third-party container mirror.
set -eu

REPO="${UFM_REPO:-shifuf/unified-file-manager}"
DEFAULT_PROXIES="https://gh-proxy.com https://ghfast.top __DIRECT__"
PROXIES="${UFM_GH_PROXIES:-$DEFAULT_PROXIES}"

log() {
    printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*" >&2
}

die() {
    printf '错误: %s\n' "$*" >&2
    exit 1
}

need() {
    command -v "$1" >/dev/null 2>&1 || die "缺少命令: $1"
}

APP_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
cd "$APP_DIR"

ENV_FILE="$APP_DIR/.env"
COMPOSE_FILE="$APP_DIR/deploy/compose.yml"
STATE_FILE="$APP_DIR/.ufm-version"
LOCK_DIR="$APP_DIR/.release-update.lock"
VERSION_ARG="${1:-latest}"

need docker
need curl
need gzip
need sha256sum
need awk
need sed
docker compose version >/dev/null 2>&1 || die "需要 Docker Compose v2"
[ -f "$ENV_FILE" ] || die "当前目录缺少 .env；首次部署请先按 .env.example 配置"

if [ ! -f "$COMPOSE_FILE" ] && [ -f "$APP_DIR/docker-compose.yml" ]; then
    if grep -Eq 'mysql:|MYSQL_PASSWORD|ufm_mysql_data' "$APP_DIR/docker-compose.yml"; then
        die "检测到旧版 NestJS/MySQL 部署。v0.2.0 是 Java/PostgreSQL 新栈，不能直接覆盖旧数据；请先完成独立数据库迁移或使用新目录部署"
    fi
fi

TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/ufm-update.XXXXXX")
cleanup() {
    rm -rf "$TMP_DIR"
    rmdir "$LOCK_DIR" 2>/dev/null || true
}
trap cleanup EXIT HUP INT TERM

mkdir "$LOCK_DIR" 2>/dev/null || die "已有更新进程在运行（$LOCK_DIR）"

download() {
    source_url=$1
    target=$2
    for proxy in $PROXIES; do
        if [ "$proxy" = "__DIRECT__" ]; then
            url=$source_url
            label="GitHub 直连"
        else
            url="${proxy%/}/$source_url"
            label=$proxy
        fi
        log "下载: $label"
        if curl -fL --retry 2 --retry-delay 2 \
            --connect-timeout 12 --max-time 1800 \
            --output "$target.part" "$url"; then
            mv "$target.part" "$target"
            return 0
        fi
        rm -f "$target.part"
    done
    return 1
}

resolve_latest() {
    api_json="$TMP_DIR/latest.json"
    if download "https://api.github.com/repos/$REPO/releases/latest" "$api_json"; then
        latest=$(sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$api_json" | head -n 1)
        if [ -n "$latest" ]; then
            printf '%s\n' "$latest"
            return 0
        fi
    fi

    latest_html="$TMP_DIR/latest.html"
    if download "https://github.com/$REPO/releases/latest" "$latest_html"; then
        latest=$(grep -o 'releases/tag/v[0-9][0-9A-Za-z._-]*' "$latest_html" | head -n 1 | sed 's#.*/##')
        if [ -n "$latest" ]; then
            printf '%s\n' "$latest"
            return 0
        fi
    fi

    if [ -s "$STATE_FILE" ]; then
        log "无法查询 GitHub 最新版本，沿用上次成功版本" >&2
        cat "$STATE_FILE"
        return 0
    fi
    return 1
}

case "$VERSION_ARG" in
    latest|"")
        VERSION=$(resolve_latest) || die "无法获取最新版本；可执行 bash release-update.sh v0.2.0"
        ;;
    v*)
        VERSION=$VERSION_ARG
        ;;
    [0-9]*)
        VERSION="v$VERSION_ARG"
        ;;
    *)
        die "版本号格式无效: $VERSION_ARG"
        ;;
esac

case "$VERSION" in
    v[0-9A-Za-z._-]*) ;;
    *) die "版本号格式无效: $VERSION" ;;
esac

case "$(uname -m)" in
    x86_64|amd64) ;;
    *) die "当前 Release 仅提供 linux/amd64 镜像，检测到 $(uname -m)" ;;
esac

log "目标版本: $VERSION"

compose() {
    docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

ASSET="ufm-images-${VERSION}-amd64.tar.gz"
COMPOSE_ASSET="ufm-compose-${VERSION}.yml"
RELEASE_URL="https://github.com/$REPO/releases/download/$VERSION"

download "$RELEASE_URL/SHA256SUMS" "$TMP_DIR/SHA256SUMS" \
    || die "下载 $VERSION 校验文件失败"
download "$RELEASE_URL/$ASSET" "$TMP_DIR/$ASSET" \
    || die "下载 $VERSION 镜像归档失败"
download "$RELEASE_URL/$COMPOSE_ASSET" "$TMP_DIR/$COMPOSE_ASSET" \
    || die "下载 $VERSION Compose 配置失败"

for asset in "$ASSET" "$COMPOSE_ASSET"; do
    expected=$(awk -v name="$asset" '$2 == name { print $1; exit }' "$TMP_DIR/SHA256SUMS")
    [ -n "$expected" ] || die "SHA256SUMS 中没有 $asset"
    actual=$(sha256sum "$TMP_DIR/$asset" | awk '{ print $1 }')
    [ "$actual" = "$expected" ] || die "校验失败: $asset"
done
log "镜像归档 SHA-256 校验通过"

STAMP=$(date '+%Y%m%d-%H%M%S')
BACKUP_DIR="$APP_DIR/backups/updates/${STAMP}-${VERSION}"
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
cp -p "$ENV_FILE" "$BACKUP_DIR/.env"
chmod 600 "$BACKUP_DIR/.env"
if [ -f "$COMPOSE_FILE" ]; then
    cp -p "$COMPOSE_FILE" "$BACKUP_DIR/compose.yml"
fi

if [ -f "$COMPOSE_FILE" ] && compose ps --services --filter status=running 2>/dev/null | grep -qx postgres; then
    log "备份 PostgreSQL 数据库"
    # The variables are expanded inside the PostgreSQL container.
    # shellcheck disable=SC2016
    if ! compose exec -T postgres sh -c \
        'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' \
        > "$BACKUP_DIR/postgres.dump"; then
        rm -f "$BACKUP_DIR/postgres.dump"
        die "数据库备份失败，已停止更新"
    fi
    chmod 600 "$BACKUP_DIR/postgres.dump"
else
    log "PostgreSQL 当前未运行，跳过在线数据库备份"
fi

if [ -f "$COMPOSE_FILE" ]; then
    compose images > "$BACKUP_DIR/images-before.txt" 2>/dev/null || true
fi

cp "$TMP_DIR/$COMPOSE_ASSET" "$COMPOSE_FILE.new"
mv "$COMPOSE_FILE.new" "$COMPOSE_FILE"

log "载入预构建镜像（不需要拉取 GHCR）"
docker load --input "$TMP_DIR/$ASSET"
docker tag "ufm-server:${VERSION}" ufm-server:local
docker tag "ufm-web:${VERSION}" ufm-web:local

compose config --quiet
log "重建应用容器；PostgreSQL 数据卷和文件存储卷保持不变"
if ! compose up -d --no-build --remove-orphans; then
    compose ps -a || true
    die "容器启动失败；备份位于 $BACKUP_DIR"
fi

log "等待 API 和 Web 健康检查"
healthy=0
attempt=0
while [ "$attempt" -lt 100 ]; do
    attempt=$((attempt + 1))
    if compose exec -T api curl -fsS --max-time 3 http://127.0.0.1:8080/api/healthz >/dev/null 2>&1 \
        && compose exec -T web wget -q -O /dev/null http://127.0.0.1/healthz >/dev/null 2>&1; then
        healthy=1
        break
    fi
    sleep 3
done
if [ "$healthy" -ne 1 ]; then
    compose logs --tail=80 api worker web || true
    die "健康检查超时；备份位于 $BACKUP_DIR"
fi

printf '%s\n' "$VERSION" > "$STATE_FILE.tmp"
mv "$STATE_FILE.tmp" "$STATE_FILE"

detect_public_ip() {
    for url in https://api.ipify.org https://ifconfig.me/ip https://ipinfo.io/ip https://4.ipw.cn; do
        ip=$(curl -4 -fsS --connect-timeout 4 --max-time 7 "$url" 2>/dev/null | tr -d '[:space:]' || true)
        case "$ip" in
            [0-9]*.[0-9]*.[0-9]*.[0-9]*) printf '%s\n' "$ip"; return 0 ;;
        esac
    done
    hostname -I 2>/dev/null | awk '{ print $1 }' || true
}

PUBLIC_IP=$(detect_public_ip)
[ -n "$PUBLIC_IP" ] || PUBLIC_IP="服务器公网IP"

PORT=$(compose port web 80 2>/dev/null | head -n 1 | sed 's/.*://')
case "$PORT" in
    ''|*[!0-9]*) PORT=8088 ;;
esac

PUBLIC_BASE_URL=$(grep -E '^UFM_PUBLIC_BASE_URL=' "$ENV_FILE" 2>/dev/null \
    | head -n 1 | cut -d= -f2- | tr -d '"\r' || true)
BIND_ADDRESS=$(grep -E '^UFM_BIND_ADDRESS=' "$ENV_FILE" 2>/dev/null \
    | head -n 1 | cut -d= -f2- | tr -d '"\r' || true)

if [ -n "$PUBLIC_BASE_URL" ]; then
    PUBLIC_BASE_URL="${PUBLIC_BASE_URL%/}"
    PUBLIC_CHECK="$PUBLIC_BASE_URL/api/healthz"
    PANEL_URL="$PUBLIC_BASE_URL"
else
    PUBLIC_CHECK="http://$PUBLIC_IP:$PORT/api/healthz"
    PANEL_URL="http://$PUBLIC_IP:$PORT"
fi

LOCAL_CHECK="http://127.0.0.1:$PORT/api/healthz"
curl -fsS --max-time 5 "$LOCAL_CHECK" >/dev/null 2>&1 \
    || log "警告: 宿主机本地健康检查未通过，请检查 $LOCAL_CHECK"

log "更新完成: $VERSION"
printf '\n'
printf '公网验证: curl %s\n' "$PUBLIC_CHECK"
printf '本机验证: curl %s\n' "$LOCAL_CHECK"
printf '面板地址: %s\n' "$PANEL_URL"
if [ -z "$PUBLIC_BASE_URL" ] && [ "$BIND_ADDRESS" = "127.0.0.1" ]; then
    printf '提示: 端口只绑定 127.0.0.1；公网访问需由域名反向代理转发到端口 %s。\n' "$PORT"
fi
printf '数据库/配置备份: %s\n' "$BACKUP_DIR"
printf '下次更新: bash release-update.sh\n'
