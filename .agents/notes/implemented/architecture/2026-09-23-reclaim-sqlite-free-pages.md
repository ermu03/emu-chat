# Agent Note: 按实际磁盘占用决定 SQLite 空间回收

Status: implemented

## Problem

原 TASK-9：[队列仓储](../../../../src/server/db/repositories/queue.repository.ts) 在部分终态清除 `payload_text`，用于减少保留的敏感正文。长期写入和删除后，SQLite 文件可能保留可复用空间而不缩小，需要先看实际占用再决定是否整理。

## Decision

保持当前不显式设置 `auto_vacuum`、不定时执行 `VACUUM` 的方式。2026-09-23 对本地开发库做只读测量：主文件 180,224 字节（44 个 4 KiB 页），同时观察到 0 字节的 WAL 与 32,768 字节的共享内存侧文件；`auto_vacuum=NONE`、`freelist_count=0`，56 条已完成队列项均无保留载荷。即使页内未用空间约 95 KiB，临时 `VACUUM INTO` 副本也只缩小 4,096 字节（2.3%）。当前没有值得回收的空闲页，完整重建也几乎不省磁盘。

若以后出现显著磁盘占用，先区分主文件中的空闲页、WAL 文件和仍存活的控制记录，再选择维护方式。`NONE` 模式下空闲页可供后续写入复用，但文件不会因此缩小；`incremental_vacuum(N)` 只有在 `INCREMENTAL` 模式且存在空闲页时才有效。从已有表的 `NONE` 切换到 `INCREMENTAL` 需要 `VACUUM` 重建，不能只在连接时设置 PRAGMA。见 [SQLite PRAGMA 文档](https://www.sqlite.org/pragma.html#pragma_auto_vacuum)与 [VACUUM 文档](https://www.sqlite.org/lang_vacuum.html)。

当前终态队列项和 Run 仍作为存活记录保留；恢复载荷也尚未按到期时间自动清理。这类保留数据不是空闲页，单靠 `VACUUM` 不能解决持续增长；后续处理见[数据保留提案](../../proposed/bug-fix/2026-09-23-expire-recovery-and-terminal-control.md)。

## Alternatives considered

- **保持默认空间复用**：没有额外启动或运行时开销；文件不一定会归还空闲页给操作系统。当前测量支持这一做法。
- **现在手动 `VACUUM`**：可以压实页内空间；本次仅能省 4 KiB，完整重建的时间和额外磁盘开销不合算。
- **启用增量回收**：将来可分批处理空闲页；当前没有空闲页，且模式转换需要重建数据库与后续维护逻辑，因此暂不实施。

## Consequences

避免无收益的启动或后台维护任务，保留 SQLite 对空闲页的正常复用。代价是将来大量删除后文件可能保持高水位；出现真实磁盘压力时需重新测量。单次小型开发库快照不能代表长期负载。

## Verification

通过只读连接查询 `page_size`、`page_count`、`freelist_count`、`auto_vacuum` 和 `dbstat`；用 `VACUUM INTO` 写入临时副本比较文件大小，测量后删除副本，未修改主数据库内容。核对 [连接初始化](../../../../src/server/db/connection.ts) 和队列载荷清理路径。本任务没有改动运行代码。
