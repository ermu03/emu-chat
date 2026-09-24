# Agent Note: 修正长会话消息分页方向与偏移

Status: proposed

## Problem

[会话视图](../../../../src/client/state/use-conversation-view.ts)初次请求 `order: "oldest", limit: 100`，按 `oldest` 的排序语义及 Fake Hermes 实现会取得最早的 100 条。页面顶部却显示「加载更早历史消息」，其请求继续使用 `order: "oldest", offset: messages.length`，取得的是后续消息。Run 终态对账还会将最新 100 条合并进 `messages`，此时按合并后的数组长度计算 offset 可能跳过中间页。现有[分页与对账笔记](../../implemented/bug-fix/2026-09-23-keep-long-conversation-messages-visible.md)解决了最新回答在终态后消失的问题，但没有解决完整历史的可靠分页。

## Proposal

确认 Hermes 的 `latest` 排序、分页与新消息插入时的 offset 语义，然后让首次进入会话加载最新一页并按时间顺序展示。将「更早消息」的分页位置与当前合并后的消息数组长度分开维护，确保对账合并最新消息后仍能连续取得遗漏的历史页。消息合并继续按 ID 去重，视口保持现有锚定行为。

## Alternatives considered

- 保持 `oldest` 初始加载并将按钮改名为「加载更多」：改动较小，但长会话首次进入仍看不到最新上下文。
- 每次取得完整消息历史：逻辑简单，但长会话的网络与渲染成本会持续增长。

## Acceptance criteria

- 超过 200 条消息的会话，首次进入能看到最新消息，逐次向上加载可无遗漏、无重复地看到更早消息。
- Run 终态合并最新消息之后继续加载历史，仍不会跳过中间页。
- 新消息在分页过程中写入 Hermes 时，分页游标不会因列表长度变化而漏页；如上游 offset 语义无法保证这一点，需要明确采用可验证的恢复策略。

## Risks

如果上游分页只有 offset 而无稳定游标，分页期间新增消息可能移动 `latest` 排序的页边界；实施前需要用真实 Hermes 响应核实可用字段及重复页的处理方式。
