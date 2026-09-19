# ADR-0003：搜索和 checklist 不在 emu-chat 中猜测补齐

- 状态：已接受
- 性质：MVP 范围与能力边界
- 日期：2026-09-19

## 背景

- 当前 Hermes API Server 支持 session 列表、exact-title 查询和按 ID 读取，但没有 transcript 全文搜索端点。
- `/v1/runs` 有通用工具、reasoning、subagent 和 approval 事件，没有完整、不可截断、可恢复的 checklist snapshot。
- 当前阶段禁止修改 Hermes 源码。

## 决策

1. MVP 搜索只支持精确 session ID 与 exact-title；不在 emu-chat 建立 transcript FTS。
2. MVP 把 `todo_list` 当普通工具状态展示，不解析其 preview，也不从 Markdown checkbox 推导权威条目状态。
3. UI 明确标注搜索范围与 checklist 降级，不使用模糊的“全文搜索”“任务已完成”等文案。

## 后果

首版能力较窄，但保持 Hermes 为唯一事实来源，且不会因文本猜测展示错误状态。全文搜索和结构化 checklist 只有在未来 Hermes 提供正式只读/事件契约后才能加入。
