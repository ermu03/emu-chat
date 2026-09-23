# Agent Note: 清理过期恢复载荷与终态控制记录

Status: implemented

## Problem

成功完成或取消的队列项原本会清空 `payload_text`，但失败后的 `paused`、`review_required`、`rejected` 项可保留恢复载荷。[协调器](../../../../src/server/coordinator/admission-coordinator.ts) 写入 `recovery_expires_at`，而[队列服务](../../../../src/server/services/queue-run-service.ts) 原本只检查 `payload_expired_at`；后者没有自动设置路径，也没有后台清除过期载荷。因此七天恢复期没有真正限制恢复正文的可用性或磁盘保留时间。

[限制常量](../../../../src/shared/limits.ts) 还定义了终态控制记录的保留期限，但原本没有定期删除终态 `queue_items` 与关联 `runs` 的流程。长期数据库增长可能首先来自这些仍存活的记录，空闲页回收无法解决。

## Decision

[队列服务](../../../../src/server/services/queue-run-service.ts) 直接用 `recovery_expires_at` 限制正文返回和复制，故期限到达时不依赖后台任务也会立即拒绝恢复。[DataRetentionService](../../../../src/server/services/data-retention-service.ts) 在启动时及随后每分钟执行一次即时事务，每轮最多清除 100 条到期恢复正文和 100 条过期控制记录；清除时把原恢复截止时间记入 `payload_expired_at`。重启后重新执行，因此未处理完的批次会继续推进。

`done`、`cancelled` 队列项从最后更新时间起保留 7 天，覆盖 Hermes 至少 24 小时的幂等窗口；已过期或主动丢弃正文的 `paused`、`rejected` 项从最后更新时间起保留 30 天。删除前确认关联 Run 不在活跃或待人工处理状态，删除队列项时由外键级联删除终态 Run。`review_required` 仍待人工对账，不纳入自动删除。

## Alternatives considered

- **继续只在用户手动丢弃时清理**：实现简单，但到期时间不再代表数据实际保留期限，用户也未必会逐项处理。
- **到期后只在 API 中隐藏载荷**：能阻止复制，但正文仍占磁盘并留在数据库文件中。

## Consequences

过期恢复正文无法通过 API 读取或复制，并会在后台批次中从队列项的 `payload_text` 列清空。终态记录与关联 Run 不再无限增长；期限内的 `client_request_id` 重放与活跃 Run 恢复仍可用。代价是期限后相同 `client_request_id` 不再保证重放，未决的 `review_required` 记录仍会保留，以及每分钟有一次小批量 SQLite 写事务。删除释放的页可供复用，但数据库文件未必立即缩小；实际空间回收仍按[磁盘占用决策](../architecture/2026-09-23-reclaim-sqlite-free-pages.md)判断。

## Verification

[恢复 API 与重启集成测试](../../../../tests/integration/phase4-queue-runs.test.ts) 验证期限前可复制、期限后立即拒绝以及重启后清除正文；[保留策略测试](../../../../tests/unit/data-retention.test.ts) 验证过期窗口、外键级联和活跃 Run 保护。
