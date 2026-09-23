# Agent Note: 跳过暂停会话的队列头

Status: implemented

## Problem

[findNextGlobalQueued](../../../../src/server/db/repositories/queue.repository.ts) 原先只按创建时间选全局最早的 `queued` 项。[协调器 tick](../../../../src/server/coordinator/admission-coordinator.ts) 发现该项所属会话已暂停或待删除时直接返回；后面其他可运行会话的队列项因而可能一直无法派发。[发送接口](../../../../src/server/services/queue-run-service.ts) 允许在暂停会话中继续入队，所以这一状态可达。该问题独立于是否增加并行 Run。

## Decision

全局候选查询连接会话表，只在 `queue_paused = 0` 且 `delete_state = 'none'` 的会话中按原有顺序取最早的 `queued` 项。协调器选中候选项后以及取得租约准备派发时，继续复核会话状态。暂停项保持 `queued`，恢复该会话后重新参与调度。

## Alternatives considered

- **协调器逐条跳过不可运行项**：可保留现有查询；需要多次查询或维护游标，容易再次选中同一队列头。

## Consequences

较早的暂停项不再阻塞其他会话；每会话 FIFO 保持不变。全局顺序现在只在可派发会话之间成立；暂停会话恢复后，其较早的排队项可能先于其他会话中新入队的任务执行。候选查询需要读取会话状态，派发前仍需复核，以应对筛选后状态发生变化。

## Verification

[队列与 Run 集成测试](../../../../tests/integration/phase4-queue-runs.test.ts) 覆盖较早的暂停项、其他会话完成派发、暂停项保持排队以及恢复后继续运行。
