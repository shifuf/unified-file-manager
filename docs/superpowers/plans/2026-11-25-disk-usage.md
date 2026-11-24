# Disk Usage Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 降低 MySQL 日志写入放大和 API 镜像占用，并验证服务器正常运行。

**Architecture:** 保持现有数据库和业务接口，优化 MySQL 配置与 Docker 依赖安装/文件属主；用真实运行镜像验证原生组件和依赖完整性。

**Tech Stack:** Node 22、npm workspaces、Prisma 6、MySQL 8.4、Docker Compose。

**Spec:** `docs/superpowers/specs/2026-11-25-disk-usage-design.md`

## Global Constraints

- 版本保持 0.2.2，不创建 tag 或正式 Release。
- binlog 继续启用；默认 MINIMAL、259200 秒、67108864 字节，均允许配置。
- 保留 Prisma 迁移/客户端、sharp、ffmpeg、存储插件 SDK 及现有业务。
- 保留原先已暂存的 WebDAV 计划修改，不纳入本次提交。
- 上传和构建仅在 `/www/wwwroot/unified-file-manager` 下进行。

## Review Focus

- npm workspace 筛选后仍残留前端/插件依赖：运行时应无法解析这些包。
- Prisma 生成客户端或迁移引擎丢失：实际构造客户端并执行 CLI。
- sharp 的 musl 原生绑定或 ffmpeg 丢失：实际生成 PNG 并执行 ffmpeg。
- node 属主处理导致存储不可写：以 node 用户实际写入测试文件。
- MySQL 配置未生效或影响业务：核对实际变量、数据计数和服务健康。
- MySQL 旧持久值覆盖 Compose：记录并仅清除对应三项持久值，重建后核对其为空且实际变量符合预期。

## Task 1: API runtime image

**Files:** Modify `Dockerfile`; create `tests/acceptance/api-runtime-image.sh`.

**Interfaces:** 消费标准构建阶段和 API 镜像标签；提供精简且具有完整运行能力的 API 镜像。

- [ ] 先写真实镜像验收脚本，对现有镜像运行，确认因携带前端/插件依赖失败。
- [ ] 将运行时依赖改为独立、仅 API 生产依赖安装；复制构建生成的 Prisma 客户端。
- [ ] 运行文件使用 COPY --chown，取消整目录递归 chown。
- [ ] 从干净 Node 基础镜像构建并运行镜像验收，记录大小。

## Task 2: Database and log configuration

**Files:** Modify `docker-compose.yml`, `.env.example`; create `docs/disk-usage.md`.

**Interfaces:** 提供 MYSQL_BINLOG_ROW_IMAGE、MYSQL_BINLOG_EXPIRE_LOGS_SECONDS、MYSQL_MAX_BINLOG_SIZE、DOCKER_LOG_MAX_SIZE、DOCKER_LOG_MAX_FILE。

- [ ] 添加可配置的 MySQL 行日志、过期时间、单文件大小和 UFM 日志轮转。
- [ ] 用 Compose 实际解析结果验证默认值及自定义值，保留敏感环境变量不输出。
- [ ] 文档说明原因、默认值、全量快照备份及过期日志的处理方法。

## Task 3: Verification and publication

**Files:** 本次修改文件；独立本地/服务器证据目录。

**Interfaces:** 在现有 `feature/aliyun-drive-node` 分支提交并同步；服务器 API/Web/MySQL 配置与经验证的镜像。

- [ ] 运行项目完整测试、lint 和 build，记录任何失败并修复与本次有关的问题。
- [ ] 完整检查 diff 和用户原有暂存内容，仅提交本次文件并推送现有分支。
- [ ] 部署前保存数据库快照、配置和需要保留的旧 binlog；记录并只清除三项对应的 MySQL 持久值，按 Compose 重新创建 MySQL，再更新 API 镜像并重建连接池。
- [ ] 核对实际 MySQL 全局变量符合 Compose 配置，且这三项对应的持久化记录为空；在线临时调整仅使用 SET GLOBAL。
- [ ] 核对数据计数、服务健康、日志策略和磁盘空间，清理本轮构建/验收临时数据。
