# Agent Note: 集中 Run 生命周期的事务、恢复与对账责任

Status: implemented

## Problem

原协调器先将 QueueItem 改为 `dispatching`，再单独插入 Run。插入失败会留下无法恢复的活跃队列项。提交结果未知且 Run 没有 `hermes_run_id` 时，重启后的调度直接返回，长期占住全局槽位。定时轮询、SSE 结束、审批和手动对账也可能并发获取上游状态；旧响应没有写入保护，可将已完成 Run 的缓存状态改回 `running`。停止与审批路径的 Run 状态写入原先分散在队列服务中。

## Decision

[AdmissionCoordinator](../../../../src/server/coordinator/admission-coordinator.ts)集中持有派发后的 Run 生命周期写入；QueueRunService 保留入队、队列管理和 HTTP 入口，停止、审批及对账委托协调器。派发时在 SQLite 即时事务中共同提交 QueueItem `dispatching` 与 Run `submitting`；接纳、明确拒绝、提交结果不明的人工核对，以及终态对账也各自在一个即时事务中更新 Run、QueueItem 和必要的会话暂停状态。网络调用在事务外，状态提交后才通知 SSE。活跃 Run 的异步回调在写入前核对租约令牌和当前状态，独立心跳在网络等待期间续约。

当 `startRun` 超时、断线或响应不完整而无法确认接纳时，持久化原 `dispatch_session_id`、正文和幂等键；协调器重启后用完全相同的请求重放。最多尝试 **4 次**，失败后依次等待 5、10、20 秒，且不超过首次派发起 24 小时的幂等窗口。Hermes 本地源码的 `POST /v1/runs` 幂等存储以键和请求体识别重放，返回原 `run_id`，重放可跨适配器重启；Hermes 仓库的 `tests/gateway/test_api_server_runs.py` 覆盖相同请求复用原 Run 和重放越过并发限制。实现仍依赖实际部署的 Hermes 满足该契约。

第四次仍不明或窗口到期时，Run 与 QueueItem 进入现有 `review_required`，写入 `ADMISSION_UNCONFIRMED`，会话以 `manual_resume_required` 暂停，释放全局槽位。此时没有上游 Run ID，单 Run 对账接口无法判断是否执行；[界面](../../../../src/client/features/queue/queue-recovery-panel.tsx)要求用户先查看 Hermes 历史，再确认恢复后续队列。旧项不会自动重新入队，原文按现有 7 天恢复期限保留，用户可自行复制到草稿。已有上游 Run ID 的 `review_required` 仍走手动对账。

所有对账入口按本地 Run ID 合并进程内请求，事务提交时再次核对状态、`partial` 与活跃租约。旧的非终态响应不能覆盖已记录终态；重复终态不再次推进 QueueItem 或会话状态。SSE 状态、停止和审批写入也复核当前状态。这延续[全局单活跃 Run 的决定](./2026-09-23-evaluate-multiple-active-runs.md)，不增加新的持久化事件系统。

停止后的会话暂停独立于 Run 的真实终态；成功、失败和历史重试均保留已提交的 `user_stopped`，等待用户恢复。完整行为和前端入口见[停止暂停与恢复决定](../bug-fix/2026-10-03-paused-queue-false-generating.md)。

已接纳 Run 的事件连接、有限退避续订和取消也由同一协调器持有，每次事件及重连回调复核捕获的租约。当前 Hermes 无事件游标和重放，断线可能删除队列；无法续订时保留缺口及状态轮询。协议依据与资源收尾见[上游 SSE 恢复决定](../bug-fix/2026-10-05-recover-upstream-run-streams.md)。

## Alternatives considered

- **仅在已发现的调用点分别补事务和终态判断**：改动较小，但 `submitting` 无 ID 的恢复仍需统一责任边界，后续调用方容易遗漏 Queue、Run 与会话暂停的联动。
- **立即抽出独立生命周期模块并迁移所有写入**：接口可更独立，但目前唯一复用点是协调器与队列服务的委托。直接收拢到现有协调器能用真实恢复流程验证边界，暂不增加抽象层。
- **结果不明时直接拒绝或自动换键重发**：可更快释放槽位，但 Hermes 可能已执行原请求，换键会制造第二次执行。有限原键重放后由用户核对，保留可恢复正文。

## Consequences

本地状态迁移失败会整体回滚；重启后的无 ID Run 可继续找回原上游执行，超过自动确认能力时其他会话仍可使用全局槽位。代价是结果不明期间同一活跃项会阻塞其他派发，最长为四次尝试及相应退避；最终人工核对依赖用户查看 Hermes 历史。现有 `review_required` 的两种来源需要按是否有上游 Run ID 区分。协调器代码随职责集中变长，若后续出现第二个真正复用方，再考虑抽出小型生命周期模块。

## Verification

[集成测试](../../../../tests/integration/phase4-queue-runs.test.ts)覆盖 Run 插入故障回滚、丢失准入响应后重建服务找回原 Run、四次不明结果释放全局槽位及恢复正文期限。[状态一致性测试](../../../../tests/unit/run-lifecycle.test.ts)覆盖响应未返回时重建协调器和旧回调隔离，以及旧 `running` 对账响应不能回退已完成 Run。`npm test` 共 14 个测试文件、72 个用例通过；`npm run typecheck`、`npm run lint`、`npm run format:check`、`npm run build` 通过。上述测试使用 Node.js 26、内存 SQLite 与可控上游，没有杀死独立进程；本机 Hermes 仓库的 pytest 依赖未安装，源代码与已有测试已核对，未连接真实 Hermes 服务。
