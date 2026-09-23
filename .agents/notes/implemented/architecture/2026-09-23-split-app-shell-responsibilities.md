# Agent Note: 拆分 AppShell 的状态与副作用职责

Status: implemented

## Problem

原 TASK-5：[AppShell](../../../../src/client/app.tsx) 集中处理路由、会话加载与缓存、草稿、队列、SSE、Run 对账和弹窗状态。多个异步流程共享 ref 与 state，使局部修改难以确认对其他流程的影响。

## Decision

按业务生命周期拆分为 `useConversationView`、`useRunRuntime`、`useMessageSend`。视图 Hook 独占当前会话、消息、草稿、队列、Run 快照和缓存，并提供定向更新方法；Run Hook 管理 SSE、轮询、终态对账和 Run/队列操作；发送 Hook 管理发送 UUID、乐观占位及提交后的状态更新。`AppShell` 保留路由、全局连接/偏好状态、会话列表操作和页面组合，不按固定行数拆分。

会话切换立即使旧加载代数失效，缓存命中先恢复快照；发送、Run 和历史消息请求返回时确认目标会话仍然选中。跨 Hook 只通过视图 Hook 提供的方法更新共享队列、Run、消息和流式文本，避免重复状态所有权。

## Alternatives considered

- **保留单组件并只抽工具函数**：改动小，流程仍在一个文件内易于顺读；状态与副作用的耦合基本保留，因此未采用。
- **按三个业务生命周期拆 Hook**：能隔离加载、运行与发送逻辑，故采用；跨 Hook 的共享状态和回调关系需要明确接口，并在会话切换时验证旧请求不会写入新会话。

## Consequences

现在可以在对应 Hook 中定位会话加载、Run 事件或发送流程，`AppShell` 主要表达 UI 组合。代价是 Run 和发送 Hook 依赖视图 Hook 的更新接口；若未来增加新的跨流程写入，应继续维持单一状态所有者，而非在多个 Hook 中复制队列或 Run 状态。

## Verification

`tests/components/app-shell-flow.test.tsx` 覆盖缓存切换、旧请求隔离、乐观发送、SSE 增量及终态对账；原有草稿与删除交互测试继续覆盖数据防丢失路径。`npm run typecheck`、`npm run lint` 和 `npm run build:client` 验证模块边界及打包。
