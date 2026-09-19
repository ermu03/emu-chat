# emu-chat Browser API 与错误包契约

状态：MVP 已批准实现基线
更新时间：2026-09-19
API base：`/api/v1`

本文固定浏览器与 emu-chat 后端之间的协议。Gemini 应据此生成共享 Zod schema 和 `openapi/emu-chat-v1.yaml`；不得增加本文件未列出的 MVP route。

## 1. 通用规则

- 无 emu-chat 登录/cookie/token；浏览器使用同源 HTTP。
- JSON mutation 必须为 `Content-Type: application/json`，未知字段拒绝。
- 时间均为 UTC ISO 8601（毫秒精度）；数量/游标为非负整数。
- ID 前缀：`cv_` conversation、`qi_` queue item、`op_` operation、`lr_` local run、`rq_` request。后缀使用 UUID。
- 每个响应带 `X-Request-Id: rq_...`；客户端可传同格式 `X-Request-Id`，非法值由服务端替换。
- 成功响应有稳定 `object`；错误只使用统一 envelope。
- 字符串长度、分页和枚举在服务端校验；不截断后继续执行。
- 所有 mutation 的重复点击必须由状态/CAS/client request id 安全收敛，不能依赖按钮禁用。
- `retryable=true` 只表示可以向用户提供明确的再次操作，不授权 React Query/EventSource 自动重放 mutation。send 只有在 Browser API 响应未知时复用同一 `client_request_id`；收到任意确定响应后，下一次用户点击使用新 id。

## 2. 统一错误 envelope

```json
{
  "error": {
    "code": "HERMES_UNAVAILABLE",
    "message": "当前无法连接 Hermes",
    "retryable": true,
    "request_id": "rq_...",
    "operation_id": "op_...",
    "details": {
      "retry_after_seconds": 5
    }
  }
}
```

`operation_id` 和 `details` 可省略。`message` 是安全中文用户文案；前端以 `code` 决定行为，不解析 message。`details` 只能包含各错误明确允许的字段。

| code | HTTP | retryable | 语义/允许 details |
| --- | --- | --- | --- |
| `INVALID_REQUEST` | 400 | false | schema/枚举/分页错误；`fields[]` |
| `PAYLOAD_TOO_LARGE` | 413 | false | 超上限；`limit_bytes` |
| `LOCAL_NOT_FOUND` | 404 | false | 本地 conversation/item/run 不存在 |
| `HERMES_NOT_FOUND` | 404 | false | 上游 session/run 不存在 |
| `DRAFT_CONFLICT` | 409 | false | revision 不符；`current_revision` |
| `LOCAL_CONFLICT` | 409 | false | lease、client request、expected session 等冲突；可有 `current_revision`、`current_hermes_session_id` |
| `STATE_CONFLICT` | 409 | false | 当前状态不允许动作；`current_state` |
| `RUN_ACTIVE` | 409 | false | conversation/global active run 阻止动作 |
| `APPROVAL_NOT_PENDING` | 409 | false | approval 已失效；前端刷新 run |
| `REVIEW_REQUIRED` | 409 | false | 无法安全自动判断/执行；禁止自动重放 |
| `HERMES_NOT_READY` | 503 | true | status 非 healthy；`connection_state` |
| `HERMES_AUTH_FAILED` | 502 | false | 服务端 Hermes key 错误/缺失 |
| `HERMES_UNAVAILABLE` | 502/503 | true | 连接、超时、健康失败；可有 `retry_after_seconds` |
| `HERMES_CONFLICT` | 409 | false | 上游 409/幂等冲突 |
| `HERMES_TEMPORARY_FAILURE` | 502/503 | true | 429/5xx；可有安全 retry after |
| `HERMES_PROTOCOL_ERROR` | 502 | false | response/event 契约破坏 |
| `HERMES_BUSY_GLOBAL` | 409 | true | 删除门禁发现 active agents 非零/未知 |
| `DELETE_UNCONFIRMED` | 503 | true | DELETE 结果不能确认；conversation 保留 |
| `INTERNAL_ERROR` | 500 | false | 未知本地错误；无堆栈 |

MVP 不返回 `UNAUTHENTICATED/FORBIDDEN`，因为没有 emu-chat 认证。Hermes 401/403 统一映射为 `HERMES_AUTH_FAILED`。

## 3. 公共资源形状

### 3.1 ConnectionStatus

```json
{
  "object": "emu_chat.status",
  "emu_chat": {"status":"healthy","version":"0.1.0"},
  "database": {"status":"healthy","schema_version":1},
  "hermes": {
    "status":"checking|healthy|degraded|unavailable|auth_failed|incompatible|config_error",
    "version":"0.21.3",
    "missing_capabilities":[],
    "checked_at":"2026-09-19T00:00:00.000Z"
  },
  "deployment": {
    "lan_http_warning":true,
    "pwa_secure_context_required":true
  }
}
```

### 3.2 Conversation

```json
{
  "object":"emu_chat.conversation",
  "id":"cv_...",
  "hermes":{
    "session_id":"...",
    "source":"api_server",
    "title":"...",
    "message_count":2,
    "parent_session_id":null,
    "last_active":0,
    "preview":"...",
    "pinned":false,
    "hidden":false,
    "archived":false
  },
  "local":{
    "tags":[],
    "custom_order":null,
    "metadata_revision":0,
    "queue_paused":false,
    "pause_reason":null,
    "delete_state":"none|pending|failed"
  },
  "active_local_run_id":null,
  "created_at":"...",
  "updated_at":"..."
}
```

Hermes 对象来自本次上游读取，不从 SQLite 镜像。`archived` 可能存在于 detail 但 MVP 无对应动作。

`queue_paused=false` 时 `pause_reason` 必须为 NULL，`queue_paused=true` 时必须是以下精确值之一：

| `pause_reason` | 触发 |
| --- | --- |
| `run_failed` | status=`failed` 且 `partial=false` |
| `run_partial` | status=`failed` 且 `partial=true` |
| `run_cancelled` | 非用户 stop 导致的 `cancelled` |
| `run_interrupted` | status=`interrupted` |
| `user_stopped` | 用户已请求 stop；后续任意终态都保留此原因，直到用户 resume |
| `submission_rejected` | 明确未接纳的 non-retryable 4xx |
| `reconciliation_failed` | 已知 terminal，但 5 分钟内无法完成 status/messages 对账 |
| `review_required` | admission、run identity 或 terminal 前状态仍有歧义 |
| `manual_resume_required` | 人工重新核对已确认 completed，但后续队列仍等待用户明确继续 |

### 3.3 Draft

```json
{
  "object":"emu_chat.draft",
  "conversation_id":"cv_...",
  "content":"...",
  "revision":4,
  "updated_at":"..."
}
```

不存在的 draft 按 `{content:"", revision:0, updated_at:null}` 返回，不用 404。

### 3.4 QueueItem

```json
{
  "object":"emu_chat.queue_item",
  "id":"qi_...",
  "conversation_id":"cv_...",
  "operation_id":"op_...",
  "fifo_seq":12,
  "state":"queued|dispatching|accepted|reconciling|done|paused|review_required|rejected|cancelled",
  "content":"可用时返回；正文已清除时为 null",
  "payload_bytes":123,
  "payload_available":true,
  "recovery_expires_at":null,
  "payload_expired_at":null,
  "local_run_id":"lr_...",
  "revision":0,
  "last_error_code":null,
  "created_at":"...",
  "updated_at":"..."
}
```

不得把 `content` 混入 Hermes messages 或全文搜索。`local_run_id` 可空。

### 3.5 RunSnapshot

```json
{
  "object":"emu_chat.run",
  "id":"lr_...",
  "conversation_id":"cv_...",
  "queue_item_id":"qi_...",
  "hermes_run_id":"run_...",
  "local_state":"submitting|accepted|reconciling|reconciled|rejected|review_required",
  "upstream_status":"queued|running|waiting_for_approval|stopping|completed|failed|cancelled|interrupted",
  "partial":false,
  "last_event_seq":17,
  "events_truncated":false,
  "approval":null,
  "last_error_code":null,
  "started_at":"...",
  "terminal_at":null,
  "updated_at":"..."
}
```

`hermes_run_id`/`upstream_status` 在 submit 前可空。`approval` 仅在当前上游 snapshot 明确提供时返回安全投影：`request_id`、redacted command/description、`choices` 与 deadline；choices 对浏览器只保留 `once|deny`。

## 4. 状态 API

### `GET /api/v1/status`

返回缓存的 ConnectionStatus；可以触发后台过期检查，但不要求每次阻塞请求 Hermes。

### `POST /api/v1/status/recheck`

请求体：空对象 `{}`。立即执行一次 health/capabilities 探测并返回 ConnectionStatus。并发 recheck 合并为同一探测；不启动 run。

## 5. Conversation 与 messages API

### `GET /api/v1/conversations`

query：

- `limit`：1–100，默认 50；
- `offset`：>=0，默认 0；
- `session_id`：精确 ID，可选；
- `title`：exact-title，可选；
- `session_id` 与 `title` 互斥。

返回：

```json
{
  "object":"list",
  "data":[],
  "pagination":{"limit":50,"offset":0,"has_more":false},
  "search_scope":"exact_session_id_or_exact_title_only"
}
```

固定上游 `source=api_server`，无 source/profile/archived/children 浏览器参数。

### `POST /api/v1/conversations`

请求：`{"title":"可选，最多 200 字符"}`，唯一允许字段。返回 `201` Conversation。

### `GET /api/v1/conversations/{conversation_id}`

实时读取 Hermes detail 并左联本地状态。上游失败返回错误，不退回本地 title/preview。

### `GET /api/v1/conversations/{conversation_id}/messages`

query：`limit` 1–200（默认 100）、`offset` >=0、`order=oldest|latest`（默认 oldest）。

```json
{
  "object":"emu_chat.message.list",
  "conversation_id":"cv_...",
  "requested_session_id":"...",
  "effective_session_id":"...",
  "scope":"current_resumable_segment",
  "older_segments_included":false,
  "data":[],
  "pagination":{"limit":100,"offset":0,"order":"oldest","returned":0}
}
```

`data` 严格使用 `03` 的 message allowlist。若 effective id 改变，响应前完成本地映射事务。

### `POST /api/v1/conversations/{conversation_id}/reset`

请求：`{"title":"可选"}`。前置：本地 conversation 存在且无 active item。返回 `201` 新 Conversation；旧 conversation 不变。

### `POST /api/v1/conversations/{conversation_id}/fork`

请求：`{"title":"可选"}`。前置同 reset。返回 `201` 新 Conversation。

### `PATCH /api/v1/conversations/{conversation_id}/hermes-metadata`

请求必须是以下之一：

```json
{"field":"title","value":"新标题"}
```

```json
{"field":"pinned","value":true}
```

返回重新读取后的 Conversation。禁止 hidden/archived/unread/end_reason。

### `PATCH /api/v1/conversations/{conversation_id}/local-metadata`

```json
{
  "expected_revision":3,
  "tags":["tag"],
  "custom_order":12.5
}
```

`tags`/`custom_order` 至少一个存在；`custom_order` 可为 null。tags 最多 20、去空白后唯一，每项最多 40 字符。CAS 失败为 `LOCAL_CONFLICT` 并返回当前 revision。

### `POST /api/v1/conversations/{conversation_id}/delete`

```json
{
  "expected_hermes_session_id":"...",
  "confirmed":true
}
```

只执行 `05` 的门禁和真实 segment delete。成功：

```json
{
  "object":"emu_chat.conversation.deleted",
  "conversation_id":"cv_...",
  "hermes_session_id":"..."
}
```

没有 archive/restore/hide route。

## 6. Draft、send 与 queue API

### `GET /api/v1/conversations/{conversation_id}/draft`

返回 Draft。

### `PUT /api/v1/conversations/{conversation_id}/draft`

```json
{"content":"...","expected_revision":4}
```

content 最大 64 KiB UTF-8。Hermes 离线也允许。CAS 成功 revision + 1 并返回 Draft；失败 `DRAFT_CONFLICT`。

### `POST /api/v1/conversations/{conversation_id}/messages`

浏览器必须先保存最新 draft，然后发送：

```json
{
  "client_request_id":"浏览器生成的 UUID",
  "expected_draft_revision":5
}
```

服务端不从该请求接收第二份正文，而是在事务中读取 draft：

1. 先查询 `client_request_id`，不受 Hermes health、当前 draft revision 或 queue pause 影响；
2. 已存在于同一 conversation：返回原 QueueItem 和当前 Draft，`replayed=true`，不再清 draft；存在于另一 conversation：`LOCAL_CONFLICT`；
3. 只有 id 不存在时，才要求 Hermes status=`healthy`；
4. 进入创建事务后再次查询 id 防并发，再校验 draft revision、content 非空/不超过 64 KiB；
5. 创建 queue item/operation/key/FIFO，清空 draft content 并 revision + 1；
6. 提交 coordinator 异步尝试。

返回 `202`：

```json
{
  "object":"emu_chat.message_submission",
  "replayed":false,
  "queue_item":{},
  "draft":{"content":"","revision":6,"updated_at":"..."}
}
```

新的 client request id 遇到 Hermes 非 healthy 时，在 mutation transaction 前返回 `HERMES_NOT_READY`，不得创建 queue item 或清空 draft。conversation 已 paused 不阻止 send：新 item 正常进入 FIFO `queued`，但在用户 resume 前不 dispatch，也不返回“队列暂停”错误。

相同 client request id 被不同 conversation 使用为 `LOCAL_CONFLICT`。该 replay 保证以 queue control record 的存在期为界：active/queued 期间一直有效，`done|cancelled` 后至少保留 7 天；浏览器只可为同一次尚未得到确定响应的 send 复用 id。

### `GET /api/v1/conversations/{conversation_id}/queue`

返回按 `fifo_seq` 升序的非默认隐藏控制记录：

```json
{
  "object":"emu_chat.queue",
  "conversation_id":"cv_...",
  "paused":true,
  "pause_reason":"run_failed",
  "data":[]
}
```

默认返回非 `done|cancelled` 项；query `include_terminal=true` 可返回最近 100 个控制记录，但不恢复已清正文。

### `PATCH /api/v1/queue-items/{queue_item_id}`

```json
{"content":"修改后的正文","expected_revision":0}
```

只允许 `state=queued`；content 必须非空且不超过 64 KiB UTF-8。使用 item revision CAS，在同一事务更新正文/hash/bytes并 revision + 1。任何已 dispatch 状态返回 `STATE_CONFLICT`。

### `POST /api/v1/queue-items/{queue_item_id}/cancel`

请求：`{"expected_revision":1}`。只允许 queued；设 cancelled 并立即清正文。返回 QueueItem。

### `POST /api/v1/conversations/{conversation_id}/queue/resume`

请求：`{}`。前置：queue paused、无 active item/未过期 reconciliation lease、Hermes healthy。清 pause 后异步尝试当前 FIFO 队首。返回 queue snapshot。不会重发 paused/review_required/rejected item。

### `POST /api/v1/queue-items/{queue_item_id}/copy-to-draft`

```json
{
  "expected_draft_revision":6,
  "overwrite_nonempty":false
}
```

只允许 `paused|review_required|rejected` 且 payload 仍可用。非空 draft 且未显式 overwrite 返回 `DRAFT_CONFLICT`。返回新 Draft 和固定 `duplicate_risk=true`；原 queue item 不变。

### `POST /api/v1/queue-items/{queue_item_id}/discard-recovery`

请求：`{}`。只允许 `paused|review_required|rejected`；将正文置 NULL，记录丢弃时间，返回 QueueItem。不可撤销。

不存在 queue retry/replay route。

## 7. Run API

### `GET /api/v1/runs/{local_run_id}`

返回 RunSnapshot。active/terminal 未对账的 run 可触发安全的上游 status refresh，但绝不提交 input。

### `GET /api/v1/runs/{local_run_id}/events`

query `after` 为可选非负本地 seq；同时支持标准 `Last-Event-ID`，两者都存在时必须相等，否则 `INVALID_REQUEST`。

SSE 帧：

```text
event: stream.ready
data: {"local_run_id":"lr_...","earliest_seq":1,"latest_seq":17}

id: 17
event: run.event
data: {"local_run_id":"lr_...","local_seq":17,"type":"message.delta","payload":{"delta":"..."},"received_at":"..."}

event: stream.gap
data: {"local_run_id":"lr_...","requested_after":3,"earliest_seq":20,"latest_seq":42,"reason":"buffer_evicted|process_restarted|upstream_disconnected|protocol_error|cursor_ahead"}

: keepalive
```

- heartbeat 每 15 秒；
- `stream.ready/gap` 无 SSE id；只有实际 run event 设置 id；
- local seq 首次从 1 开始，进程重启后从持久化 `last_event_seq + 1` 继续；不得重复使用旧 id；
- 请求的 `after` 早于可用 ring 范围、晚于 `latest_seq`、跨进程重启或上游发生不可回放断流/协议错误时先发对应 `stream.gap`；
- gap 后客户端清空临时 delta、GET run/messages，但连接可继续接收新事件；
- 每 run 最多 5 个浏览器连接，全局最多 20；
- route 绝不新建第二个 Hermes upstream events consumer。

### `POST /api/v1/runs/{local_run_id}/stop`

请求 `{}`。只允许 item/run 仍为 `accepted`、已有 Hermes run id，且上游尚未本地确认 terminal。事务 CAS 成功后先设置 conversation `pause_reason=user_stopped`，再调用 Hermes stop；若已经 `reconciling|reconciled`，不新增 pause 并返回 `STATE_CONFLICT`。返回 `202` RunSnapshot。重复 stop 在仍 `stopping` 时返回当前 snapshot，不重复调用；stop HTTP 响应不得覆盖 coordinator 已并发收敛出的 terminal 状态。

### `POST /api/v1/runs/{local_run_id}/approval`

```json
{"choice":"once|deny","request_id":"可选但若 snapshot 有值则必须精确匹配"}
```

只允许当前 `waiting_for_approval`，choice 必须存在于当前批准投影。返回 `202` 更新后的 RunSnapshot。过期/重复为 `APPROVAL_NOT_PENDING`。

### `POST /api/v1/runs/{local_run_id}/reconcile`

请求 `{}`。只启动或唤醒一次受 coordinator lease/fencing 保护的 GET status/messages 对账，绝不提交/重放输入：

- `local_state=reconciling`：唤醒现有 active recovery，由持 lease coordinator 继续；
- `local_state=review_required` 且 `hermes_run_id` 非空：要求 conversation 仍 paused、全局无其他 active item，取得 global + conversation lease 后重新核对；若读到 non-terminal，可安全恢复为 accepted 监控；若读到 terminal，收敛为 done/paused；completed 收敛后 pause reason 改为 `manual_resume_required`，不会自动发送后续队列；
- `review_required` 但无 Hermes run id，或 QueueItem 已是 `paused`：返回 `STATE_CONFLICT`，只允许复制/丢弃恢复正文。

返回 `202` 最新 RunSnapshot 与 QueueItem。任一状态 CAS/fencing 失败都丢弃本次网络结果，不覆盖新状态。

不存在 run retry、steer 或 OpenAI-compatible route。

## 8. Preferences API

### `GET /api/v1/preferences`

```json
{
  "object":"emu_chat.preferences",
  "theme":"system|light|dark",
  "sidebar_width":320,
  "send_shortcut":"enter|mod_enter",
  "revision":0
}
```

### `PUT /api/v1/preferences`

请求包含完整偏好和 `expected_revision`。sidebar width 240–520。CAS 更新并返回 revision + 1。不得加入 Hermes URL/key、认证或 transcript 设置。

## 9. API 禁止清单

- 不暴露 Hermes Bearer、base URL 或任意 upstream proxy；
- 不提供 archive/restore/hide、全文搜索、附件、notification、voice、steer；
- 不提供 messages/tool events 的本地历史 route；
- 不提供带已有 run id 的 retry/replay；
- 不让浏览器传 `idempotency_key`、`hermes_run_id` 或 `X-Hermes-Session-Key`；这些由后端控制。
