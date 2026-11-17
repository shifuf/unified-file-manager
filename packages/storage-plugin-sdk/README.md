# 存储插件 SDK

此 SDK 面向 Node.js 22 服务端存储插件，与调用文件管理业务接口的 `@ufm/sdk` 分开。SDK 不依赖 NestJS、Prisma 或宿主源码。只有本地存储内置；七牛、又拍云、OSS、S3、R2 都需要管理员主动上传 ZIP 安装。

## 从示例开始

1. 获取发布产物 `ufm-storage-plugin-sdk-1.0.0.tgz`，复制本包的 `example` 目录到任意宿主仓库之外的开发目录。
2. 在该目录运行 `npm install /absolute/path/ufm-storage-plugin-sdk-1.0.0.tgz`。
3. 修改 `storage-plugin.json` 的 id、名称、字段和版本，在 `index.ts` 中实现自己的适配器。
4. 运行 `npx ufm-storage-plugin pack .`。工具将 TypeScript 与 npm 依赖 bundle 为一个 CommonJS 文件，验证 manifest 和接口，生成 `<ID>-<version>.zip`。
5. ZIP 解压后可运行 `npx ufm-storage-plugin validate ./unpacked-directory`。运行示例契约测试：`node contract.cjs`。
6. 管理员进入「存储配置 → 插件管理」上传 ZIP，随后新增存储配置并测试连接。

CLI 不执行插件的 npm 安装脚本。依赖只在开发者构建机安装；宿主只加载包内 CommonJS 代码。原生扩展和外部 npm 依赖不支持。ZIP 内包含 `storage-plugin.json`、`index.cjs`，可选 LICENSE、NOTICE、README.md。开发者必须审核其依赖许可证并保留版权声明。

## 接口

```ts
import type { StorageAdapter } from '@ufm/storage-plugin-sdk';
export function createAdapter(): StorageAdapter { /* 返回无宿主依赖的适配器 */ }
```

必需方法：`upload`、`uploadFile`、`remove`、`getDownloadUrl`、`objectExists`。`uploadFile` 必须流式读取宿主已验证文件，不能把整个文件读入内存。`getDownloadUrl` 返回宿主可读取的 URL；也可实现 `getDownloadTarget` 返回 Node 可读流，Range 参数按包含末字节的区间解释。

可选 `createDirectUpload` 与 `getUsage` 必须分别匹配 manifest 的 `directUpload` 和 `usage`。不能查询容量时返回 null/unknown，不能伪造 0。没有供应商用量接口时声明 `usage:false`。

对象 key 由宿主提供并视为不可变；不要改写 key。后台复制传入字节数与 SHA256。删除不存在对象应成功。设置网络超时，关闭未消费的响应体，释放文件流；错误消息不得泄露密钥、签名 URL 或认证头。预签名凭据实际有效期与 `expiresAt` 必须一致。

业务文件的普通删除只进入回收站，插件不应自行清理回收对象或设置到期删除。用户在回收站确认彻底删除后，宿主才对各存储调用 `remove` 并通过 `objectExists` 校验。删除已不存在的对象应幂等成功；鉴权失败、网络失败、服务端错误必须抛错，不能当作不存在。宿主保留未完成的删除记录供重试。连接测试等临时探测对象由宿主自行清理。

`validateManifest(value)`、`validateConfig(manifest, config)` 和 `validateAdapter(manifest, adapter)` 在失败时抛出 Error。配置校验保留旧配置未知字段、填充默认值、验证字段类型和 select 选项。`secret:true` 告诉宿主加密与脱敏，不要只依赖字段名字。`url:true` 允许 HTTP/HTTPS 或省略协议的域名；更严格的供应商限制应由适配器实现。

ID 为大写字母开头的 2–64 位大写字母、数字和下划线，`LOCAL` 保留。版本为数字 `x.y.z`，协议 `apiVersion:1`，入口固定 `index.cjs`。升级要兼容所有现存配置，否则宿主拒绝激活。启用配置或仍有文件、副本、历史版本、预留及可恢复任务引用时不能卸载；已停用且没有使用依赖的历史配置不阻止卸载。

宿主执行方法前应用字段默认值并校验配置，兼容旧表单保存的 `"true"`/`"false"` 布尔字符串。插件方法抛出的错误会按实际密钥值和声明进行脱敏；插件仍须避免自行输出凭据日志。

## S3 与 R2

```ts
import { S3Adapter, signS3Headers, presignS3 } from '@ufm/storage-plugin-sdk/s3';
```

签名工具独立可导入，支持 SigV4 标头签名和预签名 GET/PUT。R2 的 region 固定 `auto`、path-style 固定开启，默认 endpoint 为当前账号 R2 地址。高级 endpoint 仅接受同一账号的默认、`eu` 或 `fedramp` 官方 HTTPS 地址；公开域名只用于展示，不能替代签名 API endpoint。

浏览器直传需要在 R2 bucket 配置 CORS：允许实际前端 Origin，Methods 至少 `PUT`、`GET`、`HEAD`，AllowedHeaders 至少 `Content-Type`，按需暴露 `ETag`。只在可信前端签发短期、限定 key 的凭据。R2 插件不需要 Cloudflare 管理 API token，不提供供应商用量查询。

当前宿主的本地安全副本策略保持不变：业务上传先落本地，再流式复制远端。插件具备签名直传能力，SDK 契约测试会覆盖它；宿主现有业务直传入口仍按安全副本策略禁用，不因插件声明自动绕过本地副本。

插件是管理员授权执行的受信任服务端代码，不是恶意代码沙箱。当前安装生命周期支持单 API 实例；不要让多个 API 实例同时管理同一插件目录。

## 交互登录与持久状态

声明 `capabilities.authentication:true` 的插件必须实现 `startLogin`、`pollLogin`、`cancelLogin`、`accountStatus` 和 `disconnectAccount`。宿主仅向超级管理员开放认证操作，登录凭据不得包含在这些方法的响应中。SDK 同时提供 `PluginAccount`、`PluginLoginSession` 和 `PluginLoginResult` 类型。

插件入口可以导出 `createAdapter(context?: PluginContext)`。宿主传入按插件隔离的 `getState`、`setState`、`withLock`，状态使用宿主 `APP_CRYPTO_KEY` 加密保存在插件目录的 `state/<ID>` 中，升级不会覆盖。对同一凭据的刷新、重新登录及删除使用相同锁，更新使用原子写入。打包验证时不传 context，此时允许构造适配器，但需要状态的方法应明确报错。

配置字段可声明 `hidden:true`（表单不显示）和 `immutable:true`（交互登录插件的已有配置不可更换该字段）。内部账号引用可作为隐藏字段；令牌及设备密钥应存入加密状态，不能返回表单。备份时同时保存数据库、插件 state 目录和原 APP_CRYPTO_KEY。

## 仓库构建与测试

仅备份插件声明 `capabilities.backupOnly:true`，并实现 `verifyBackup(config, { key, size, checksum })`。该方法通过云端元数据确认对象与源摘要映射，不下载内容。宿主跳过内容读取及下载流量预留，保留空间额度限制；备份不能成为预览、下载或复制恢复的来源。已有插件未声明该能力时沿用完整读取校验。

```sh
npm run build:plugin-sdk
node plugins/build.cjs
node --test tests/plugins/sdk.test.cjs tests/plugins/r2-protocol.test.cjs
npm pack --workspace packages/storage-plugin-sdk
```

五个 ZIP 位于各 `plugins/<name>/` 目录。它们仅作为可安装发布产物，构建不会将插件激活或预装到宿主。R2 协议测试用本地 HTTP 服务独立验证 SigV4 并注入传输，不放宽生产 endpoint 校验，也不等同于真实 Cloudflare 账号验收。
