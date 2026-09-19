# Phase 1 改动记录：SQLite Repository 与状态机

## 1. 改动概述
完成了 Phase 1 的静态代码与测试实现。主要构建了 SQLite 数据层仓库、乐观锁与事务封装、状态机迁移校验逻辑及对应的内存数据库单元测试。

## 2. 新增与修改文件
- `migrations/0001_initial.sql`：对齐 11 号交接基线与 07 号实施计划，规范统一表名为 `coordinator_leases`（主键 `scope_type, scope_id`，包含 `lease_token`、`expires_at` 等）。
- `src/server/db/migrate.ts`：规范 migration 版本记录，适配 schema_migrations 结构。
- `src/server/db/connection.ts`：SQLite 连接工厂，开启 WAL 模式、外键约束、5000ms busy_timeout 并执行迁移。
- `src/server/db/schema-types.ts`：数据表实体 TypeScript 强类型定义。
- `src/server/db/repositories/conversation.repository.ts`：会话（带元数据 revision 乐观锁、暂停状态、删除标记）、草稿（带 revision 乐观锁）以及 UI 偏好配置仓库。
- `src/server/db/repositories/queue.repository.ts`：FIFO 队列仓库，实现幂等入队去重、单会话 10 条入队深度硬限制、原子递增 revision 状态更新。
- `src/server/db/repositories/run.repository.ts`：Local Run 实体仓库，管理 upstream 状态与本地状态映射。
- `src/server/db/repositories/lease.repository.ts`：协调器租约仓库，实现基于 SQLite ON CONFLICT 的租约抢占、续期与释放。
- `src/server/domain/state-machines/queue-state-machine.ts`：严格限定的队列状态迁移图与断言工具。
- `src/server/domain/state-machines/run-state-machine.ts`：严格限定的 Run 状态迁移图与断言工具。
- `src/server/domain/state-machines/lease-state-machine.ts`：租约范围与过期校验辅助定义。
- `tests/unit/phase1-repositories.test.ts`：完整的 Phase 1 单元测试套件（覆盖 revision 冲突、队列去重与上限截断、租约争用）。

## 3. 需求与契约对齐
- 遵循 02/03 契约：数据库与数据访问层无任何消息内容表（不落地会话历史副本）。
- 遵循 08 决策：会话只通过 revision 乐观锁更新 metadata；无 archive 机制。
- 遵循 11 交接基线：队列每会话最大排队深度限制为 10 条（超出抛出 `QUEUE_FULL`）；租约表统一采用 `coordinator_leases`；状态机严格遵循枚举白名单。

## 4. 静态约束声明
本阶段未执行依赖安装（未执行 `pnpm install`），未生成 lockfile，未启动本地/远程数据库服务，未运行测试命令，未访问真实 Hermes 实例。
