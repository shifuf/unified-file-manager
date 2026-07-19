# Unified File Manager

多项目统一文件管理平台：NestJS + Prisma + MySQL 后端，Vue 3 + Element Plus 管理控制台，可插拔存储（本地 / 七牛 / 又拍云 / 阿里云 OSS / S3），开放 API（AppID + HMAC v2）。

**账号模型：单一超级管理员**（`.env` 中 `ADMIN_USERNAME` / `ADMIN_PASSWORD`）。业务系统通过各项目的 AppID 与签名密钥对接，不提供多租户成员控制台。

---

## 功能一览

| 能力 | 说明 |
|------|------|
| 项目 / 开放 API | AppID + HMAC 签名（v2 绑定 body hash） |
| 上传 | 普通上传、分片上传、CDN 直传 presign |
| 分享 | 文件 / 文件夹分享（密码、IP、水印、次数、过期、自定义路径） |
| 公开库 | `/library/:slug` |
| 检索 | Meilisearch（可选）+ SQL 回退 |
| 媒体 | 图片变换/缩略图；视频封面；可选 HLS/转码（Docker API 镜像含 ffmpeg） |
| Office 预览 | 配置 `OFFICE_PREVIEW_BASE_URL`（如 KKFileView） |
| 运维 | 配额、通知、Webhook、生命周期、访问热点、审计日志 |

---

## 快速部署（Docker，推荐上线方式）

### 1. 环境要求

- Docker Engine 24+ / Docker Compose v2
- 开放端口：对外通常只暴露 `WEB_PORT`（或由宿主机 Nginx/Caddy 反代）
- 生产服务器建议 ≥ 2 CPU / 2 GB 内存

### 2. 获取代码

```bash
git clone https://github.com/shifuf/unified-file-manager.git
cd unified-file-manager
```

### 3. 配置环境变量

```bash
# Linux / macOS
cp .env.example .env

# Windows PowerShell
Copy-Item .env.example .env
```

**上线前至少修改：**

| 变量 | 说明 |
|------|------|
| `PUBLIC_URL` | **可选**。不填则按访问 Host 自动推导（IP/端口直接用）；有固定域名时再填 |
| `JWT_SECRET` | ≥32 位随机串 |
| `APP_CRYPTO_KEY` | `openssl rand -base64 32` |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | 唯一管理员（密码≥12，勿用 `Admin@123456`） |
| `ADMIN_LOGIN_PATH` | 后台登录路径（默认 `/console-login`，重启 web 生效） |
| `MYSQL_PASSWORD` 等 | 数据库账号密码（**无需再写 `DATABASE_URL`**，程序自动拼接；Docker 用 `MYSQL_HOST=mysql`） |
| `MEILI_MASTER_KEY` | 检索主密钥 |
| `REQUIRE_HTTPS` | **HTTP/IP 必须 `false`**；仅 HTTPS 域名再 `true` |
| `NODE_ENV` | 生产 `production`（Docker api 强制 production；Swagger 开发开、生产关） |

生成 `APP_CRYPTO_KEY`：

```powershell
powershell -File scripts/generate-crypto-key.ps1
```

```bash
openssl rand -base64 32
```

生产示例片段：

```env
NODE_ENV=production
# PUBLIC_URL=https://files.example.com
APP_PORT=60557
WEB_PORT=60558
REQUIRE_HTTPS=true
ADMIN_LOGIN_PATH=/console-login
MYSQL_PASSWORD=强密码
JWT_SECRET=至少32位随机串
APP_CRYPTO_KEY=Base64的32字节
ADMIN_PASSWORD=至少12位强密码
MEILI_MASTER_KEY=强检索密钥
```

> Compose 的 `api` 服务会设置 `MYSQL_HOST=mysql` 等，`DATABASE_URL` 由程序自动拼接，无需手写。

### 4. 一键启动全栈

```bash
docker compose --profile full up -d --build
```

首次启动会自动：

1. 启动 MySQL / Redis / Meilisearch  
2. 构建并启动 API（执行 **单次** 库初始化迁移 `20260719000000_init`、确保管理员账号）  
3. 启动 Web（Nginx 反代 `/api`，并按 `ADMIN_LOGIN_PATH` 生成 `runtime-config.js`）

查看状态：

```bash
docker compose --profile full ps
docker compose logs -f api
```

### 5. 访问

| 入口 | 地址 |
|------|------|
| 公开首页 | `https://你的域名/` 或 `http://服务器IP:WEB_PORT/` |
| **管理后台登录** | `https://你的域名${ADMIN_LOGIN_PATH}`（默认 `/console-login`） |
| 健康检查 | `https://你的域名/api/healthz` |
| API 文档（仅开发） | `http://localhost:APP_PORT/api/docs`（`NODE_ENV=development` 时自动开启） |

**修改登录路径：** 编辑 `.env` 中 `ADMIN_LOGIN_PATH`，然后：

```bash
docker compose --profile full up -d web
# 或
docker compose restart web
```

无需重新 build 镜像即可生效。

### 6. 反向代理（可选）

将 `WEB_PORT` 反代到 443 即可。示例（Caddy）：

```caddy
files.example.com {
  reverse_proxy 127.0.0.1:60558
}
```

Nginx 注意：上传大文件时 `client_max_body_size` 需 ≥ `MAX_FILE_SIZE_MB`。

---

## 本地开发

```bash
# 1. 依赖服务
docker compose up -d mysql redis
# 可选检索
docker compose --profile extras up -d

# 2. 配置
cp .env.example .env
# 编辑 MYSQL_PASSWORD / PUBLIC_URL 等（一般无需 DATABASE_URL）

# 3. 安装与迁移
npm install
npm run prisma:generate
npm run db:migrate
npm run db:seed

# 4. 启动
npm run dev:api
npm run dev:web
```

- 控制台登录：`http://localhost:5174${ADMIN_LOGIN_PATH}`（默认 `/console-login`）  
- API：`http://localhost:3000`（以 `APP_PORT` 为准）  

---

## 生产检查清单

1. 强随机 `JWT_SECRET`、`APP_CRYPTO_KEY`、`ADMIN_PASSWORD`、`MEILI_MASTER_KEY`、MySQL 密码  
2. 可选独立 `PUBLIC_URL_SIGNING_KEY`  
3. `NODE_ENV=production`、`REQUIRE_HTTPS=true`（Swagger 生产自动关闭）  
4. 自定义 `ADMIN_LOGIN_PATH`，公网部署时避免过于常见的路径  
5. 勿将 MySQL / Redis / Meili 端口映射到公网  
6. 健康检查：`/api/healthz`  

---

## 技术栈

- **API**：NestJS · Prisma · MySQL 8 · Redis · Meilisearch  
- **Web**：Vue 3 · Vite · Element Plus · Pinia · Vue Router  
- **部署**：Docker multi-stage · Nginx · Compose profiles  

---

## License

[MIT](./LICENSE)
