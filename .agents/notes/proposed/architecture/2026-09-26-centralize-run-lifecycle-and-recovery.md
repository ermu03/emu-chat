# Agent Note: 集中 Run 生命周期的事务、恢复与对账责任

Status: proposed

## Problem

2026-09-26 对提交 `0b325d6` 的架构评估发现，Queue、Run 和会话暂停状态需要共同推进，但状态更新分散在[协调器](../../../../src/server/coordinator/admission-coordinator.ts)与[队列服务](../../../../src/server/services/queue-run-service.ts)中。`sendMessage` 已有草稿原子入队事务；协调器的 `dispatch` 却先将队列改为 `dispatching`，再单独插入 `submitting` Run，接纳与终态处理也分别更新多张表。当前 `tick` 发现活跃队列项后，只恢复已取得 `hermes_run_id` 的 Run，随后直接返回。

同一个 Run 的对账可由定时轮询、SSE 消费结束、审批及手动对账触发。`tickInFlight` 只保护定时调度入口，`reconcileById` 在网络返回后直接更新状态；[RunRepository.update](../../../../src/server/db/repositories/run.repository.ts)没有版本或终态条件，无法阻止较旧响应覆盖已提交的终态。两个问题共享生命周期的写入边界，因此合并为一篇提案。

评估时使用真实仓储和协调器、内存 SQLite 及可控的上游适配器替身，得到以下结果：

| 复现条件 | 当前结果 |
| --- | --- |
| 队列更新后，让 `RunRepository.insert` 抛错；恢复方法并重建协调器，连续执行三次 `tick` | 首项保持 `dispatching`，没有对应 Run；下一项保持 `queued`，未发生上游提交 |
| 让 `startRun` 响应保持待定；停止旧协调器并重建，随后返回接纳响应，再执行三次 `tick` | 首项保持 `dispatching`，Run 保持 `submitting` 且无上游 ID；下一项无法派发 |
| 并发调用 `reconcileRun` 与 `tick`，先返回较新的 `completed` 并完成对账，再返回较旧的 `running` | 队列为 `done`、本地 Run 为 `reconciled`，但 `upstream_status` 被写回 `running` |

这些是进程内故障注入和协调器重建实验，没有杀死操作系统进程或连接真实 Hermes。评估时的相关基线为四个测试文件、16 个用例通过；其中[重启集成用例](../../../../tests/integration/phase4-queue-runs.test.ts)覆盖已接纳 Run，未覆盖上述提交结果未知和响应乱序场景。实验环境为 Node.js 26.9.0，项目要求的 Node.js 22 环境与真实上游恢复行为仍需在实施时验证。

## Proposal

优先级：高。先在现有模块内集中生命周期操作，再根据真实调用方决定是否抽出独立模块。目标是让调用方通过业务操作推进状态，无需分别掌握 Queue、Run、会话暂停标记的更新顺序。

1. 为开始派发、确认接纳、拒绝提交及终态提交建立明确的本地事务边界，复用 [withImmediateTransaction](../../../../src/server/db/transaction.ts)。相关表的修改共同成功或回滚；网络调用放在事务外，SSE 通知在提交后发送。写入时复核当前状态和适用的租约令牌，避免失去执行资格的旧回调继续提交。
2. 补齐 `submitting` 且没有上游 ID 的恢复路径。在确认 Hermes 幂等重放契约后，候选方案是在有效窗口内复用原 `dispatch_session_id`、正文及 `idempotency_key` 查询或重放提交，以找回同一次 Run。超过窗口或仍无法确认时进入明确的人工处理状态，保留恢复信息；不能生成新幂等键自动重发，也不能无限占住全局派发槽位。具体状态及操作入口需要在实施前明确。
3. 让所有对账触发源经过同一个按 Run 合并进行中请求的入口，并在状态提交处保证终态不会被旧响应回退。SSE 状态更新、停止和审批路径也必须遵守同一写入规则；不能只串行化 `tick`。已允许的 `review_required` 手动重试仍可继续推进。
4. 先完成事务与恢复，再收拢对账和其余状态写入。只有多个调用方确实需要复用时才抽出小型生命周期模块，不预设通用状态机框架或逐表重写仓储。

这延续[全局单活跃 Run 的决定](../../implemented/architecture/2026-09-23-evaluate-multiple-active-runs.md)，以及[队列服务负责入队、协调器负责派发和对账的分工](../../implemented/simplification/2026-09-25-remove-unused-paths-and-build-artifacts.md)。Hermes 仍保存权威历史，SSE 事件正文仍不落本地数据库；[数据保留约定](../../implemented/bug-fix/2026-09-23-expire-recovery-and-terminal-control.md)继续适用。实施时同步更新[状态机](../../../../docs/03-state-machines.md)、[服务端内部实现](../../../../docs/04-server-internals.md)和[数据流](../../../../docs/07-data-flow.md)，若调整人工恢复接口，还需更新共享 Schema 与 API 文档。

## Alternatives considered

- **仅在已发现的调用点分别补事务和终态判断**：改动最小，适合快速修补单个故障；但提交结果未知仍需要完整恢复策略，多个调用方也仍各自维护迁移顺序，后续容易遗漏。可以作为实施中的第一步，不作为最终职责边界。
- **立即抽出独立生命周期模块并迁移所有写入**：能一次性建立服务与协调器共用的入口，边界更集中；但实际接口尚未由恢复路径验证，迁移面会同时覆盖审批、停止和清理。先在现有模块集中规则，再决定抽取范围，可以降低一次改动的风险。

## Acceptance criteria

- Run 插入或同一次本地状态迁移中的后续写入失败时，前面的写入一并回滚，不留下无对应 Run 的 `dispatching` 项；后续调度仍能继续。
- 提交响应返回前重建服务，能在有效幂等窗口内恢复同一次上游执行，不产生第二个 Run；窗口失效时提供明确的人工处理结果，后续可运行会话不被永久阻塞。
- 并发触发对账并故意颠倒响应顺序后，Queue、Run 和会话暂停状态保持一致；已完成 Run 不重新变成 `running`，重复终态不会再次执行完成通知和状态迁移。
- 正常消息派发、审批、停止、终态历史对账以及已有的已接纳 Run 重启恢复继续工作；待人工处理记录与恢复正文符合现行保留策略。
- 按 [AGENTS.md](../../../../AGENTS.md) 在既有主干集成测试和必要的状态一致性测试中验证以上故障，不新增简单 CRUD 或重复矩阵测试。故障注入明确覆盖事务中断、提交结果未知及乱序响应，并核对真实 Hermes 的幂等重放行为。

## Risks

- SQLite 事务不能回滚已经发生的 Hermes 执行。恢复方案取决于真实上游对相同幂等键、会话与正文的行为；能力报告中的保留时间不能替代这项验证。
- 当前 `QueueRunService.reconcile` 要求 `hermes_run_id`，不能直接承接缺少上游 ID 的人工处理。若复用 `review_required`，必须同时明确恢复 API、界面操作和保留期限，避免换一个状态后仍无法处理。
- 按 Run 复用 Promise 只约束当前进程，不能替代数据库的条件写入和租约校验；限制终态回退时也要保留合法的失败核对和手动恢复路径。
- 迁移状态写入会影响全局单槽位释放、暂停原因、恢复正文和 SSE 通知顺序，应按上述两阶段推进，避免同时改变并发策略或引入新的持久化事件系统。
