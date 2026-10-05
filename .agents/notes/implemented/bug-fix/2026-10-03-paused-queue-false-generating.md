# Agent Note: 保证停止后队列暂停与恢复一致性

Status: implemented

## Problem

本篇保留 2026-10-03 的生产诊断，并纳入 2026-10-05 开发目录审查发现的停止与完成竞态。修复共同处理用户停止意图、队列暂停状态和前端恢复交互。

2026-10-03，生产环境会话「聊天」「聊天02」使用的 `gemini-3.8-flash-high` 模型额度耗尽。Hermes 日志出现 `429 / RESOURCE_EXHAUSTED` 和 `503 / All accounts limited`，并进入 600 秒的重试等待。用户停止任务后，Hermes 已取消 Run，emu-chat 也已完成对账，但助手区域仍持续转圈，用户难以判断是否仍在执行、如何恢复剩余消息。

2026-10-03 只读诊断确认的生产状态：

| 会话 | 本地 Run | Hermes Run | 终态时间（UTC） | 会话队列 | 剩余消息 |
| --- | --- | --- | --- | --- | --- |
| 聊天 | `lr_547180fc-7775-48df-a78c-d19ba91ab0d0` | `run_ce8940a11abf480f8cd8d48bcbbdfa11` | 2026-10-03 02:55:26 | `queue_paused = 1`，`run_cancelled` | 1 条 `paused`，1 条 `queued` |
| 聊天02 | `lr_d4ebae39-2e05-4646-abdb-967e38487f3d` | `run_763e4456ce134127981301d789eb136c` | 2026-10-03 02:54:57 | `queue_paused = 1`，`run_cancelled` | 1 条 `paused`，1 条 `queued` |

两个 Run 均为 `local_state = reconciled`、`upstream_status = cancelled`，对应 Hermes 会话没有遗留执行租约；核查时生产数据库没有 `submitting`、`accepted` 或 `reconciling` 的本地 Run。服务进程正常运行。这里的长期转圈有两个阶段：停止前确实在等待上游重试；停止后的持续转圈来自前端状态判定，不能将二者合并归因于 Hermes 未结束任务。

生产部署为 `/home/emu/.emu-chat/releases/v1.0.2`，构建提交 `c27c10e81c33e66c03f7a4f99ca2085ea96165a3`；生产控制数据库为 `/home/emu/.emu-chat/data/emu-chat.sqlite`。开发目录为 `/home/emu/projects/emu-chat`。

已确认的原因与关联问题：

- [queue-state.ts](../../../../src/client/features/queue/queue-state.ts) 的 `isAgentGenerating` 将「有活动 Run」或「存在主队列项」都视为正在生成。`getPrimaryQueueItem` 把 `queued` 纳入主项选择，未考虑 `queue.paused`。直接调用已部署版本的实际函数，输入已取消 Run、暂停队列和一条 `queued` 消息时，得到 `isLiveRun = false`、`isAgentGenerating = true`；移除 Run 后仍返回 `true`。
- [message-view.tsx](../../../../src/client/features/messages/message-view.tsx) 在生成判定为真时显示助手实时占位行；占位行没有内容时显示转圈。因此刷新页面后从数据库重新加载相同状态，仍可产生错误的等待提示。
- `getQueuedFollowUps` 排除被选作主项的消息。暂停且没有活动 Run 时，唯一的 `queued` 消息被排除；[app.tsx](../../../../src/client/app.tsx) 按后续消息数量显示队列面板，用户因而难以看到实际等待恢复的消息。
- 修复前的恢复面板只覆盖 `manual_resume_required` 且有 `ADMISSION_UNCONFIRMED` 的场景。`run_cancelled` 等常规暂停原因缺少对应的恢复提示与入口。
- [use-run-runtime.ts](../../../../src/client/state/use-run-runtime.ts) 的终态刷新事件列表未包含协调器实际发出的 `run.paused`。轮询可补偿，但暂停后的及时刷新也应纳入本次状态一致性检查；本次未证明这一事件遗漏是持续转圈的必要条件。

2026-10-05 在内存 SQLite 和模拟上游中补充确认：[AdmissionCoordinator](../../../../src/server/coordinator/admission-coordinator.ts) 的 `stopRun` 先持久化 `queue_paused = 1`、`pause_reason = user_stopped`，随后请求上游停止；若停止与正常完成发生竞态，`reconcileOnce` 的非 partial 完成分支无条件解除暂停。复现中停止后暂停原因为 `user_stopped`，对账为 `completed` 后暂停变为 0，后一条 `queued` 消息重新成为可派发候选。这是开发目录的隔离复现，与上述生产 Run 已取消的现场事实分开记录。

后端在普通取消后暂停队列、保留恢复正文，并跳过暂停会话的待派发消息，符合已有决定：[跳过暂停会话的队列头](../../implemented/bug-fix/2026-09-23-skip-paused-queue-head.md)、[集中 Run 生命周期的事务、恢复与对账责任](../../implemented/architecture/2026-09-26-centralize-run-lifecycle-and-recovery.md)。本提案补足完成竞态时的用户暂停保护，并修正前端解释和恢复交互，保留这些约束及[实时到历史交接](../../implemented/feature/2026-09-24-progressive-tool-events-and-stable-run-handoff.md)的已有内容保护。

## Decision

将 Run 的实际完成结果与用户要求暂停后续队列的意图区分处理，同时区分执行、待派发、暂停和终态对账。实现保留既有全局单 Run、租约、视图代数、草稿 CAS 和实时到历史的交接约束。

1. [协调器](../../../../src/server/coordinator/admission-coordinator.ts)继续先提交 `user_stopped` 再请求停止，各对账分支均保留这一原因。成功分支只清除本次历史读取失败造成的 `reconciliation_failed` 自动暂停；停止响应不明、历史失败后人工重试及重启均不清除用户意图。上游真正完成时，Run 仍为真实 `completed`、队列项为 `done`，后续项保持暂停。
2. [队列判定](../../../../src/client/features/queue/queue-state.ts)优先匹配活动 Run 和执行中的队列项；暂停时不选待发 `queued` 项作主项。生成判定不包括单纯等待派发；加入队列、待派发、停止和审批等待使用文字反馈。执行和终态核对仍按真实 Run 展示，不因暂停标记隐藏已有内容。没有活动 Run 或待完成的历史交接时，暂停待发项不触发执行轮询。
3. 暂停时没有执行主项，全部 `queued` 项进入等待面板，恢复后遵守 FIFO。暂停中的新发送也作为等待项，保留现有 RunDisplay；未暂停时的第一条待发消息仍可显示用户占位及待派发反馈。会话缓存与切换使用相同主项判定。
4. [QueueRecoveryPanel](../../../../src/client/features/queue/queue-recovery-panel.tsx)覆盖全部已有暂停原因，显示实际待发数量及恢复入口，活动 Run 未结束时禁用恢复。恢复后续队列不重放原中断项；最新恢复项可以通过既有复制接口放回空草稿，由用户再次发送。`DraftComposer.restoreRecovery` 检查未保存输入、附件和上传，等待旧保存完成后使用最新 revision，服务端仍拒绝非空覆盖；迟到复制响应不能改变另一会话输入。界面提醒部分效果和重复执行风险；待核对项及准入、对账不明的原因要求先检查历史并勾选确认。
5. `run.paused` 与 `run.reconciled` 均刷新队列、Run 和终态历史；停止接口失败也刷新已提交暂停。沿用单飞、队列版本、Run 终态和视图代数保护。空核对行不显示生成转圈，历史确认后结束；已有流式正文和工具结果在读取失败时保留，并可轮询或手动重试，成功后以稳定行节点交接权威历史。
6. 核查 2026-10-05 本机 Hermes `agent/status_output.py`、`gateway/platforms/api_server.py` 和 `api_server_runs.py`：等待通知 `_emit_wait_notice` 调用 `thinking_callback`，`/v1/runs` 的 Agent 创建未绑定该回调，工具进度桥也明确丢弃 `_thinking`。公开 Run SSE 当前没有可用等待通知，故不推测重试倒计时；这一跨仓库契约缺口记录在[Hermes 文档](../../../../docs/05-hermes-integration.md)。未连接生产 Run 触发真实额度错误，未改变上游 600 秒退避或模型选择。

不新增 Queue 或 Run 状态，不改写已有迁移，不清理生产会话、草稿、队列或恢复正文，不在重启时自动解除暂停。

## Alternatives considered

- **重启 emu-chat 或 Hermes，随后刷新页面**：对进程内卡死、连接中断和浏览器残留临时展示，重建运行状态可能有效。但本次两项任务已结束，暂停标记和 `queued` 消息持久化在 SQLite 中。emu-chat 启动恢复与协调器仍尊重暂停状态，原前端判定会再次返回正在生成；重启无法解决本次已确认的原因，还会中断其他连接。
- **直接恢复这两个生产会话的队列**：现有恢复接口能解除暂停并派发剩余消息，是用户希望继续任务时可选的临时处理。但会触发实际模型请求和工具执行，且不会重放原中断项；不能为了消除视觉转圈就自动执行。它也不能修复下次暂停时的展示问题。
- **取消剩余排队消息，或直接清理数据库状态**：移除 `queued` 消息可使当前错误判定不再成立，操作范围较小。但会改变用户待执行内容，仅能在用户明确选择取消时通过正常接口处理。直接清库会丢失部署数据及恢复信息，不采用。
- **仅在消息组件中屏蔽暂停时的转圈**：改动较少，能遮住当前症状。但发送、主项选择、后续队列展示和运行轮询仍使用错误判定，恢复入口依旧缺失；应统一修正状态解释及相关调用方。

## Consequences

用户停止后，真实成功也不会启动下一条任务；取消后的持久化暂停不会产生假转圈或隐藏唯一待发消息。恢复入口能明确区分继续后续队列与重新发送原中断项，不新增状态、迁移或自动恢复行为。

代价是用户必须明确恢复才能继续后续消息，复制中断项不能覆盖现有输入；原项只提供保留期内的最新恢复正文入口。复制后再次发送可能重复工具的部分效果，权威历史暂不可读时已显示内容继续等待核对。供应商重试等待仍缺少公开事件契约，需后续跨仓库扩展。开发目录的提交不等于生产发布，本次未修改部署数据库和生产队列。

## Verification

- [Run 并发测试](../../../../tests/unit/run-lifecycle.test.ts)覆盖停止与完成/取消竞态、停止响应丢失、历史读取失败后重试、重复终态和协调器重启，确认用户暂停及后续 FIFO 保持。
- [核心队列集成](../../../../tests/integration/phase4-queue-runs.test.ts)通过 HTTP 停止、确认取消、重建服务、复制与草稿冲突、恢复和后续派发，确认原项不重放；既有成功主链路、其他会话调度和正文到期用例继续验证原约束。
- [跨模块视图测试](../../../../tests/components/app-shell-flow.test.tsx)覆盖单条暂停待发项、停止响应失败后的视图刷新、`run.paused`、空/有内容的终态历史失败与恢复、暂停中新发送、未保存草稿保护，以及复制响应跨会话隔离。既有工具进度和重复终态用例继续保护稳定交接。
- [草稿交互测试](../../../../tests/components/react-components.test.tsx)确认恢复复制等待在途旧保存及清空草稿的确认，再使用最新 revision。完整套件 18 个文件、99 个用例通过；最后补齐单飞保护后，恢复相关 6 个定向用例通过。类型、lint、格式与生产构建检查通过。
