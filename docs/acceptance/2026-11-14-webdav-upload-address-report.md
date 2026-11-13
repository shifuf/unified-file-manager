# WebDAV 上传与自定义地址验收

用户批准按设计实现、测试并发布 v0.2.2。设计和计划：`docs/superpowers/specs/2026-11-14-webdav-upload-address-design.md`、`docs/superpowers/plans/2026-11-14-webdav-upload-address.md`。

## 根因与实现

DAV 是项目级独立凭据。旧 PUT 将 `webdav:<用户名>` 合成标识写入 `ManagedFile.uploadedById`，该字段关联 User.id；这会稳定触发外键失败，不代表用户数据已被删除。修复将上传者外键留空，配额、事件和下载记录仍保留 DAV 标识。两个服务／真实 verb 回归先复现同一外键错误，修复后通过。

新增 Project.webdavSlug 唯一字段，启用的既有项目由迁移生成随机后缀。英文／数字／混合 1–64 位，保存小写；不填写随机 24 位密码学十六进制，省略字段保留原值，显式清空重新生成。查询和数据库唯一约束共同防止冲突，回收项目和其他项目 ID 也不可被占用，竞态冲突返回409。原项目 ID 地址继续兼容；认证后以真实项目为作用域，PROPFIND/COPY/MOVE 使用本次入口并检查完整路径边界。

项目编辑加入输入、预览和取消／代次检查。DAV 内部500返回通用消息，不把 Prisma 调用或对象路径返回给客户端。

## 本地证据

- 全量回归 263/263、lint、API/Web/SDK build 通过，日志 `.runtime/webdav-all-{tests,lint,build}-final.log`。
- 本地新迁移成功；Windows Prisma 引擎首次生成受运行中的 API DLL 锁影响，按已记录进程身份停止 API 后生成成功，没有影响数据库或文件。
- 真实 DAV API 流程10/10：三种后缀、冲突、保留／重生成、旧 ID 兼容、停用、MKCOL/PUT/GET/HEAD/Range/覆盖/PROPFIND/COPY/MOVE以及云同步通过。主文件本地、七牛、又拍云三份字节与 SHA256 一致。
- 真实 Chrome5/5：非法后缀、混合保存、小写预览、清空随机、编辑切换迟到响应隔离及无未处理错误。首次脚本在登录导航期间执行页面表达式导致 context destroyed，改为等待概览并正常进入项目页，完整重跑通过；失败尝试保留，未据此更改产品。
- 证据和夹具 `.runtime/acceptance-20261114-webdav/`，三个验收项目及文件全部保留；独立审查与公网发布验收将在本报告收口。

## 上一版发布

v0.2.1 提交 `87cdb1a97d6fd757e4d10279f05f633a46851658` 已推送 main和标签，GitHub验证及双镜像发布成功。服务器API/Web版本接口v0.2.1，318个源码文件按统一文本换行比对提交一致，切换前12个有效文件全量下载大小/SHA256与SQL备份一致；新备份 `.runtime/release-v0.2.1-manifest.json` 所指发布名保留。初次 MySQL客户端默认字符集使夹具中文变问号，使用切换前SQL备份恢复真实元数据后校验通过，失败证据保留。DAV后续修复不重写已发布标签。
