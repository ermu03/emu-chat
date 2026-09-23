# Agent Note: 跳过暂停会话的队列头

Status: proposed

## Problem

[findNextGlobalQueued](../../../../src/server/db/repositories/queue.repository.ts) 只按创建时间选全局最早的 `queued` 项。[协调器 tick](../../../../src/server/coordinator/admission-coordinator.ts) 发现该项所属会话已暂停或待删除时直接返回；后面其他可运行会话的队列项因而可能一直无法派发。[发送接口](../../../../src/server/services/queue-run-service.ts) 允许在暂停会话中继续入队，所以这一状态可达。该问题独立于是否增加并行 Run。

## Proposal

选取全局候选项时，只在未暂停、未删除的会话中按现有顺序取最早的 `queued` 项；派发前继续复核会话状态。暂停项保留原位置，恢复该会话后再参与调度。

## Alternatives considered

- **协调器逐条跳过不可运行项**：可保留现有查询；需要多次查询或维护游标，容易再次选中同一队列头。
- **在仓储查询中筛选可运行会话**：一次查询即可得到最早的合格候选项，沿用现有排序；需要用会话表判断暂停和删除状态。

## Acceptance criteria

先入队的暂停会话与后入队的正常会话同时存在时，正常会话可以派发，暂停项保持排队；恢复暂停会话后可继续处理，且每会话 FIFO 不变。

## Risks

筛选条件必须与派发前的状态复核一致；并发状态变化仍要由派发时的校验兜底。
