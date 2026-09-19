# Phase 4 改动记录：队列系统、准入协调器与 SSE 流式管道

## 1. 阶段概述与目标
实现消息异步排队机制（单会话最大 10 条上限）、客户端幂等入队去重、基于 `coordinator_leases` 的单会话单任务准入租约调度引擎、SSE 广播中心与客户端审批挂起组件。

## 2. 真实落地与修改的文件清单
- `src/server/sse/sse-hub.ts`: 会话 SSE 广播与 500 条环形缓冲事件重放中心。
- `src/server/coordinator/admission-coordinator.ts`: 会话调度器（处理 FIFO 入队、10 条深度拦截、租约获取/心跳保活、与 Hermes 交互调度）。
- `src/server/hermes/adapter.ts`: 扩展 `startRun`, `cancelRun`, `submitApproval`, `streamEvents` 契约方法。
- `src/server/http/routes/queue-and-runs.ts`: 暴露排队、状态查询、取消、审批与 SSE 流端点。
- `src/server/app.ts`: 依赖装配与路由挂载。
- `src/client/features/queue/queue-drawer.tsx`: 队列查看与取消排队抽屉。
- `src/client/features/approval/approval-dialog.tsx`: 工具审批弹窗。
- `tests/unit/phase4-queue-coordinator.test.ts`: 深度限制与环形缓冲单元测试。
- `tests/integration/phase4-queue-runs.test.ts`: 队列与调度路由集成测试。

## 3. 契约与硬性约束对照
- 零消息副本落盘：所有持久化仅包含排队瞬态状态与 Run 状态，不保存 Transcript。
- 10 条深度上限：测试用例直接覆盖第 11 条入队触发 `QueueFullError`。
- 幂等性去重：基于 `client_request_id` 自动去重。
