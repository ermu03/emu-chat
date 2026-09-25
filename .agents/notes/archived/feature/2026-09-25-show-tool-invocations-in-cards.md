# Agent Note: 工具卡片标题展示调用内容

Status: implemented
Archived: 2026-09-25

## Problem

工具卡片原先在标题显示结果预览。运行时无法从折叠卡片辨认正在执行的命令；历史消息的助手 `tool_calls[]` 虽含调用 ID 和参数，前端消息接口却没有传递这些展示信息。Hermes 的工具摘要和结果还可能含有约定名称的凭据。

## Decision

运行中的标题显示工具名、`tool.started.preview` 调用摘要和状态；结果预览留在展开区。读取历史时，服务端从 Hermes 的 `assistant.tool_calls[]` 生成每次调用的展示名、单行摘要和完整展示参数，`terminal` 展开区使用完整命令。前端按调用顺序生成卡片，并优先用 `tool_call_id` 配对结果。实时事件没有调用 ID；同名并发调用无法唯一对应时保留待核对状态，待历史消息形成权威卡片。Hermes 事件协议和 emu-chat 持久层均不变。

展示数据在服务端进入 SSEHub 回放缓冲或消息 API 响应之前，按已约定的名称遮盖 JSON 参数键、环境变量赋值、命令行选项、HTTP 头、URL 查询参数及 URL 用户信息中的密码。历史工具结果、工具调用消息的正文与推理字段也经过同一规则处理。只遮盖 `token`、`api_key`/`api-key`/`apikey`、`password`、`secret`、`cookie`、`authorization` 及 URL 用户信息密码，整个值替换为 `[已隐藏]`。普通参数和命令结构保留；浏览器不接收原始调用参数。

## Alternatives considered

- 扩展 Hermes SSE 发送完整参数和调用 ID，可以在运行中精确配对同名调用；现有摘要已满足运行时一行展示，跨仓库协议改动没有必要。
- 只在浏览器端遮盖，改动较少；原始调用参数会先进入浏览器和 SSE 回放缓冲，不能满足展示边界。

## Consequences

折叠卡片可以辨认本次调用，历史中能查看经遮盖的完整命令和对应输出。终端命令是自由文本，遮盖仅覆盖约定写法；没有这些名称或结构的凭据无法自动识别。同名并发工具在实时阶段仍不能靠工具名推断结果归属。

## Verification

`npm run typecheck`、相关 Vitest 用例和构建覆盖接口类型、调用配对、摘要交接与展示遮盖；历史精确配对仍以 Hermes 返回的 `tool_call_id` 为准。
