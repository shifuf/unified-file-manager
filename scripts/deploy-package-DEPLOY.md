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
- 数据库：API 启动时使用 `prisma migrate deploy` 执行尚未应用的完整迁移链；空库和已有库使用同一流程。升级前备份，保留原数据库卷，不删除旧库。
- 版本与更新说明见 `CHANGELOG.md`。单一结构 SQL、校验清单及安全导入边界见 `scripts/sql/README.md`；已有数据库不要导入 `schema.sql`。

## 不包含

本地 `.env`、业务数据、`node_modules`（镜像内构建）。
