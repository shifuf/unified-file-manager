# 服务器上如何部署本包

本包是干净的 Docker 部署目录（无 `node_modules` / 无本地 `.env` / 无业务数据）。

## 部署

```bash
cp .env.example .env
# 编辑 .env 必改项（见文件顶部「必改」段）：
#   PUBLIC_URL / JWT_SECRET / APP_CRYPTO_KEY / ADMIN_* / MYSQL_PASSWORD 等 / MEILI_MASTER_KEY / REQUIRE_HTTPS（无需 DATABASE_URL / SWAGGER_ENABLED）
docker compose --profile full up -d --build
```

| 访问方式 | 配置 |
|----------|------|
| `http://IP:WEB_PORT` | 可不填 `PUBLIC_URL`，`REQUIRE_HTTPS=false` |
| `https://域名` | 建议 `PUBLIC_URL=https://域名`，`REQUIRE_HTTPS=true` |

- 后台：`${PUBLIC_URL}${ADMIN_LOGIN_PATH}`（默认 `/console-login`）
- 改登录路径：改 `ADMIN_LOGIN_PATH` 后 `docker compose restart web`
- 库初始化：单次迁移 `20260719000000_init`。旧库需先 `docker volume rm ufm_mysql_data` 再装

## 不包含

本地 `.env`、业务数据、`node_modules`（镜像内构建）。
