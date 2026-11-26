# 数据库 SQL 分发与升级（v0.3.0）

数据库结构的权威来源是 `apps/api/prisma/schema.prisma` 与原有 Prisma 迁移目录。`schema.sql` 把当前结构汇总为一个 MySQL SQL 文件，便于空库评审、独立初始化和结构比对。它不含业务数据、管理员账号或 `_prisma_migrations`，也不是累积更新脚本。

## 正常安装与升级：使用同一个入口

源码部署在仓库根目录执行：

```bash
npm ci
npm run prisma:generate
npm run db:deploy
npm run build
```

执行前按照 `.env.example` 配置环境。Prisma CLI 需要可用的 `DATABASE_URL`；API 启动脚本会从 `MYSQL_*` 生成它，直接运行 CLI 时请在受保护的环境变量中提供。不要把连接串写入提交或共享日志。

`npm run db:deploy` 调用 `prisma migrate deploy`，根据数据库的 `_prisma_migrations` 仅执行缺少的迁移；在空库会按顺序应用完整迁移链，在已部署数据库上不会重复执行已完成的 ALTER 或数据回填。管理员初始化仍由现有启动/seed 流程负责。Docker API 的现有启动入口也会部署迁移，无须手工导入 SQL。

升级前备份数据库、本地文件、插件目录和 `.env`，保留原有数据库卷。不要删除数据库卷、使用 `migrate reset` 或把 `schema.sql` 导入现有库。

## 生成和验证单一 SQL

```bash
npm run db:sql
npm run db:sql:check
```

生成器仅调用仓库已安装的 Prisma `migrate diff --from-empty --to-schema-datamodel ... --script`，不连接数据库，不执行 SQL，不修改原有迁移。输出固定为：

- `schema.sql`：当前版本的完整建表、索引、外键结构；只用于空数据库。
- `manifest.json`：应用版本、Prisma 版本、schema/SQL 的 SHA-256，以及按顺序列出的每个原有迁移文件 SHA-256。源码摘要统一把 CRLF 规范为 LF 后计算（`sourceLineEndings: "LF"`），保证 Windows/Linux 检出一致；这是分发完整性摘要，不用于替换数据库中 Prisma 自己记录的 checksum。

没有生成时间、机器路径或密钥，重复生成得到相同文件。`--check` 会重新生成并比较两个文件，容忍 Git 的 CRLF/LF 检出差异；过期或缺失时返回非零退出码，且不会覆盖产物。也可使用 `node scripts/sql/generate-schema.cjs --output-dir <目录>` 生成到隔离目录。

13 个原有迁移截至 v0.3.0 全部保留原名和原始内容。它们还包含本地存储绑定等数据回填；结构快照不能替代这些对旧数据的处理。以后新增迁移，再更新快照与清单，不压缩或重写已经部署的历史。

## DBA 手工空库安装的边界

优先使用上面的 `db:deploy`。如果必须手工导入 `schema.sql`，目标必须是新建的空数据库，数据库字符集使用 `utf8mb4`。导入后仍要执行以下步骤，才可交给正常 Prisma 部署维护：

1. 在隔离库导入并检查所有语句成功；不要使用 MySQL `--force` 忽略错误，不要在失败后直接再次导入。失败的空库应重新创建后重试。
2. 配置好该空库的 `DATABASE_URL` 后，执行只读比较：`npm exec -- prisma migrate diff --from-schema-datasource apps/api/prisma/schema.prisma --to-schema-datamodel apps/api/prisma/schema.prisma --exit-code`。退出码必须为 0；有差异则停止，不能做基线标记。连接串从环境读取，不必放进命令参数。
3. 仅限这次新建、导入并验证完成的空库，按照 `manifest.json` 的顺序，对每个迁移名称执行 `npm exec -- prisma migrate resolve --applied <名称> --schema apps/api/prisma/schema.prisma`，记录真实的迁移历史与校验值。此步骤不执行 SQL。不要拿它跳过现有数据库的待执行迁移。
4. 执行 `npm run db:deploy`，确认没有待执行迁移，然后按正常流程初始化管理员、构建和启动。

手工 SQL 导入和全部基线标记完成前不要启动应用。只导入快照后直接运行 `migrate deploy`，会因缺少迁移历史而尝试重新建表；此时应停止并核查，不应删库或伪造现有库历史。结构相同也无法证明旧库的数据回填已经执行。

MySQL DDL 通常不是可整体回滚的事务。任何失败的生产迁移都应先保留现场、核查备份和失败状态，再按照 Prisma 的失败迁移恢复流程处理；本分发入口不会自动修复、删除或重建生产表。

## v0.3.0 验证范围

2026-11-26 使用全新、独立的 MariaDB 10.11.11 数据目录完成以下实际验证：

- 原有 13 条迁移可以在空库全部部署成功；单一结构快照可以在另一个空库成功导入。
- 两条安装路径的数据库结构完全一致，且与当前 Prisma schema 的结构比较均无差异。
- 手工空库安装逐条标记基线后，迁移名称和 Prisma 实际记录的 checksum 与正常迁移安装完全一致。
- 两个数据库再次正常 `migrate deploy` 均没有待执行迁移，测试数据保留。
- 重复向完整数据库导入快照按预期失败，原测试数据仍在；这不代表允许把快照用作升级脚本。

回归测试同时覆盖重复生成一致、过期产物检查不改写、CRLF/LF 检出、非法参数拒绝和随版本分发的 SQL 是否最新。该本机验证不等同于 Docker 镜像构建或独立 MySQL 8 引擎验收。
