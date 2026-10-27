#!/usr/bin/env bash
# ============================================================
# 统一文件管理平台 一键更新脚本
# 用法:
#   bash release-update.sh            # 自动获取最新版本并更新
#   bash release-update.sh v0.1.0     # 更新到指定版本
# 可选环境变量:
#   GHCR_MIRROR=ghcr.nju.edu.cn       # 指定 ghcr 镜像源(默认自动尝试列表)
#   PULL_TIMEOUT=180                  # 单个镜像源拉取超时秒数
# ============================================================
set -u
BASE_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$BASE_DIR"

GH_PROXY="${GH_PROXY:-https://gh-proxy.com}"
REPO="shifuf/unified-file-manager"
VERSION_ARG="${1:-}"
DC="docker compose -f docker-compose.yml -f docker-compose.ghcr.yml"
PULL_TIMEOUT="${PULL_TIMEOUT:-180}"

echo "[1/5] 检查环境..."
if ! command -v docker >/dev/null 2>&1; then
  echo "错误: 未安装 docker"; exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "错误: docker compose 不可用"; exit 1
fi
if [ ! -f .env ]; then
  echo "错误: 当前目录没有 .env 配置文件。"
  echo "首次部署请先按 README 配置 .env 后再运行本脚本。"
  exit 1
fi

download() {
  curl -fSL --connect-timeout 10 --max-time 120 -o "$2" "$1"
}

echo "[2/5] 下载最新 compose 配置..."
download "$GH_PROXY/https://raw.githubusercontent.com/$REPO/main/docker-compose.yml" docker-compose.yml \
  || { echo "下载 docker-compose.yml 失败"; exit 1; }
download "$GH_PROXY/https://raw.githubusercontent.com/$REPO/main/docker-compose.ghcr.yml" docker-compose.ghcr.yml \
  || { echo "下载 docker-compose.ghcr.yml 失败"; exit 1; }
sed -i 's/\r$//' docker-compose.yml docker-compose.ghcr.yml

echo "[3/5] 确定目标版本..."
VERSION="$VERSION_ARG"
if [ -z "$VERSION" ]; then
  # 方式1: GitHub API 直连(海外或有代理时可用)
  VERSION=$(curl -fsSL --connect-timeout 6 --max-time 15 \
    "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null \
    | grep -o '"tag_name": *"[^"]*"' | head -1 | cut -d'"' -f4 || true)
fi
if [ -z "$VERSION" ]; then
  # 方式2: 南京大学 ghcr 镜像的 tags API(国内可用, 免认证)
  VERSION=$(curl -fsSL --connect-timeout 8 --max-time 20 \
    "https://ghcr.nju.edu.cn/v2/shifuf/unified-file-manager-api/tags/list" 2>/dev/null \
    | grep -o '"v[0-9][0-9.]*"' | tr -d '"' | sort -V | tail -1 || true)
fi
if [ -z "$VERSION" ]; then
  if [ -f .ufm-version ]; then
    VERSION="$(cat .ufm-version)"
    echo "警告: 无法获取最新版本号, 沿用上次版本 $VERSION (可手动传参: bash release-update.sh vX.Y.Z)"
  else
    VERSION="latest"
    echo "警告: 无法获取版本号, 使用 latest 标签"
  fi
fi
echo "目标版本: $VERSION"

if grep -q '^UFM_VERSION=' .env; then
  sed -i "s|^UFM_VERSION=.*|UFM_VERSION=$VERSION|" .env
else
  printf '\nUFM_VERSION=%s\n' "$VERSION" >> .env
fi

echo "[4/5] 拉取镜像(自动尝试多个镜像源, 单源最多 ${PULL_TIMEOUT}s)..."
if [ -n "${GHCR_MIRROR:-}" ]; then
  MIRRORS="$GHCR_MIRROR"
else
  MIRRORS="ghcr.nju.edu.cn ghcr.io"
fi
PULLED=0
for MIRROR in $MIRRORS; do
  echo "--- 尝试: $MIRROR ---"
  sed -i "s|image: [^ ]*/shifuf/unified-file-manager|image: $MIRROR/shifuf/unified-file-manager|g" docker-compose.ghcr.yml
  timeout -k 10 "$PULL_TIMEOUT" $DC pull api web
  RC=$?
  if [ "$RC" = 0 ]; then
    PULLED=1
    echo "镜像源 $MIRROR 拉取成功"
    break
  fi
  if [ "$RC" = 124 ] || [ "$RC" = 137 ]; then
    echo "镜像源 $MIRROR 超时(${PULL_TIMEOUT}s), 换下一个..."
  else
    echo "镜像源 $MIRROR 拉取失败(退出码 $RC), 换下一个..."
  fi
done
if [ "$PULLED" != 1 ]; then
  echo "错误: 所有镜像源都拉取失败。请检查网络后重试, 或手动指定版本: bash release-update.sh vX.Y.Z"
  exit 1
fi

echo "重建容器(数据卷不受影响)..."
$DC up -d --remove-orphans || { echo "容器启动失败:"; $DC ps -a; exit 1; }

echo "[5/5] 健康检查..."
APP_PORT=$(grep -E '^APP_PORT=' .env | head -1 | cut -d= -f2 | tr -d ' \r')
APP_PORT="${APP_PORT:-60557}"
WEB_PORT=$(grep -E '^WEB_PORT=' .env | head -1 | cut -d= -f2 | tr -d ' \r')
WEB_PORT="${WEB_PORT:-60558}"

HEALTH_OK=0
for i in $(seq 1 30); do
  if curl -fsS --max-time 3 "http://127.0.0.1:$APP_PORT/api/healthz" >/dev/null 2>&1; then
    HEALTH_OK=1; break
  fi
  sleep 4
done
if [ "$HEALTH_OK" != 1 ]; then
  echo "错误: API 健康检查未通过, 最近日志:"
  $DC logs --tail=50 api
  exit 1
fi

PUBLIC_IP=$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null \
  || curl -fsS --max-time 5 https://ifconfig.me 2>/dev/null \
  || curl -fsS --max-time 5 https://ip.3322.net 2>/dev/null \
  || hostname -I 2>/dev/null | awk '{print $1}')

echo "$VERSION" > .ufm-version
echo ""
echo "[OK] release 更新完成: $VERSION"
echo "验证方式: curl http://$PUBLIC_IP:$APP_PORT/api/healthz"
echo "面板地址: http://$PUBLIC_IP:$WEB_PORT"