# Docker 和 MySQL 磁盘占用

容器数量不能直接表示磁盘占用。数据库数据卷、应用文件、镜像共享层和部署备份需要分别统计；`df` 显示的多个 overlay 挂载通常引用同一个分区，不能相加。

## MySQL 为什么可能比业务数据大很多

MySQL 的 binlog 是数据库变更日志，与应用界面的请求日志、审计日志不同。删除应用日志不会删除 binlog。

`ManagedFile` 保存供检索使用的 `contentText`，单条记录可包含 200 KB 文本。采用 `binlog_row_image=FULL` 时，更新文件 key、校验值等少量字段，也会在日志中保存修改前后的完整行，包括没有改变的文本。频繁覆盖上传会持续积累这些副本。

默认 Compose 保持 binlog 启用，并提供以下配置：

| 环境变量 | 默认值 | 用途 |
|---|---|---|
| `MYSQL_BINLOG_ROW_IMAGE` | `MINIMAL` | 记录定位行所需的主键和实际改动字段，避免重复记录未变的大文本 |
| `MYSQL_BINLOG_EXPIRE_LOGS_SECONDS` | `259200` | 保留 3 天的 binlog |
| `MYSQL_MAX_BINLOG_SIZE` | `67108864` | 单个日志目标上限 64 MiB，便于过期日志按文件回收 |
| `DOCKER_LOG_MAX_SIZE` | `10m` | 每个容器的单个 Docker 日志上限 |
| `DOCKER_LOG_MAX_FILE` | `3` | 每个容器保留的日志文件数量 |

单个事务可以使 binlog 超过文件上限；保留时间也不是总磁盘容量的硬上限。持续写入很多数据时仍需观察增长。需要完整行日志的复制或审计消费者应将 `MYSQL_BINLOG_ROW_IMAGE` 配置为 `FULL`，按自身恢复窗口调整保留秒数。

这三项 MySQL 配置由 Compose 管理：修改项目 `.env` 后重新创建 MySQL 容器，启动参数才会更新。维护期间可以使用 `SET GLOBAL` 临时调整；临时值不会跨重启保留，`binlog_row_image` 的全局设置只对新连接生效，应用连接池需要重新建立连接。

如果以前使用过 `SET PERSIST`，MySQL 会在启动后段加载这些持久值，覆盖 Compose 的命令参数。交回 Compose 管理前，先记录以下查询结果，并保存数据库快照和需要保留的历史 binlog，然后只清除对应的三项持久化设置，不影响其他变量：

```sql
SELECT VARIABLE_NAME, VARIABLE_VALUE
FROM performance_schema.persisted_variables
WHERE VARIABLE_NAME IN
  ('binlog_row_image', 'binlog_expire_logs_seconds', 'max_binlog_size');

RESET PERSIST IF EXISTS binlog_row_image;
RESET PERSIST IF EXISTS binlog_expire_logs_seconds;
RESET PERSIST IF EXISTS max_binlog_size;
```

重新创建 MySQL 后，核对实际全局变量与 `.env` 的预期值一致，并确认上述查询不再返回这三项持久值。随后重新启动 API，建立使用新行日志设置的连接池。清除持久值本身不会修改当前运行值，也不会删除业务数据。

通过数据库自己的过期回收或 `PURGE BINARY LOGS` 管理历史日志，不能直接用文件删除命令移除 MySQL 正在管理的 binlog。清理前保存当前数据库快照并核对是否有依赖较旧日志的恢复或复制任务。本项目的数据库备份脚本使用全量 SQL 快照；缩短日志保留窗口不会替代这些备份。

## API 镜像如何保持精简

API 运行依赖从完整 workspace 元数据重新安装，只选择 API 的生产依赖。前端和存储插件安装包属于各自构建产物，不随 API 运行镜像复制。Prisma 迁移 CLI、数据库引擎、已生成客户端、sharp 原生组件、ffmpeg 和插件 SDK 仍保留。

运行文件通过 `COPY --chown=node:node` 设置属主。复制后对整个 `/app` 执行递归 `chown` 会产生额外的镜像层，应仅处理需要新建的存储目录。

使用独立的 Node 基础镜像构建新版本，不把上一版 API 镜像当作 `NODE_IMAGE`。否则原镜像里的依赖和旧文件仍留在基础层，即使新版本不再复制它们，镜像也不会变小。

构建后可以执行真实运行验收：

```sh
docker build --target api -t unified-file-manager-api:disk-optimized .
sh tests/acceptance/api-runtime-image.sh unified-file-manager-api:disk-optimized
```

验收不挂载生产数据，也不连接网络；实际加载运行依赖、生成 PNG、执行 Prisma CLI 和 ffmpeg，并以 node 用户验证存储目录可写。

## 部署备份保留

升级前保留一份完整、校验通过的回退快照。新版本确认稳定后，将需要长期留存的旧快照转存至远端，移除服务器旧归档和临时验收目录，避免每次升级都累积一份完整数据副本。Docker 命名卷和绑定的生产数据目录应单独保护。
