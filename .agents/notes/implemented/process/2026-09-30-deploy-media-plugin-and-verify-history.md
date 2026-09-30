# Agent Note: 插件独立发版与历史认证验证

Status: implemented

## Problem

插件部署落后于开发仓库的分块读取修复，且单独填写的历史 key 不被 Hermes API 接受。capabilities 正常不能证明历史恢复链路可用。Hermes 内置备份未对插件 .sqlite 库使用 SQLite backup，需要明确数据恢复范围。

## Decision

发布固定提交的 emu-media 0.2.0，保留协议 v1 和现有数据结构。历史变量使用有效的 Hermes gateway API key，与 emu-chat 当前密钥一致，不声明独立只读权限。

插件工具使用独立 systemd 用户任务，检查没有 active agents后，暂停两个服务、备份、修正凭据、切换独立版本目录，再按顺序重启和验证历史读取、既有图片、历史补偿及 emu-chat健康状态。与 emu-chat发版共用控制锁，避免两个流程同时操作服务。

## Alternatives considered

- 原位复制插件：步骤简单，但容易混入旧模块和字节码，且难以辨认实际版本；改用固定提交与版本目录。
- 单独随机历史 key：如果 Hermes 支持只读认证，能够减少权限；当前基线不识别它，实际返回 401，使用有效 API key并在文档说明权限。
- 仅使用 Hermes 内置备份：已有工具方便，但当前实现只对 .db安全快照；插件 .sqlite由独立流程用 SQLite backup处理。

## Consequences

插件 0.2.0 从本地 v0.2.0 tag 的 d34c827 固定提交构建并部署，沿用协议 v1 和现有 storage 实现。部署入口为 plugins/emu-media 链接，原部署保留为 plugin-releases/emu-media/0.1.0-fbd7ec7。

当前历史 key 与 emu-chat 有效 API key 一致。独立任务在暂停两服务后建立 SQLite 快照和图片文件备份，完成切换、重启和真实历史补偿检查。主机保持 Hermes 自己的 Node，emu-chat 继续使用系统 Node 24。

代价是两个服务短暂中断；历史凭据仍具有正常 API 权限。独立外部 CLI 写入不被两服务暂停覆盖，恢复前需另行停止。storage 代码指纹变化时，工具保守拒绝部署，须重新评估 schema 兼容。回退代码不自动覆盖数据库或恢复原错误密钥。

## Verification

- 隔离资源与 Hook 验证通过，包含分块 JSON 与分块历史响应，没有发起付费模型调用。
- 独立任务 emu-media-deploy-20260930T152859494788 日志确认 Activated emu-media 0.2.0。
- 无密钥能力访问被拒绝；认证返回协议 v1；配置的历史 key 读取真实历史成功；插件 reconcile 请求成功。
- 部署前已有 4 张 ready 图片与各自 SHA256 保留；图片原件哈希、插件库和控制库完整性检查通过，原控制记录保留。
- Hermes 与 emu-chat 服务均 active，应用版本保持 v1.0.2。
- 协调备份位于 /home/emu/.hermes/plugin-backups/emu-media/20260930T152900169495Z。

当前流程见 [图片维护说明](../../../../docs/11-image-workflows.md)及插件仓库的 [DEPLOYMENT.md](../../../../../hermes-emu-media/DEPLOYMENT.md)。
