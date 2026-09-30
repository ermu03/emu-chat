# Agent Note: 通过独立 Hermes 插件接入图片识别、生成与编辑

Status: implemented

## Problem

emu-chat 原先只把纯文字放入草稿、队列和 Hermes Run。图片工具输出可能只是短期 URL 或宿主文件路径，不能安全地作为可刷新、可分支和可下载的会话资源。用户希望在现有聊天中上传图片、让 Hermes 识图或编辑、查看生成结果并继续引用，不想增加另一套模型工作台。

现有 Hermes 由官方 Git 安装目录运行，emu-chat 从独立版本目录部署。扩展必须保持独立，不能在 Hermes 核心源码中打补丁。当前部署数据需要增量迁移保护；开发目录测试数据可丢弃。P0 基线与证据见[兼容性验证](../../../research/2026-09-29-image-workflows-p0.md)，详细边界见[实施规格](../../../specs/2026-09-28-image-workflows.md)。

## Decision

独立插件仓库 `hermes-emu-media` 使用 Hermes 公开的 `register_platform_handler` 和 Hook 接口。插件持有不可变图片原件、资源范围、引用、提交身份、采集任务和删除墓碑；emu-chat 通过私有 Bearer 凭据代理同源上传和读取。浏览器只持有会话内资源 ID，不接触 Hermes 文件路径、供应商临时 URL 或服务密钥。Hermes 仍持有权威聊天历史，图片字节不进入 emu-chat 的消息数据库。

一条消息最多附 4 张静态 PNG/JPEG/WebP，每张上传最多 8 MiB。草稿、队列编辑和发送共用有序附件引用及 revision。仅附图时加入明确的固定识图要求。派发仍使用 `/v1/runs`，先确认引用和绑定，再冻结带规范机器清单的 Run 输入；重试保持同一 operation 和幂等键。历史清单只有在后台验证 scope、session、摘要、图片顺序和绑定后才剥离；工具输出按真实 `tool_call_id` 关联，不按时间或文字猜测。

图片识别和生成沿用 Hermes 的 `vision_analyze` 与 `image_generate`。用户选择只开放已验证读取本地文件的编辑适配：当前 `local` terminal backend 下，OpenAI、OpenRouter、xAI 可用；FAL 编辑本地图片不支持，FAL 纯文字生图仍可用。插件不在 Hook 参数中塞入 data URI，不复制供应商 SDK。能力接口区分配置与实时可用性，插件故障不阻断纯文字聊天。

输出 Hook 先记录来源，再由插件 worker 保存；漏 Hook 由经鉴权的公开历史补偿。重试保存只重做采集，不再调用模型。资源有草稿、队列、历史、分支等独立引用；分支只授予确实复制的消息所用图片，映射完成前阻止删除来源。会话删除持久化插件 scope 删除任务；最后一份引用移除后延迟物理清理。上传孤儿释放需要 emu-chat 本地非使用确认和插件端再次检查。

前端在现有输入区完成选择、粘贴、拖放、缩略图、查看、下载和“用于下一条消息”。图片状态区分上传中、待保存、已就绪、保存失败和不可用；带不可用附件的草稿不能当作纯文字静默发送。查看器通过页面根节点呈现，支持窄屏、Esc 和焦点返回。

## Alternatives considered

- **修改 Hermes 核心 API 和图片工具。** 能直接获取内部状态，开发路径较短；但每次官方升级都要重新合并，违反用户选择的独立插件边界。
- **emu-chat 直接调用图片模型服务。** 可自行控制编辑参数；但会形成第二套供应商配置、付费任务与历史归属，不能复用既有 Run 恢复机制。
- **浏览器直接加载工具 URL 或服务器路径。** 临时展示简单；但链接可能过期，还会泄露宿主位置或供应商凭据。
- **把本地文件转为 Hook data URI 交给 FAL。** 可能让 FAL 编辑成功；P0 发现转换后的图片内容会出现在工具生命周期参数中，不能证明不会进入长期历史或普通日志，因此只采用已验证的本地文件适配。

## Consequences

图片与文字沿用同一聊天、草稿、队列及 Run，刷新和服务重启后可通过稳定资源读取。资源权限与生命周期跨 emu-chat 和插件两个 SQLite 数据库，必须靠持久 outbox、幂等接口、墓碑和历史对账恢复；无法用单个事务保证两边同时提交。模型是否调用图片工具和真实供应商可用性仍由 Hermes 及其配置决定，不能靠 UI 承诺。原文件保留元数据，不提供 EXIF 净化或公开分享。

初始开发验收在隔离环境进行，未执行付费供应商图片调用。2026-09-30 正式部署组合更新为 Hermes `6005aa1`、插件 0.2.0 和 emu-chat `v1.0.2`；当前发版与凭据约定见[维护说明](../../../../docs/11-image-workflows.md)，插件部署改进见[发版决策](../process/2026-09-30-deploy-media-plugin-and-verify-history.md)。浏览器验收范围为 Chromium 桌面和窄屏仿真，真实手机、Safari/Firefox 与官方 Hermes 后续版本仍需复测。

## Verification

- Hermes `6005aa1` 隔离 profile 的真实 `/v1/runs`、公开 Hook 和插件路由验证见 P0 记录。
- 插件 `tests/resource_flow.py` 覆盖私有鉴权、上传重试、重启读取、引用与删除、输入桥接、输出采集、漏 Hook 补偿、分支授权和孤儿释放。
- emu-chat 的 `tests/integration/media-run-flow.test.ts` 覆盖上传、附件 CAS、单次 Run 准入及历史交接；`tests/unit/media-branch-recovery.test.ts` 覆盖失败重试和来源保护。完整类型、Lint、构建与测试通过。
- 隔离 Fastify、Vite、假 Hermes 和插件响应的 Chromium 冒烟检查覆盖桌面及 390 像素窄屏的上传、查看器、Esc 和焦点返回。
