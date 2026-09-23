# Agent Note: 拆分 AppShell 的状态与副作用职责

Status: proposed

## Problem

原 TASK-5：[AppShell](../../../../src/client/app.tsx) 当前约 1290 行，集中处理路由、会话加载与缓存、草稿、队列、SSE、Run 对账和弹窗状态。多个异步流程共享 ref 与 state，使局部修改难以确认对其他流程的影响。

## Proposal

按实际生命周期拆分会话视图加载与缓存、Run 流式事件与对账、消息发送与排队等职责；自定义 Hook 是候选承载方式，例如 `useConversationView`、`useRunRuntime`、`useMessageSend`。明确各模块的数据所有权和取消旧请求的边界，让 `AppShell` 主要负责组合页面与传递状态。不以“压到 200 行以内”作为验收标准，先保证流程和依赖关系更清晰。

## Alternatives considered

- **保留单组件并只抽工具函数**：改动小，流程仍在一个文件内易于顺读；状态与副作用的耦合基本保留。
- **按三个业务生命周期拆 Hook**：能隔离加载、运行与发送逻辑；跨 Hook 的共享状态和回调关系需要谨慎设计。

## Acceptance criteria

- 会话切换、缓存恢复、草稿保存、发送排队、SSE 更新及终态对账的现有行为保持正确。
- 主要状态和副作用有明确归属，开发者可在对应模块定位流程；`AppShell` 不再集中承载全部业务编排。

## Risks

搬动异步逻辑可能引入旧请求覆盖新会话、Run 状态不同步或重复订阅；拆分应按风险逐步验证，不为行数目标增加抽象。
