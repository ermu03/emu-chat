# emu-chat HTTP API 参考

本文档列出 emu-chat 提供给自身前端的 HTTP 接口。基准路径是 /api/v1；表中的路径均相对于该基准路径。端点和成功状态码以 [服务端路由](../src/server/http/routes/) 为准，请求字段和响应数据结构以 [共享 Zod Schema](../src/shared/api-schemas.ts) 为准。更新接口时，同批更新本文档。

## 通用约定

JSON 接口返回 JSON；运行事件订阅返回 text/event-stream。服务端在响应头中设置 x-request-id。失败响应使用以下结构，upstream_status 与 details 仅在适用时出现：

~~~json
{
  "error": {
    "code": "INVALID_REQUEST",
    "message": "Request validation failed",
    "retryable": false,
    "action": "none",
    "request_id": "rq_123e4567-e89b-42d3-a456-426614174000"
  }
}
~~~

请求无效通常返回 400；版本或状态冲突通常返回 409。上游 Hermes 故障等情况可能返回其他状态，具体错误码与处理建议见共享 Schema 和服务端错误定义。

## 系统状态

| 方法 | 路径 | 请求 | 成功响应 |
| --- | --- | --- | --- |
| GET | /status | 无 | 200 ConnectionStatusResponseSchema |
| POST | /status/recheck | 无；主动重新探测 Hermes | 200 ConnectionStatusResponseSchema |

## 会话与消息

| 方法 | 路径 | 请求 | 成功响应 |
| --- | --- | --- | --- |
| GET | /conversations | limit、offset 查询参数 | 200 ConversationListResponseSchema |
| POST | /conversations | CreateConversationRequestSchema；可用空对象 | 201 ConversationDetailResponseSchema |
| GET | /conversations/:conversationId | 无 | 200 ConversationDetailResponseSchema |
| GET | /conversations/:conversationId/messages | limit、offset、order 查询参数 | 200 MessageListResponseSchema |
| POST | /conversations/:conversation_id/messages | SendMessageRequestSchema | 202 SendMessageResponseSchema |
| POST | /conversations/:conversationId/reset | ResetConversationRequestSchema；可用空对象 | 201 ConversationDetailResponseSchema |
| POST | /conversations/:conversationId/fork | ForkConversationRequestSchema；可用空对象 | 201 ConversationDetailResponseSchema |
| PATCH | /conversations/:conversationId/hermes-metadata | PatchHermesMetadataRequestSchema | 200 ConversationDetailResponseSchema |
| PATCH | /conversations/:conversationId/local-metadata | PatchLocalMetadataRequestSchema | 200 ConversationDetailResponseSchema |
| POST | /conversations/:conversationId/delete | DeleteConversationRequestSchema | 200 DeleteConversationResponseSchema |

会话列表的 limit、offset 默认分别为 50、0；消息列表的 limit、offset、order 默认分别为 100、0、oldest。客户端加载会话消息时显式使用 `order=latest`，首次请求最新 100 条，随后按独立历史游标请求更早的页。`MessageItemSchema` 扩展包含经过服务端展示脱敏的 `tool_calls` 列表（`{ id, name, display_args }`），供工具卡片在展开后显示对应调用的完整输入。发送消息需要 client_request_id 和 expected_draft_revision；202 响应返回入队结果和草稿状态，不直接返回一条已完成的助手消息。相同 client_request_id 在控制记录保留期间返回原结果；`done`、`cancelled` 记录在最后更新后保留 7 天，期满后再提交同一 ID 不保证重放。删除会话需传 expected_hermes_session_id 与 confirmed。

## 草稿

| 方法 | 路径 | 请求 | 成功响应 |
| --- | --- | --- | --- |
| GET | /conversations/:id/draft | 无 | 200 DraftResponseSchema |
| PUT | /conversations/:id/draft | PutDraftRequestSchema：content、expected_revision | 200 DraftResponseSchema |

## 队列与恢复

| 方法 | 路径 | 请求 | 成功响应 |
| --- | --- | --- | --- |
| GET | /conversations/:conversation_id/queue | include_terminal 查询参数 | 200 QueueListResponseSchema |
| POST | /conversations/:conversation_id/queue/resume | 可省略请求体或传空对象 | 200 QueueListResponseSchema |
| PATCH | /queue-items/:queue_item_id | PatchQueueItemRequestSchema | 200 QueueItemResponseSchema |
| POST | /queue-items/:queue_item_id/cancel | CancelQueueItemRequestSchema | 200 QueueItemResponseSchema |
| POST | /queue-items/:queue_item_id/copy-to-draft | CopyToDraftRequestSchema | 200 CopyToDraftResponseSchema |
| POST | /queue-items/:queue_item_id/discard-recovery | 可省略请求体或传空对象 | 200 QueueItemResponseSchema |

include_terminal 只接受字符串 true 或 false，省略时按 false 处理。修改或取消队列项需要 expected_revision；复制恢复内容到草稿需要 expected_draft_revision，可选 overwrite_nonempty。失败项的恢复正文在 `recovery_expires_at` 到达时即停止返回和复制；后台随后清除正文并设置 `payload_expired_at`。

## 运行与事件

| 方法 | 路径 | 请求 | 成功响应 |
| --- | --- | --- | --- |
| GET | /runs/:local_run_id | 无 | 200 RunResponseSchema |
| POST | /runs/:local_run_id/stop | 可省略请求体或传空对象 | 202 RunResponseSchema |
| POST | /runs/:local_run_id/approval | ApprovalRequestSchema | 202 RunResponseSchema |
| POST | /runs/:local_run_id/reconcile | 可省略请求体或传空对象 | 202 ReconcileResponseSchema |
| GET | /runs/:local_run_id/events | after 查询参数或 Last-Event-ID 请求头 | 200 text/event-stream |

事件游标必须是非负整数；同时传 after 和 Last-Event-ID 时，两者必须一致。SSE 使用以下事件名：

- stream.ready：连接建立，包含 local_run_id、earliest_seq 和 latest_seq。
- run.event：运行事件，SSE id 为 local_seq；数据包含 local_run_id、local_seq、type、payload、received_at。
- stream.gap：指定游标无法精确回放时发出，包含缺口原因和序列范围。

连接存续期间还会发送注释形式的心跳。运行事件的短期回放窗口由服务端 SSEHub 管理。

## 偏好设置

| 方法 | 路径 | 请求 | 成功响应 |
| --- | --- | --- | --- |
| GET | /preferences | 无 | 200 PreferencesResponseSchema |
| PUT | /preferences | PutPreferencesRequestSchema | 200 PreferencesResponseSchema |

服务端仍接受 `theme`、`sidebar_width` 和 `send_shortcut` 偏好；当前页面只提供主题切换和侧栏拖拽调宽，发送快捷键没有页面内的修改入口。
