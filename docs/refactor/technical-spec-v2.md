# 统一文件管理系统 v2 · 技术开发规格书（新栈）

> **目标环境**：2 核 2G VPS 单机部署，总内存预算硬约束
> **配套**：`dev-features.md`（功能基线 16 章，功能口径以其为准）
> **与旧版（NestJS 版）的关系**：全新代码库，旧版仅在 git 历史作功能参照

---

# 0. 资源预算（一切设计的出发点）

| 进程 | 内存上限 | 说明 |
|---|---|---|
| PostgreSQL | ~512MB（shared_buffers=128MB） | 唯一状态存储 |
| API（Spring Boot） | -Xmx384m -Xss512k | 对外 HTTP + 轻逻辑 |
| Worker（Spring Boot） | -Xmx512m 按需起停 | 转码/迁移/备份等重活，可与 API 同机不同容器 |
| 系统+页缓存 | 剩余 | 文件流式转发靠 page cache |

设计铁律：
- **不引入 Redis**（省 ~100MB）：任务队列用 PostgreSQL `SKIP LOCKED`，限流/会话黑名单用 PG 表 + 内存缓存
- **不引入 Meilisearch**：全文检索用 PostgreSQL FTS（tsvector + GIN）
- **不上微服务**：API 与 Worker 是同一代码库的两个启动 profile，共享领域模块
- JVM 选 **Java 21 + Spring Boot 3.3**，虚拟线程（`spring.threads.virtual.enabled=true`）替代大线程池

# 1. 技术栈定案

| 层 | 选型 | 版本 |
|---|---|---|
| 后端语言 | Java（虚拟线程） | 21 LTS |
| 后端框架 | Spring Boot（Web MVC，非 WebFlux） | 3.3.x |
| 数据访问 | MyBatis-Plus（SQL 可控、内存友好，不用 Hibernate） | 3.5.x |
| 数据库 | PostgreSQL | 16 |
| 数据库迁移 | Flyway | 10.x |
| 安全 | Spring Security + JWT（jjwt） | |
| 文档 | springdoc-openapi → `/v3/api-docs` 导出 openapi.json | 2.x |
| 存储 SDK | AWS SDK v2（S3 兼容全家桶）+ 七牛/又拍官方 SDK 或自实现 REST | |
| 媒体处理 | worker 内调用 ffmpeg + thumbnailator/imgscalr（或 libvips 绑定） | |
| 任务 | PostgreSQL 队列表 + `FOR UPDATE SKIP LOCKED` | |
| 前端 | Vue 3.5 + TS + Vite 6 | |
| UI | Naive UI | 2.x |
| 状态 | Pinia | |
| 虚拟列表 | `@vueuse/core` useVirtualList 或 virtua | |
| 图表 | ECharts（按需引入，工作台用） | |
| HTTP 客户端 | ofetch/ky 封装 | |
| 类型同步 | openapi-typescript 从 openapi.json 生成 | |
| 构建 | Gradle（Kotlin DSL）单仓多模块 | 8.x |
| 测试 | JUnit5 + Testcontainers(PG) + Playwright 冒烟 | |

## 1.1 仓库结构（Gradle 多模块）
```
unified-file-manager/
├── settings.gradle.kts
├── server/
│   ├── app/            # API 启动模块（profile: api）
│   ├── worker/         # Worker 启动模块（profile: worker，同一 jar 可用 --server.role 切换）
│   └── core/           # 领域模块（controller/service/repository/driver 全在这）
│       └── src/main/java/com/ufm/{auth,project,storage,file,share,media,task,notify,backup,setting,audit,system}/
├── web/                # Vue3 前端
├── deploy/             # Dockerfile / compose / release-update.sh / nginx
├── docs/
└── .github/workflows/
```
**模块规则**：
- 单类 ≤ 400 行；service 只做用例编排，SQL 在 mapper
- controller 层不做业务；DTO 与领域对象分离
- 跨域调用显式 service 依赖，禁止跨域直接 join 别的域的表（复杂报表例外：只读视图）

# 2. 数据库设计（PostgreSQL，初版 24 表）

## 2.1 通用约定
- 主键：`uuid v7`（时间有序，pg 扩展或应用生成）
- 时间：`timestamptz`；字节：`bigint`
- 枚举：PG 原生 enum 或 varchar + CHECK（选 varchar+CHECK，迁移简单）
- 所有表含 `created_at`/`updated_at`；软删用 `deleted_at`
- Flyway 基线：`V1__baseline.sql` 一次成库，之后增量

## 2.2 表清单
| 表 | 用途 | 关键列/约束 |
|---|---|---|
| users | 账号 | uk(username)，role(SUPER_ADMIN/ADMIN/VIEWER)，totp_secret_enc，enabled |
| refresh_tokens | 会话 | uk(token_hash)，expires_at，revoked_at，replaced_by |
| projects | 项目 | uk(app_id)，secret_hash，secret_enc，quota_bytes，quota_files，notify_enabled，library_enabled，library_slug uk，webdav_enabled/username/password_enc，allowed_domains jsonb |
| storage_configs | 存储配置 | provider(LOCAL/QINIU/UPYUN/OSS/S3)，config jsonb(密钥加密)，priority，is_default，storage_quota_bytes，traffic_quota_bytes，failover_threshold_pct default 90，auto_failover，manual_*_bytes，last_usage jsonb，last_health |
| project_storage | 项目↔存储绑定 | uk(project_id, config_id)，is_active（每项目最多一条 true，用部分唯一索引 `WHERE is_active`） |
| files | 文件主表 | project_id fk，storage_config_id，original_name，storage_key，mime，ext，size bigint，category，status(ACTIVE/RECYCLED/DELETED/QUARANTINED)，is_public，checksum，content_text text，fts tsvector（生成列 or 触发器+GIN），tags jsonb，folder_path ltree 或 varchar，thumb_url，duplicate_of，version int，purge_at |
| file_versions | 版本 | uk(file_id, version) |
| file_derivatives | 衍生品 | uk(file_id, kind)，kind(THUMB/WEBP/MP4_720/HLS/COVER)，status |
| folders | 目录登记 | uk(project_id, path) |
| folder_public_policies | 目录公开 | uk(project_id, folder_path) |
| share_links | 文件分享 | uk(token)，uk(custom_path)，password_hash，expires_at，max_downloads，download_count，preview_only，allowed_ips jsonb，watermark |
| folder_share_links | 目录分享 | uk(token)，同上 |
| upload_credentials | 上传凭证 | uk(token_hash)，scope jsonb，max_bytes/used_bytes，max_files/used_files，expires_at，revoked_at |
| project_secrets | 附加密钥 | secret_hash，secret_enc，enabled |
| tasks | 任务（队列+展示双用） | type，status(PENDING/RUNNING/PAUSED/FAILED/DONE/CANCELED)，progress，payload jsonb，result jsonb，error，locked_by，locked_until，run_at |
| download_records | 下载明细 | source(ADMIN/OPEN_API/PUBLIC/SHARE/FOLDER_SHARE/WEBDAV/BATCH)，ip，ua，referer，range_start/end，success |
| download_daily_stats | 日聚合 | uk(day, project_id, file_id, source) |
| access_daily_stats | 访问日统计 | uk(day, project_id, file_id, referer_host) |
| share_ip_stats | IP 防刷台账 | uk(ip)，download_count，rate_limit_count，ban_until，permanent_ban |
| ip_bans | 封禁记录 | ip，until，permanent，reason |
| audit_logs | 审计 | action，actor_id，project_id，ip，ua，detail jsonb |
| notify_channels | 通知渠道 | type(WEBHOOK/PUSH_PLATFORM)，config jsonb(加密)，events jsonb，enabled |
| notify_deliveries | 投递记录 | channel_id，event，success，status_code，error |
| notifications | 站内信 | user_id，title，body，level，href，read_at |
| settings | KV 设置 | pk(key)，value jsonb |
| backups | 备份 | status，include_objects，file_name，size，checksum，scopes jsonb |
| nonces | OpenAPI 防重放 | uk(app_id, nonce)，expires_at |

## 2.3 全文检索方案（PG FTS）
```sql
-- files 表加生成列 + GIN
content_tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(content_text,''))) STORED;
CREATE INDEX idx_files_fts ON files USING GIN (content_tsv);
```
- 中文质量方案（v2 迭代）：应用侧用 jieba（Java: huaban/jieba-analysis）分词 → 空格拼接后 `to_tsvector('simple', 分词文本)` 由触发器/应用双写 `content_tsv`，查询同样分词后 `plainto_tsquery`
- 查询模板：`WHERE project_id=? AND content_tsv @@ query ORDER BY ts_rank DESC LIMIT 50`
- 索引文件内容上限 512KB（超出截断）
- 搜索降级：FTS 不可用时 ILIKE 前缀（不会发生——PG 内置，无外部依赖）

# 3. 任务队列（PG SKIP LOCKED，无 Redis）

```sql
-- 取任务（任意 worker 实例安全）
UPDATE tasks SET status='RUNNING', locked_by=$worker, locked_until=now()+interval '10 min'
WHERE id = (
  SELECT id FROM tasks
  WHERE status='PENDING' AND run_at <= now()
  ORDER BY priority, created_at
  FOR UPDATE SKIP LOCKED LIMIT 1
) RETURNING *;
```
- 心跳：RUNNING 任务每 30s 续租 locked_until；超时未续 = worker 崩溃 → 释放回 PENDING（重试计数 +1，>5 次 → FAILED）
- 队列类型：MEDIA_IMAGE / MEDIA_VIDEO / SEARCH_INDEX（可省，同步写）/ STORAGE_MIGRATION / PROJECT_IMPORT / PROJECT_PURGE / LIFECYCLE / BACKUP / NOTIFY / MAINTENANCE
- 定时任务：worker 内 `@Scheduled` 扫描 + 写 PENDING 任务行（保证幂等：uk 约束防重）
- 用户可见任务（迁移/导入/备份）即 tasks 表本身，API 直接读
- 取消/暂停：API 置 status → worker 每批检查标志位 → PAUSED 保留 payload 游标，resume 置回 PENDING

# 4. 后端 API 契约

## 4.1 总则
- 前缀 `/api`；REST JSON；错误体统一：
```json
{ "error": { "code": "QUOTA_EXHAUSTED", "message": "...", "details": {...}, "requestId": "..." } }
```
- HTTP：400 校验/401/403/404/409 冲突/429 限流(Retry-After)/500
- springdoc 生成 openapi.json，CI 提交到 `web/src/api/schema.d.ts`（openapi-typescript）
- 认证：Authorization Bearer（前端存内存 + refresh cookie）或 httpOnly cookie 双模式；分享/公开路由免认证

## 4.2 端点清单（对齐功能基线，方法语义同功能文档）
```
/api/auth          login/refresh/logout/profile/sessions(+revoke)/2fa(+setup/enable/disable/status)/password
/api/users         (SUPER_ADMIN) CRUD/enable
/api/projects      CRUD/import/export/stats/hotspots/secrets/storage-bindings(+activate)
/api/storages      CRUD/test/test-draft/usage/make-default
/api/files         list(tree/grid)/search(fts)/get/patch/move/copy/copy-to-storage/batch-*
/api/uploads       init/chunk/complete/abort | presign/complete-presign | credential-presign/complete
/api/files/:id/download     （admin 下载）
/api/recycle       list/restore/purge/ purge-all
/api/versions      list/restore
/api/folders       tree/create/rename/move
/api/folder-public list/put/delete/batch-publish
/api/shares        file: CRUD + public: GET /s/:token(+session/download)
/api/folder-shares CRUD + public: /fs/:token(files/download)
/api/library       admin: enable/slug/files | public: /lib/:slug
/api/direct-links  生成直链/限时直链（§4.3）
/api/ip-stats      list/ban/unban
/api/download-stats summary/list/daily
/api/tasks         list/get/cancel/pause/resume/retry
/api/notifications list/unread-count/read
/api/notify-channels CRUD/test/deliveries
/api/webdav        settings per project; DAV 本体 /dav/:project/**
/api/backups       list/create/import/get/download/restore/delete
/api/lifecycle     CRUD/run
/api/audit-logs    list/export/cleanup
/api/settings      get/patch | share-brand | hover-actions | workbench
/api/system        health/version/check-update
/api/open/*        第三方 API（x-app-id/x-timestamp/x-nonce/x-signature）
```

## 4.3 直链域（新设计，对齐"直链域名可自定义"）
- `GET /api/files/:id/direct-link?ttl=3600`
- 域名解析优先级：`settings.download_domain` > 文件所在存储 config 的 `custom_domain` > 请求 Host
- 生成规则：
  - 公开文件：`{domain}/d/{storageKey 路径段}` 或存储原生直链（云存储直接给对象 CDN URL）
  - 非公开：`{domain}/d/{token}?sig=HMAC(path+exp)&exp=...`（限时签名直链）
- `/d/:token` 端点：验签 → 走下载管道（记账/限流）→ 302 或流
- 直链开关：文件级 is_public、目录公开策略、项目级 allowed_domains 三层校验

# 5. 存储驱动层（Java SPI）

```java
public interface StorageDriver {
  Provider provider();
  StoredObject upload(StorageCfg cfg, UploadParams p);          // 中转
  void remove(StorageCfg cfg, String key);                       // 幂等
  String presignedDownload(cfg, key, ttl);                       // 302 直链
  DownloadTarget download(cfg, key, Range r);                    // stream|redirect
  boolean exists(cfg, key);
  DirectUpload directUpload(cfg, DirectParams p, ttl);           // 预签名/上传凭证
  UsageSnapshot usage(cfg);                                      // 可 null=未知
}
```
实现：`LocalDriver` / `QiniuDriver` / `UpyunDriver` / `OssDriver` / `S3CompatibleDriver`（AWS SDK v2 S3Client + S3Presigner，endpoint 可覆盖 → MinIO/R2/COS/B2 全兼容；Multipart：createMultipartUpload + presign each part + complete）
- 密钥加密：AES-256-GCM（主密钥 env `UFM_CRYPTO_KEY`），jsonb 内 `{"enc":"v2:..."}`
- 用量刷新：worker 定时调 usage()（有实现的驱动），写 last_usage；来源标注 platform/manual/unknown
- 故障切换（API 进程内）：
```
resolveActive(project): binding(is_active) → cfg
  if cfg.auto_failover && exceeded(cfg):  # 阈值判定缓存 30s（Caffeine）
      next = 优先级最低的 enabled 且未超限者
      CAS: UPDATE project_storage SET is_active=false WHERE project_id=? AND is_active
           UPDATE ... SET is_active=true WHERE config_id=next  # 抢占成功者建迁移任务
      none → 409 QUOTA_EXHAUSTED
```
- 连通测试：upload 1KB 探针 → download → remove；结果含耗时与错误详情

# 6. 上传管线（FileIngestService，四通道统一出口）
1. 接收（中转 buffer / 分块合并 / 直传回调校验 exists+size）
2. sha256 checksum → 秒传判定（同 project 同 checksum 同 size → 复制行 duplicate_of）
3. 落 files 行（status=ACTIVE）+ folder 登记 + 配额扣减
4. emit `file.uploaded`（进程内事件 + 写 NOTIFY/审计）
5. worker 认领：缩略图/WebP（image）/ MP4_720+HLS+COVER（video，ffmpeg）/ FTS 分词写 tsv / 索引
- 分块：`uploads` 临时目录 + manifest json（上传会话表可省，manifest 即状态）；S3 Multipart 直传时服务只存 uploadId+parts
- 直传凭证：S3Presigner PUT（单件 ≤5GB）/ Multipart 每片 presign；七牛 uptoken putPolicy；又拍云签名 header
- 配额：单点 `QuotaService.assertUpload(project, bytes, count)`（WebDAV/OpenAPI 也必须走）❗

# 7. 下载管道
- DownloadService.resolve(file, range, shareContext) → redirect|stream
- 流式输出：`InputStreamResource` + `Content-Range`/`Accept-Ranges`；本地 RandomAccessFile 分段
- 记账异步（队列 NOTIFY 同库 or 直接异步线程 + 失败重试）：download_records + daily_stats + access_daily_stats
- 限流：share 维度滑窗（PG 表 share_ip_stats + 内存 Caffeine 计数缓冲 10s 批量落库，2G 内存友好）
- 封禁：ip_bans 查询（内存缓存 60s）
- 防盗链：Origin/Referer 白名单（settings + project.allowed_domains）

# 8. 分享域
- 校验链顺序：enabled → expires → max_downloads → allowed_ips → ban/rate-limit → password
- 密码会话：`POST /s/:token/session` 验码 → 签发短期签名 cookie（10min）→ download 校验
- 隐私铁律：公开 DTO 无 storage/provider/storageKey/内部 URL/加速标记；admin DTO 才含 accessRoute
- 分享页品牌：settings.share_brand jsonb（title/subtitle/logo/primary/page_bg/card_bg/footer/powered_by），公开端点 `GET /api/public/brand` 无缓存风险（不含敏感）

# 9. 前端规格（Naive UI + 轻快）

## 9.1 布局
- 布局：左侧系统树（n-tree，懒加载目录）+ 顶栏（搜索/通知/版本/用户）+ 主区（虚拟滚动列表/网格）
- 移动端：树收进抽屉
- 主题：Naive UI dark/light + 主题色跟随品牌色

## 9.2 核心页面
| 页面 | 要点 |
|---|---|
| 工作台 /workbench | 卡片化：最近上传/我的分享/存储用量环/下载趋势；卡片显隐与排序可自定义（settings.workbench） |
| 文件 /files | 虚拟滚动表格（n-data-table virtual）与网格（virtua 网格）双视图；悬停操作条（settings.hover_actions 配置按钮集与顺序）；多选批量条 |
| 回收站 /recycle | 独立页（复用文件列表组件） |
| 分享管理 /shares | 列表+状态徽标+编辑抽屉 |
| 存储 /storages | 卡片列表+用量进度（来源标注）+故障切换设置 |
| 项目 /projects /projects/:id | 详情 tab：统计/密钥/存储绑定/生命周期/公开库/WebDAV |
| 备份 /backups | 创建/恢复/远端 WebDAV 设置/远端列表 |
| 任务 /tasks | 进度条+失败清单+暂停继续 |
| 设置 /settings | tabs：全局/分享页品牌/通知渠道/悬停操作/工作台/系统与更新/开发者集成 |
| 登录 /login | 密码+TOTP |
| 公开页 /s/:token /fs/:token /lib/:slug | 品牌样式动态注入 CSS 变量；预览+下载；水印叠加 |

## 9.3 前端工程
- 虚拟滚动：列表 n-data-table `virtual-scroll`；网格用 virtua `VGrid`；图片缩略图 lazy + IntersectionObserver
- API 层：openapi-typescript 生成类型 + ofetch 封装（401 静默刷新重放一次、错误 toast 统一、AbortSignal）
- 上传：`useUploadQueue`（并发 3、分块 5MB、直传分支按 driver 凭证类型）；拖拽上传 n-upload 自定义 request
- 状态：Pinia stores（auth/files/ui）最小化；服务端状态用组件内 composable，不上重型缓存库
- 包体：手动 chunk（naive-ui/echarts 分包）；目标首屏 gzip < 500KB
- 弹窗规范：统一 AppDialog（teleport + display-directive="show" 按需）；**禁止全局 z-index 覆盖**（旧版教训），Naive UI 弹层自动层级
- 路由：全懒加载 + 登录守卫 + 403 页

# 10. Worker（进程隔离）
- 同 jar 启动：`java -jar ufm.jar --ufm.role=worker`；API：`--ufm.role=api`；API 进程内只保留：轻量即时任务（缩略图小图可选同步）+ API
- worker 能力开关（env）：FFMPEG_PATH、MEDIA_ENABLED、CONCURRENCY=2
- ffmpeg 调用：进程池（≤2 并发）、输入输出临时目录、失败重试 2 次、HLS 切片 ≤3s/段
- 优雅停机：SIGTERM → 完成当前分片 → 释放任务锁

# 11. 安全清单（同功能基线 §12，实现要点）
- bcrypt(10)；TOTP RFC6238
- 登录限流：PG 计数表 + 内存窗口（IP 10/5min、账号 5/15min）
- OpenAPI 签名：`HMAC-SHA256(secret, method\npath\ntimestamp\nsha256(body))`，±300s 时钟窗，nonces 表去重
- Webhook：HMAC-SHA256 头 `x-ufm-signature`
- SSRF：OkHttp/Apache HttpClient 封装 SafeFetcher（拒私网/环回/元数据 IP、仅 http(s)、重定向重验）
- 上传：magic bytes MIME 嗅探；HTML/SVG 强制 attachment；zip 条目 ≤10k、总解压 ≤1GiB、拒 `../`
- SSR/头：Spring Security headers + nginx 层 CSP
- IP 提取：X-Forwarded-For 首段（trust proxy 数量可配）

# 12. 部署与发布
- 镜像：`server-api`（eclipse-temurin:21-jre-alpine）+ `server-worker`（同镜像不同 role，含 ffmpeg 层）+ `postgres:16-alpine` + `web`（nginx:alpine 静态）
- compose（deploy/）：postgres/api/worker/web；健康检查 `/api/healthz`；卷 pg_data/storage_data
- 内存参数写死在 compose：`JAVA_TOOL_OPTIONS=-Xmx384m -XX:MaxRAMPercentage=70`
- nginx：/d/ 直链缓存（公开对象 proxy_cache 10m，签名旁路）；SPA fallback；/api 反代；WebDAV 透传
- CI：push → gradle build + test + 前端 build；tag v* → buildx 多架构（amd64/arm64）→ GHCR + 国内镜像 secrets 同步
- `release-update.sh` 沿用旧版 5 步逻辑（版本检测走南大 tags API、镜像源回退、**up 显式服务名**）
- 版本检查 `/api/system/version`：读 manifest 或 tags API（ghcr.nju.edu.cn 默认）

# 13. 测试与验收
- 单测：配额/阈值切换选择器/Range 解析/签名/分词/路径规范化
- 集成：Testcontainers PG —— 上传四通道 round-trip、分享校验链、SKIP LOCKED 多 worker 竞争、备份 restore 往返
- E2E：Playwright —— 登录→上传→分享→访客下载→回收站→恢复
- 性能验收（2C2G）：10 万文件列表虚拟滚动 60fps；并发 50 下载 CPU < 70%；上传 1GB 分块直传不占 API 内存

# 14. 实施路线（7 阶段）
| 阶段 | 内容 | 出口 |
|---|---|---|
| 1 骨架 | gradle 多模块+Naive UI 工程+CI+错误模型+openapi 管线 | CI 绿 |
| 2 数据层 | Flyway 基线 24 表 + PG 队列 + FTS | 空库可部署 |
| 3 认证项目存储 | auth/users/projects/storages(+绑定/切换) | 登录→建项目→配存储 |
| 4 文件核心 | 上传四通道/下载/回收站/目录/版本 | 功能 §2-§3 通过 |
| 5 分享与直链 | 分享/公开库/直链域/防刷/统计 | §4-§6 通过+隐私断言 |
| 6 worker 域 | 媒体管道/迁移/备份/通知/生命周期 | §8-§11 通过 |
| 7 前端体验 | 树视图/虚拟滚动/悬停操作/工作台/品牌页 | 性能验收+E2E 绿 |

每阶段结束打 tag 部署验证；旧系统（main 分支镜像）保持在线至阶段 7 验收后切换。

---

*冲突裁决：功能口径以 dev-features.md 为准；技术口径以本文为准；改口径先改文档再动代码。*
