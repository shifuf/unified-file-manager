# 存储插件与目录管理验收（2026-11-16）

本轮实现只保留 LOCAL 内置。QINIU、UPYUN、ALIYUN、S3、CLOUDFLARE_R2 的实现从 API 移出，作为独立 ZIP 由管理员安装。旧 provider、配置 ID、文件 key 不变；没有安装插件的远端配置不会自动恢复执行。

## 本轮验证

| 验证 | 结果 |
| --- | --- |
| `npm test`：现有回归（含确认删除与五种插件） | 380/380 通过 |
| `npm test`：SDK、R2 协议、插件删除契约、一键安装、安装器、动态表单、目录专项 | 21/21 通过 |
| `npm run build` | API、Web、业务 SDK、插件 SDK 均成功 |
| `npm run lint` | API、Web 均通过 |
| 五个独立插件 bundle 从仓库外目录加载 | 全部通过 |
| SDK tarball 在仓库外安装、示例打包与契约 | 通过 |
| `node tests/plugins/integration.cjs` | 9 项真实 API/数据库流程通过 |
| `node tests/plugins/lifecycle-integration.cjs` | 6 项数据库/生命周期流程通过 |
| `node tests/plugins/live-browser.cjs` | 真实浏览器 + 真实 API 通过，无页面错误 |
| `node --test tests/plugins/storage-plugin-browser.cjs` | 3/3 前端交互通过（API 使用夹具） |

`npm test` 已纳入插件构建及专项测试，并限制旧回归并发为 4；测试源码已解除 Git 忽略，随源代码交付。构建仍有已有 VueUse 注解/动态导入 chunk 提示，不影响构建成功。

真实 API 验证包括：认证拒绝；五个 ZIP 安装及下载摘要一致；独立第三方插件包；上传/读回字节校验/删除连接测试；任意名称 secret 字段加密存储、脱敏编辑；项目绑定、文件上传、跨存储复制、校验下载、Range；有后代文件拒删目录；文件回收后删除空目录；备份内含插件清单与可选 ZIP。

生命周期验证包括：实际数据库密钥为 vault 密文；备份包内容；缺失插件时在 replace 清理前拒绝恢复；不兼容升级保留旧版本；重启加载；未引用插件卸载重装；有文件/副本等引用拒绝卸载。

真实 MariaDB 10.11/InnoDB 并发测试确认：Serializable 目录内容检查产生的谓词锁阻塞并发插入直到删除提交；随后插入的文件使目录树重新显示目录，后续删除因目录有文件被拒绝。因此保留已有事务方案，未引入覆盖所有写路径的额外项目锁。

真实浏览器连接独立 API，执行 R2 ZIP 上传升级、下载包、项目根目录创建、子目录创建、非空父目录拒删。截图为 `.runtime/plugin-work/live-plugins.png` 与 `live-directories.png`。前端 API 夹具测试另覆盖动态类型字段、默认 false/0、密钥编辑与插件缺失配置展示，不能视为云端验收。

## 测试环境与复现

插件首轮验收使用独立 MariaDB 实例 `127.0.0.1:3316`、专用库 `ufm_plugins_acceptance_20261116`、API 3016、静态浏览器代理 5176。后续已在主本地环境应用插件迁移并安装五个远端插件，删除与根目录问题使用主 API 3000、前端 5175 及独立创建的测试项目验证。

1. `npm install && npm run prisma:generate && npm run build && npm test`
2. 为独立测试数据库设置 `UFM_PLUGIN_TEST_DATABASE_URL` 后运行 `node tests/plugins/local-environment.cjs`（需要建库权限；必须显式指定独立测试库）。
3. 运行 `node tests/plugins/start-api.cjs`，再执行 integration.cjs、lifecycle-integration.cjs。
4. 运行 `node tests/plugins/browser-server.cjs`，再执行 live-browser.cjs；浏览器路径可用 `CHROME_PATH`，Playwright 可用 `PLAYWRIGHT_MODULE`。

日志和 JSON 证据在 `.runtime/plugin-work/`。临时测试环境文件含数据库连接配置，受 Git 忽略，不属于发布产物。

## 外部验证限制

- **真实 Cloudflare R2 已追加验收**：用户配置 `Cloudflare R2 - shifuf` 后，使用独立测试项目完成上传 READY、回收保留、恢复并逐字节下载验证、彻底删除后 R2 HEAD 与本地存在性均为 false、副本队列和文件记录清除。脚本 `tests/acceptance/r2-permanent-delete-main.cjs`，结果 `.runtime/plugin-work/r2-delete-result.json`；仅删除本次创建的测试对象，未清理既有孤立对象。
- 七牛、又拍云、OSS 本轮完成插件独立加载及适用的已有回归，未重新写入真实供应商账户。
- 当前机器没有 Docker 命令，未实际构建 Docker 镜像。Dockerfile 的 workspace 依赖裁剪位置已根据独立审阅修正，Compose 增加独立插件持久化卷；需要有 Docker 的环境完成镜像验收。
- 宿主仍按现有策略先落本地副本再复制远端。插件 SDK 支持并验证签名直传，但宿主业务直传入口仍禁用，不绕过本地安全副本。

## 交付文件

- `packages/storage-plugin-sdk/ufm-storage-plugin-sdk-1.0.0.tgz`
- `packages/storage-plugin-sdk/README.md`、`example/`
- `plugins/qiniu/QINIU-1.0.1.zip`
- `plugins/upyun/UPYUN-1.0.0.zip`
- `plugins/aliyun/ALIYUN-1.0.0.zip`
- `plugins/s3/S3-1.0.0.zip`
- `plugins/cloudflare-r2/CLOUDFLARE_R2-1.0.0.zip`

ZIP/tarball 为本地产物，通过 `npm run build:plugins` 与 `npm pack --workspace packages/storage-plugin-sdk --pack-destination packages/storage-plugin-sdk` 重建。未发布 npm、未推送 Git、未部署线上。

## 删除与根目录问题追加验证

- 普通删除进入回收站并保留对象；彻底删除清理本地、所有已索引远端副本、历史版本和 HLS 分片。存储失败保留记录及 DELETING 标记供重试；后台巡检不得重新激活该标记。
- 专项回归覆盖多副本删除、失败重试、共享引用保护、活动同步租约拦截、巡检不复活删除对象。
- 项目列表新增“新建根目录”；`tests/acceptance/root-folder-main.cjs` 通过真实浏览器验证列表创建、详情创建根目录和子目录、父目录非空拒绝、逐级删除空目录。
- `npm run build:api`、`npm run build:web`、`npm run lint` 均通过。服务已用新版构建启动在本地 3000；前端 5175。

## 确认删除与中文类型追加验证

- 按用户要求停止回收站到期自动清理，旧的到期记录也不会被定时任务移除。必须通过单个或批量彻底删除操作确认后才清理对象。界面移除倒计时并说明手动确认策略。
- 七牛插件修复 SDK 返回 HTTP 失败但 error 为空时的错误判断，更新为 1.0.1 并已安装主环境。五个插件均验证删除、重复删除和权限失败契约。
- 又拍云与 Cloudflare R2 真实账户分别验证：上传、过期回收仍保留、恢复下载内容一致、确认彻底删除、本地和远端不存在。证据 `.runtime/plugin-work/upyun-delete-result.json`、`cloudflare_r2-delete-result.json`。
- 七牛、OSS、S3 本轮为插件契约与宿主回归验证，没有对应真实账户的重新写入验收。
- 中文显示覆盖项目文件类型、公开资源库、任务类型与筛选、存储平台及文件存储详情。真实浏览器验证项目中文类型、根/子目录创建和回收站手动清理提示。
