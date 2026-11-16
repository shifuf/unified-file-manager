# 独立远程存储插件

这里的五个插件均通过 SDK 构建成独立 ZIP，不会随 API 启动自动安装。管理员根据需要上传对应 ZIP；已有远程配置保留原 provider 和对象 key，安装匹配插件后恢复使用。

| 目录 | 插件 ID | 浏览器直传 | 用量接口 |
| --- | --- | --- | --- |
| qiniu | QINIU | 支持 | 存储用量 |
| upyun | UPYUN | 不支持 | 返回控制台查看提示，数值未知 |
| aliyun | ALIYUN | 支持 | 不支持 |
| s3 | S3 | 支持 | 不支持 |
| cloudflare-r2 | CLOUDFLARE_R2 | 支持 | 不支持 |

仓库根目录执行 `npm run build:plugin-sdk` 后执行 `node plugins/build.cjs`，或加单个目录名仅构建该插件。ZIP 生成在各插件目录，源码可独立复制并安装 `@ufm/storage-plugin-sdk` tarball 后执行 `npm run build`。开发者详细说明见 `packages/storage-plugin-sdk/README.md`。

## 一键安装全部插件

API 启动后，在已安装依赖的源码目录执行：

```bash
npm run plugins:install
# 或指定服务地址
npm run plugins:install -- --url http://127.0.0.1:3000
```

Docker 部署使用：

```bash
docker compose --profile plugins run --rm --no-deps --build plugin-installer
```

命令读取 `.env` 管理员账号密码，构建五个 ZIP，逐个通过管理员上传接口安装，并检查插件可用状态与版本。已经安装的插件会更新为当前源码版本。不会新建云存储账号或自动填写供应商密钥。启用两步验证时设置 `UFM_TOTP_CODE`；账号密码与 `.env` 不同时可用 `UFM_ADMIN_USERNAME` / `UFM_ADMIN_PASSWORD` 环境变量覆盖（Docker 可通过 `run -e` 传入）。

七牛使用 qiniu SDK，OSS 使用 ali-oss SDK；它们只属于插件构建依赖，最终 ZIP 已包含所需 JavaScript 代码。其余插件只依赖 SDK 和 Node 内置模块。所有插件保留旧字段名，密钥字段通过 manifest 声明。

七牛/OSS 的可选代理依赖包含脚本编译器入口；包明确禁用可选 CoffeeScript 和 TypeScript 运行时编译器，仅支持 JavaScript PAC。正常 HTTP/HTTPS 代理与存储请求不需要这些编译器。禁用项由 package.json 的 `ufmStoragePlugin.unsupportedOptionalModules` 声明，调用时明确报错；不会回退到宿主 npm 依赖。
