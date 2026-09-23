# Agent Note: 清理过期恢复载荷与终态控制记录

Status: proposed

## Problem

当前成功完成或取消的队列项会清空 `payload_text`，但失败后的 `paused`、`review_required`、`rejected` 项可保留恢复载荷。[协调器](../../../../src/server/coordinator/admission-coordinator.ts) 写入 `recovery_expires_at`，而[队列服务](../../../../src/server/services/queue-run-service.ts) 的 `payloadAvailable` 只检查 `payload_expired_at`；后者没有自动设置路径，也没有后台清除过期载荷。因此七天恢复期目前没有真正限制恢复正文的可用性或磁盘保留时间。

[限制常量](../../../../src/shared/limits.ts) 还定义了终态控制记录的保留期限，但当前没有定期删除终态 `queue_items` 与关联 `runs` 的流程；[队列仓储的删除方法](../../../../src/server/db/repositories/queue.repository.ts) 没有调用方。长期数据库增长可能首先来自这些仍存活的记录，空闲页回收无法解决。

## Proposal

先明确恢复载荷与终态控制记录的保留契约，再在有界批次中清理到期数据。恢复载荷到期后应不再可复制，并在持久层清空正文、记录过期时间；终态记录应在足够保留幂等重放和故障排查窗口后删除。清理应避免触碰活跃队列与运行，并在进程重启后继续执行。

## Alternatives considered

- **继续只在用户手动丢弃时清理**：实现简单，但到期时间不再代表数据实际保留期限，用户也未必会逐项处理。
- **到期后只在 API 中隐藏载荷**：能阻止复制，但正文仍占磁盘并留在数据库文件中。
- **分批持久化清理**：能兑现保留期限，需明确幂等窗口、事务边界和删除顺序。

## Acceptance criteria

- 过期恢复正文不再能通过 API 获取或复制，并最终从数据库清除；未过期的恢复流程保持可用。
- 终态控制记录按明确的保留窗口清理，且不破坏 `client_request_id` 幂等重放或活跃 Run 的恢复。
- 文档准确描述实际保留行为，并通过必要的状态与恢复测试。

## Risks

过早删除可能让迟到的重试请求重复提交，或让用户失去仍有效的恢复内容。清除正文后 SQLite 文件也未必立即缩小，应分别测量存活数据、空闲页和 WAL。
