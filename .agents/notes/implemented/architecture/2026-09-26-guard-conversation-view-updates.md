# Agent Note: 收窄会话视图接口并集中异步写入校验

Status: implemented

## Problem

原 [useConversationView](../../../../src/client/state/use-conversation-view.ts) 向 AppShell、Run 和发送 Hook 暴露会话详情、消息、草稿等底层 setter 与可写 ref。各调用方只比较会话 ID，无法区分 A → B → A 的两次选择；元数据回调还会把异步开始时捕获的整份 A 详情写回当前视图。实际复现中，A 的重命名在切到 B 后返回，B 的消息仍在，但会话详情被 A 替换，输入框卸载。

## Decision

保留[三 Hook 职责分工](./2026-09-23-split-app-shell-responsibilities.md)，将 `ConversationView` 改成显式接口：调用方只能读取视图状态和受限的运行快照，并调用带目标上下文的业务更新方法，不能直接写共享 state 或 ref。`ViewTarget` 包含会话 ID 与选择代数；恢复缓存、选择会话和重新加载都会使旧代数失效，因此第一次 A 发出的响应不能写入第二次 A。视图所有者在 Queue、Run、草稿、历史消息和 SSE 展示提交处统一核对目标。

同一选择内，Queue 快照还核对请求开始时的本地版本，队列项核对 revision；Run 结果核对会话与 Run ID、`updated_at` 以及已经提交的终态，避免旧轮询或操作响应覆盖新状态；草稿结果核对 revision。发送与运行 Hook 在旧目标失效时，不直接写当前视图；如果用户此时又选中原会话，可触发新的服务端读取。`DraftComposer` 继续保管未保存的输入和保存队列，分页与流式回合交接保持原有流程。

元数据保存的成功结果按标题或置顶字段更新目标会话的当前详情与缓存，即使目标已不是当前选择也要保留成功变更。此前启动的详情读取若晚于字段更新返回，只能保留读取期间确认的新字段。会话列表仅应用最新发起的请求结果。元数据更新不再写回异步开始时捕获的整份会话对象。

## Alternatives considered

- **只在重命名回调里比较当前会话**：可快速修复复现的问题，但其他调用方仍可直接写 setter，A → B → A 也无法只靠 ID 区分。
- **重做独立控制器或统一 reducer**：可把更多转换集中在一个模型，但会同时改动草稿、分页、缓存和流式交接。现有 Hook 内收窄接口已足以覆盖已知竞态，暂不增加这一层。

## Consequences

延迟重命名不再卸载另一会话的输入框；返回原会话时，成功的标题或置顶变更可从列表和缓存读到。旧选择、旧 Queue 快照与旧 Run 响应不能回退当前视图。代价是 Run 和发送 Hook 需要显式传递 `ViewTarget`，视图接口增加了少量按业务划分的提交方法；若新共享状态加入，应继续由视图所有者校验。同一字段的多次并发元数据请求仍由服务器实际完成顺序决定，本轮没有引入跨请求的写入序列化。

## Verification

[跨模块组件测试](../../../../tests/components/app-shell-flow.test.tsx)复现延迟重命名期间切到 B、保留 B 的未发送输入、返回 A 后读取新标题，并验证非当前会话置顶和 A → B → A 后旧 Run 响应不能替换新 Run。现有发送、草稿、分页与 SSE 交接用例继续通过。`npm test` 共 14 个测试文件、74 个用例通过；`npm run typecheck`、`npm run lint`、`npm run format:check` 与 `npm run build` 通过。测试运行于 Node.js 26，项目要求的 Node.js 22 环境尚未验证。
