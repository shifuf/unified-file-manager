# 在线文本编辑与 JSON 原始链接

文件管理中，支持的文本文件会显示「编辑内容」。也可以点击「预览」打开文本编辑器；只有项目管理者可以保存。支持 TXT、JSON、JS/TS、Python、Markdown、HTML/CSS、XML、YAML、Shell、Java、Go、Rust、C/C++ 等常见代码和配置文件，以及声明为文本的其他文件。

在线编辑要求 UTF-8 编码，单文件最大 2 MiB。含 NUL 的二进制文件或无法正确解码的文件会被拒绝。PDF、Office、图片、音视频保留原有预览方式；修改这些文件应使用对应编辑软件，再覆盖上传。

每次点击「保存新版本」都保留旧版本，并将当前版本递增，包括保存相同内容或空文本。文件 ID、所在目录、公开状态、标签、备注和原分享链接不变。新内容通过现有存储流程保存并同步到项目绑定的存储插件。若其他人已经修改或回收文件，保存会失败并保留输入内容，防止覆盖新版本。

## JSON 直链

有两种地址可直接读取 JSON，无需打开分享页面：

- 文件直链：`https://你的域名/api/public/files/文件ID`。在文件的「更多 → 复制直链」或编辑器中复制。外部应用无来源请求访问时，请先公开该文件，或者使用已有的签名链接；原有访问策略继续生效。
- 分享原始链接：`https://你的域名/api/shares/分享token/raw`。无密码文本分享页面也提供「查看原始文件」入口。此链接保留分享的密码、有效期、IP 和启用状态等限制，按预览处理，不增加下载次数。它始终返回文件内容，不会因 `Accept: application/json` 返回分享信息。

`.json` 文件通过以上入口返回 `Content-Type: application/json; charset=utf-8`。原始内容不会重新格式化，也不会被包装为接口结果。保存后同一地址即可读取最新版本。

例如本次反馈中的分享更新后可直接读取：

`https://files.shifuf.com/api/shares/3dbee7604cd35487ad62484879376dfb70659f331f4b3b72/raw`

该地址需要部署包含此功能的新版本后才生效。

## 内容 API

登录态下：

```http
GET /api/files/:fileId/content
```

返回 `{ "content": "原始文本", "version": 1 }`。

```http
PUT /api/files/:fileId/content
Content-Type: application/json

{ "content": "新文本", "expectedVersion": 1 }
```

返回更新后的文件信息，其中 `currentVersion` 递增。`expectedVersion` 必须使用读取时返回的版本；版本冲突返回 HTTP 409。保存需要项目管理权限。

## 验证

```shell
npm test
npm run build
npm run lint
node tests/acceptance/text-content.cjs
```

最后一条需要先启动本地 API 和前端，并配置本地 `.env` 管理员账号；只连接 localhost/127.0.0.1。它创建并保留独立验收项目，验证编辑器、JSON 分享预览、原始链接、版本恢复、权限和冲突；结果与截图写入 `.runtime/text-acceptance/`。

可选设置 `ACCEPTANCE_TEXT_CLOUD=1`，将已配置并启用的 R2、又拍云账号追加绑定到验收项目，验证编辑后副本同步与云端读取。此模式会保留验收文件和项目绑定，不修改其他项目的绑定。
