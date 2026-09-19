# ADR-0002：使用 Hermes `/v1/runs` 作为异步执行主通道

- 状态：已接受
- 日期：2026-09-19
- 决策人：用户确认 Q-17

## 背景

Hermes 有两条可用流式路径：

- `/api/sessions/{id}/chat/stream` 有 `seq` 和更丰富的 native session 事件，但上游 SSE 客户端断开会 interrupt 当前 Agent，且没有持久幂等 reservation；
- `POST /v1/runs` 返回独立 run id，支持 durable `Idempotency-Key`、status、stop 和活动期 events；断开 events 订阅不一定停止 run，但 events transport 没有 replay。

emu-chat 需要队列、刷新、短断线和防重复提交，不能把浏览器连接生命周期当作 Agent 生命周期。

## 决策

MVP 由 emu-chat 后端使用 `/v1/runs` 提交和控制，使用 `/v1/runs/{id}/events` 接收活动期事件；浏览器只订阅 emu-chat 自己的 SSE。`/api/sessions/{id}/chat/stream`、`/v1/chat/completions` 和 `/v1/responses` 都不作为 fallback 或浏览器直连路径。

后端必须：

- 为每个 operation 持久化稳定 idempotency key 和 Hermes run id；
- 在浏览器断开时保持后台 run 和上游订阅；
- 在重连/重启时先查 status，再读 Hermes messages；
- 明确告知 events replay 不可用，不因事件缺失重发输入。

## 后果

能恢复 run 终态并防止重复执行；中间 delta/tool 事件在后端重启或上游订阅断开后可能丢失。若未来要求完整事件回放，必须扩展 Hermes 的持久事件 API，而不是让 emu-chat 复制 transcript。

`/v1/runs` 是 Hermes 自定义协议，不被描述为 OpenAI-compatible。MVP 不对外提供 OpenAI-compatible API。
