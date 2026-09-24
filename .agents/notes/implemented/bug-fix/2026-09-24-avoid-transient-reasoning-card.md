# Agent Note: 避免未确认思考事件形成临时卡片

Status: implemented

## Problem

接入 Run 过程事件后，部分回答在显示完文字、进入「正在核对回复…」时短暂出现「思考过程」卡片，随后历史消息刷新又把它移除。Hermes 的 `reasoning.available` 事件在当前 Run 接口中可由普通助手 `content` 触发，事件文本不一定落在历史消息的 `reasoning` 字段。将该事件直接当成可持久展示的思考内容，会在[终态交接](../feature/2026-09-24-progressive-tool-events-and-stable-run-handoff.md)时制造一次假卡片闪现。

## Decision

[Run 事件处理](../../../../src/client/state/use-run-runtime.ts)不再把 `reasoning.available` 加入临时回合。思考卡片只从 Hermes 消息 API 返回的 `reasoning` 或 `reasoning_content` 字段生成；[历史分组](../../../../src/client/features/messages/message-display.ts)按原有顺序保留真实思考内容。文字与工具事件继续流式展示，终态仍以 Hermes 历史为准。

## Alternatives considered

- **终态保留所有 SSE 思考卡片**：能避免当次页面闪现后消失，但事件可能只是普通助手正文；页面刷新后也无法从 Hermes 历史恢复，会造成重复或不一致。
- **按事件文本与回答正文相似度过滤**：可以去掉明显重复，但截断、改写和多段输出都让匹配不可靠，仍会偶发误判。
- **扩展上游事件，明确区分已保存的 reasoning 与临时进度**：长期更精确，但需要 Hermes 协议和持久化协同修改；当前客户端已有权威字段可用于稳定展示。

## Consequences

没有权威 reasoning 的回答不再短暂显示「思考过程」；有权威 reasoning 的回答在历史读取完成后显示并保持。代价是思考内容不会仅凭 SSE 提前出现。如果未来 Hermes 提供可与历史消息稳定关联的思考事件，再考虑恢复实时思考展示。

## Verification

[组件异步用例](../../../../tests/components/app-shell-flow.test.tsx)注入正文对应的 `reasoning.available` 事件，验证核对前后都不会出现临时卡片；[历史分组用例](../../../../tests/unit/message-display.test.ts)验证真实 `reasoning` 仍进入思考块。
