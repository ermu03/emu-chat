# Agent Note: 长对话消息分页与终态对账

Status: implemented

## Problem

原 BUG-1 与 ISSUE-6 是同一条消息分页链路的问题。[AppShell](../../../../src/client/app.tsx) 初次加载和 Run 终态对账都只请求最早的 100 条消息；对账时又用这页数据替换消息列表并清除流式内容。会话超过 100 条后，新回答虽已写入 Hermes，却因只拉取前 100 条而从界面上消失。

[HermesAdapter](../../../../src/server/hermes/adapter.ts) 原先将 `has_more` 固定写死为 `false`，把本页条数当成 `total`；[共享响应 Schema](../../../../src/shared/api-schemas.ts) 没有暴露 `has_more` 与 `total`。真实 Hermes 响应中，`pagination` 对象可能缺省 `total` 或 `has_more`。

## Decision

1. **修正上游与本地 Schema 契约**：
   - 在 [hermes-schemas.ts](../../../../src/shared/hermes-schemas.ts) 的 `HermesMessageListResponseSchema.pagination` 中补充可选的 `total` 和 `has_more`。
   - 在 [api-schemas.ts](../../../../src/shared/api-schemas.ts) 的 `MessageListResponseSchema` 中暴露 `has_more: z.boolean()` 与可选的 `total: z.number().optional()`。
2. **规范适配器分页解析**：
   - 在 [HermesAdapter.getSessionMessages](../../../../src/server/hermes/adapter.ts) 中，优先尊重 upstream 的 `pagination.has_more` 或 `offset + messages.length < total`；若均未提供，则以 `messages.length >= limit` 动态判定是否存在下一页，并如实透传 `total`。
   - 在 [ConversationService.getMessages](../../../../src/server/services/conversation-service.ts) 中透传 `has_more` 和 `total`。
3. **客户端双向对账合并与增量去重**：
   - 在 [message-display.ts](../../../../src/client/features/messages/message-display.ts) 中实现 `mergeMessages(existing, incoming)`，按消息 `id` 去重并维持升序自然时序。
   - 在 [useRunRuntime](../../../../src/client/state/use-run-runtime.ts) 中，当 Run 达到 `reconciled` 终态时，通过 [useConversationView](../../../../src/client/state/use-conversation-view.ts) 从最新消息向已加载消息逐页对账并合并，然后清除对应的流式缓存。
   - `useConversationView` 提供 `handleLoadEarlier` 并在快照恢复与会话切换中维护历史分页状态。分页方向与独立游标由[后续决定](2026-09-24-correct-message-pagination.md)修正。
4. **滚动视口锚定与顶部加载控件**：
   - 在 [MessageView](../../../../src/client/features/messages/message-view.tsx) 顶部增加「加载更早历史消息」按钮及加载中指示。
   - 在顶部追加历史消息时，利用 `scrollHeight` 差值自动修正 `scrollTop`，防止视口跳动。

## Alternatives considered

- **每次拉取全量历史**：实现直观但长对话下网络开销和渲染成本巨大，废弃。
- **单纯追加式分页**：对于超长对话，如果在第 100+ 条处生成新消息，单纯尾部追加若对账时不拉最新条目，刷新或进入时仍可能缺失。选择对账时拉取最新消息并合并。

## Consequences

- **收益**：长会话（>100 条）在生成完成、Run 终态对账后，最新回答保持可见；分页元数据真实反映 upstream 状态。
- **代价**：客户端需要维护合并去重逻辑与滚动位置补偿；在上游未返回 total 时依赖 `messages.length >= limit` 推断 `has_more`。

当前历史加载方向和游标恢复方式见[消息分页修正决定](2026-09-24-correct-message-pagination.md)。
