# 本地与真实云验收测试

发布版本：v0.2.2，基于 813adbbac39bc54638cb0cd6e29dc3bcad6c3c70 的 NestJS/Vue 项目实现。测试源码随该版本发布，真实凭据及验收数据不进入 Git。

测试项目、文件、历史版本、分享、备份、夹具、报告和截图全部保留。仅正常产品流程清理已完成的临时分片；回收流程中的文件随后恢复，不执行项目删除或永久清理。真实云凭据从已保存的配置读取，登录凭据从根目录 .env 读取，不写入报告。

## 回归与构建

```powershell
npm test
npm run build
npm run lint
```

npm test 包括存储校验/故障切换、版本并发、分享/Range、任务恢复、会话合并、前端取消/上传恢复、媒体源隔离、多副本展示、分页和概览等回归，使用合成对象或隔离临时目录，默认不接触真实云账户。2026-11-14 最终全量运行 250/250 通过，lint 与 API/Web/SDK build 通过；以每次实际输出为准。

v0.2.2 增加 DAV 上传外键、地址规则、冲突与路由隔离测试；该轮全量 263/263 通过。

## 真实流程

先启动 API http://localhost:3000、Web http://localhost:5175 与本地数据库，并保存两个全局云存储账户。主流程每次创建新项目，保留既有项目绑定。

```powershell
npm run test:acceptance:replicas
npm run test:acceptance:replica-browser
npm run test:acceptance:replica-followup
npm run test:acceptance:replica-video
npm run test:acceptance:verify-all
```

- replicas：本地＋又拍云＋七牛真实上传、逐副本就绪、全文/Range/公开直链、分享 HEAD/416/续传计次、撤销、改名搜索、覆盖、版本恢复、回收恢复、巡检。
- replica-browser：最新验收项目的真实网页登录、副本显示、巡检和故障上传文件目录；保留截图。
- replica-followup：11MB 三分片乱序/重复/重登续传、未完成拒绝合并、版本单调增长、并发覆盖和历史恢复、真实图片缩略图全副本与重新生成。
- replica-video：需要 FFMPEG_PATH、VIDEO_TRANSCODE_ENABLED=true、VIDEO_HLS_ENABLED=true。真实 ffmpeg 生成夹具并触发服务端 COVER/MP4/HLS，验收嵌套清单、TS/MP4 非零 Range、所有派生对象的三份真实摘要、覆盖和历史恢复。本机参数保存在 .runtime/local-api-overrides.json；其他机器需设置相应环境与可执行路径。
- verify-all：只读下载全部名称以“验收-”开头的项目有效文件，对照数据库大小和 SHA256，检查健康状态。

故障与重启脚本按顺序单独运行，避免后台 worker 与故障注入争抢租约：先安全停止本仓库 API，再执行 node tests/acceptance/replica-faults-real.cjs，随后启动 API 并执行 node tests/acceptance/replica-restart-real.cjs。使用真实云字节与独立适配器故障注入，不停用真实账户、不改变账户配置；留下故障上传文件和失效租约供恢复验收。不要在生产实例运行这些脚本。

本机 .runtime/start-local-api.ps1、restart-local-api.ps1、stop-local-api.ps1 验证进程身份；启动等待本 API 开始监听后供测试连接。根 .env 必须 UTF8 读取，避免中文本地根目录损坏。

## 其他验收入口

现有 test:acceptance:files、lifecycle、browser、share-ui、sessions、storage-ui、storage-real 等覆盖 ZIP、目录、复制移动、导出导入、登录历史和多对多全局绑定。部分旧脚本依赖之前留存报告，阅读脚本前置条件后单独执行。公开分享测试具有节流，避免同时从同一 IP 大量请求分享。

真实浏览器需 Playwright 和 Chrome。当前使用 Codex 已有 Playwright；部分脚本提供 PLAYWRIGHT_MODULE / CHROME_PATH 覆盖入口。验收地址保留 localhost，避免本地链接进入生产数据库。

## 报告与限制

JSON、夹具和截图位于 .runtime/acceptance-20261113/，被 Git 忽略并保留本地。该目录 replica-latest.json 指向最新主验收项目；再次执行 replicas 会更新指针，依赖脚本随后测试新项目。旧报告不删除。失败或中断返回非零，不能据以前报告宣称本轮通过。

公网 files.shifuf.com 已部署多存储、分页与概览版本 `storage-ui-20261114-022316`，验收结果见 `docs/acceptance/2026-11-14-storage-visibility-dashboard-report.md`。供应商未成功提供云用量时保持未知，阈值切换采用应用配额策略，不冒充供应商真实配额查询。SPA 内上传保留 File 继续；关闭浏览器或整页刷新后必须重新选择本地文件。

## 多存储展示、分页与概览验收

三个脚本：`storage-visibility-real.cjs` 创建并保留 22 个小文件，验证绑定新增云后补齐、副本接口、同步幂等、统一下载／分享、分页和概览；`storage-visibility-browser.cjs` 使用真实 Chrome 验证三表第二页、迟到响应隔离、手机布局、详情和网页上传结果；`storage-visibility-copies.cjs` 从 stdin 接收已有文件 ID／SHA256，直接读取三存储副本并对照数据库及概览，不创建或删除文件。

证据在 `.runtime/acceptance-20261114-storage-ui/`，`local-latest.json` 与 `public-latest.json` 是本地／公网项目指针。每个环境 API 11/11、Chrome 11/11，23 文件共 69 份实际副本全部校验通过；公网原有 19 个有效文件也逐个校验通过。全部项目、分享、文件、夹具、失败尝试及截图保留。再次运行主流程会创建新的项目；复核现有数据优先使用只读副本脚本，不重复创建验收数据。

公网账户通过测试脚本的 `UFM_TEST_AUTH_STDIN=1` 输入内存登录信息，浏览器地址可由 `UFM_TEST_BASE` 指定；逐副本脚本在容器内使用现有环境，`UFM_COPY_ROOT=/app`、`UFM_COPY_BASE=https://files.shifuf.com`。不将密码写入脚本、报告或命令行。

## WebDAV 上传与自定义地址

`node tests/acceptance/webdav-real.cjs` 创建三个保留项目，测试英文／数字／随机地址、冲突、普通保存、清空随机生成、旧 ID 兼容、停用隔离，以及真实 MKCOL/PUT/GET/HEAD/Range/覆盖/PROPFIND/COPY/MOVE。主验收项目绑定两个已启用真实云并等候副本校验完成，不覆盖现有绑定。可通过 stdin 额外传入 `davProjectId/davUsername/davPassword` 测试已有项目；仅在确认 `sub` 为空时执行用户要求的目录清理。

`node tests/acceptance/webdav-browser.cjs` 使用最近一轮保留项目，测试地址输入校验、预览、混合保存、清空随机和迟到响应隔离。浏览器需要现有 Playwright/Chrome，可设置 `PLAYWRIGHT_MODULE`、`CHROME_PATH`。证据保留在 `.runtime/acceptance-20261114-webdav/`，`local-latest.json`／`public-latest.json` 是两环境指针。源码不保存真实 DAV 或管理员密码。
