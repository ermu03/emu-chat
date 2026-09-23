# Agent Note: 按实际磁盘占用决定 SQLite 空间回收

Status: proposed

## Problem

原 TASK-9：[队列仓储](../../../../src/server/db/repositories/queue.repository.ts) 在部分终态清除 `payload_text`，用于减少保留的敏感正文。长期写入和删除后，SQLite 文件可能保留可复用空间而不缩小；目前没有项目运行数据证明需要自动整理。

## Proposal

先用真实负载观察数据库文件体积、`freelist_count` 和写入量。若回收收益明确，再选择合适时机启用 `auto_vacuum=INCREMENTAL` 并执行有上限的 `incremental_vacuum(N)`，或采用一次性的维护命令。新库要在建表前设置模式；已有表的数据库若从 `NONE` 切换，需要 `VACUUM` 重建，不能只在每次连接时设置 PRAGMA 就认为已经生效。具体行为见 [SQLite PRAGMA 文档](https://www.sqlite.org/pragma.html#pragma_auto_vacuum)。

## Alternatives considered

- **保持默认空间复用**：没有额外启动或运行时开销；文件不一定会归还空闲页给操作系统。
- **需要时手动 `VACUUM`**：不必长期运行维护任务；完整重建可能需要额外时间和磁盘空间。
- **增量回收**：可分批处理空闲页；需要提前配置模式并确认对写入性能的影响。

## Acceptance criteria

若实际需要实施：对新库与已有库分别验证模式设置；确认长期工作负载下文件体积可控，且不会明显影响消息主链路或数据库可用性。

## Risks

`incremental_vacuum` 只处理空闲页，不能保证消除所有文件内部碎片；过早加入定时整理可能增加维护复杂度却没有可见收益。
