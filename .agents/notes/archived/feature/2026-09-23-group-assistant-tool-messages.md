# Agent Note: 按助手回合折叠工具调用与思考过程

Status: implemented
Archived: 2026-09-24

## Problem

原 BUG-3：[getRenderableMessages](../../../../src/client/features/messages/message-display.ts) 只过滤空消息，[MessageView](../../../../src/client/features/messages/message-view.tsx) 按消息逐条扁平渲染。一次回答包含多次工具调用与思考过程时，每次工具请求和返回值都会形成一个独立的聊天气泡，将用户提问与最终回答严重拉开，主干阅读体验差。

## Decision

在前端展示层引入回合聚合逻辑（[groupMessagesIntoTurns](../../../../src/client/features/messages/message-display.ts)），在不修改底层 Hermes 消息模型与存储协议的前提下将消息分组渲染：

1. **回合划分**：以 `user` 和 `system` 消息作为回合天然边界，其间连续的 `assistant` 与 `tool` 消息归集为一个 `AssistantTurn`。
2. **两阶段文本拆分**：如果回合内存在工具调用，最后一次工具执行之前的 `assistant` 纯文本视为中间执行步骤（`kind: "text"`），放置于过程列表内；最后一次工具执行之后的 `assistant` 文本视为 `finalContent` 默认直接渲染。纯对话无工具调用的回合保持常规对话显示。
3. **工具与结果配对**：优先基于 `tool_call_id` 配对工具调用与执行结果；缺失时依序倒序匹配同名工具或回退配对；孤立工具消息以兜底结构展示。同时解析 JSON 错误字段与非零退出码标红提示。
4. **过程折叠卡片交互**：将思考过程（Reasoning）与所有工具步骤收敛到单一 `<details className="turn-process-card">` 折叠卡片内。有 `finalContent` 时默认折叠，突出最终回答；若回合由于中断或错误没有最终文本，则默认展开（`open`），避免隐藏关键报错信息。

## Alternatives considered

- **继续逐条展示**：原始消息最透明，实现也最简单；但多次工具调用的复杂 Agent 回合会产生数十个气泡，淹没主要对话。
- **只折叠单条工具气泡**：改动小，但一次回答仍会在视图中留下大量零散的独立折叠条，视觉噪音依然明显。

## Consequences

- **收益**：用户能一眼看清助手给出的最终答案与代码，大幅减少滚动成本；需要排查或审计调用过程时可一键展开完整思考与工具入参/输出。
- **代价**：依赖展示层内存中的配对与状态分组启发式规则。若未来 Hermes 上游协议演进引入交错并行的复杂分支回合，需持续评估该展示规则是否满足全部边界。

## Verification

- 运行单元测试验证聚合与配对逻辑：`npx vitest run tests/unit/message-display.test.ts`
- 运行代码检查与构建：`npm run typecheck && npm run lint && npm run build && npm test`
