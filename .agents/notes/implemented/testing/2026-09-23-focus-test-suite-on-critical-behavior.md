# Agent Note: 测试套件聚焦关键行为

Status: implemented

## Problem

原测试套件有 17 个文件、88 个用例、3118 行，静态 DOM、简单缓存和重复的 HTTP 矩阵占用了较多维护成本。测试文档还鼓励覆盖纯函数，与 AGENTS.md 的必要测试策略冲突。

## Decision

测试保留在三个风险边界：组件只验证删除确认、失败后草稿保留和旧保存 ACK 的竞态；单元验证仓储 CAS/FIFO/租约、Hermes 协议与能力评估、SSE 重放；集成验证消息从原子入队到派发和终态对账，并在共享数据库与 Fake Hermes 的服务重建场景中验证已接纳 Run 的恢复。删除静态渲染断言、简单缓存测试和重复的会话及上游矩阵，不设置覆盖率门槛。

## Alternatives considered

- 保留完整套件的优势是非主干分支有更多自动回归，但每次 UI 和接口重构都需要维护低风险细节的断言。
- 只保留一条端到端主流程的优势是最省维护，但无法定位或阻止 CAS、租约和协议边界的错误。

## Consequences

测试缩减至 7 个文件、37 个用例、1232 行，保住用户数据和核心协调流程的回归保障，同时减少维护面。非主干分支不再有独立自动回归；其复杂度或使用风险上升时，需要按 AGENTS.md 重新评估补测。测试耗时受缓存和运行环境影响，当前主要收益是降低维护成本。

## Verification

`npm test -- --reporter=dot`、`npm run typecheck`、`npm run lint`、`npm run format:check` 均通过。现行测试文件和范围见 [测试策略](../../../../docs/10-testing.md)。
