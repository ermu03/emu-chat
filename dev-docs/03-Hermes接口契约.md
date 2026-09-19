# Hermes 接口契约

状态：MVP 已批准实现基线
更新时间：2026-09-19
适用上游：Hermes `0.21.3`，运行 commit `6005aa1`

## 1. 唯一上游

emu-chat 只依赖 Hermes Gateway API Server `http://127.0.0.1:8642`。源码中 Dashboard/FastAPI 的搜索、timeline、export 等路由不是该端口契约，禁止调用。

所有受保护请求由 emu-chat 后端添加：

```http
Authorization: Bearer <API_SERVER_KEY>
```

Bearer 只从服务端环境读取，不进入浏览器、SQLite、日志或错误包。MVP 任何请求都不发送 `X-Hermes-Session-Key`。

## 2. 启动与健康探测

探测顺序：

1. `GET /health`：进程可达性与版本摘要；
2. `GET /v1/capabilities`：协议能力；
3. 只有删除门禁需要时，后端内部调用 `GET /health/detailed`；
4. `GET /v1/models` 不是聊天启动前置，只可用于未来只读模型信息。

MVP 必需能力：session list/detail/messages/create/update/fork/delete，以及 run submit/status/events/stop/approval、durable idempotency。任何必需能力缺失都进入 `incompatible`，禁止试探性调用其他端点或 fallback。

已核实的关键能力：

```text
runtime.mode = server_agent
tool_execution = server
runs idempotency durable = true
runs idempotency retention = 86400 seconds
run events = SSE, no public replay cursor
session continuity header = X-Hermes-Session-Id
session key header = X-Hermes-Session-Key（MVP 禁用）
cors = false
```

工具运行在 Hermes 主机，不是浏览器沙箱。

## 3. Session 只读 API

### 3.1 顶层列表

```http
GET /api/sessions?limit=<0..200>&offset=<n>&source=api_server
GET /api/sessions?limit=<0..200>&offset=<n>&source=api_server&title=<exact-title>
```

MVP 固定 `source=api_server`。handler 默认 `include_children=false`，emu-chat 不增加 children 参数，因此 delegate/compression children 不成为顶层项。底层默认排除 archived，且该 route 没有归档筛选；MVP 不做归档 UI。

响应必须是：

```json
{
  "object": "list",
  "data": [{
    "id": "session-id",
    "source": "api_server",
    "title": "title",
    "message_count": 2,
    "parent_session_id": null,
    "last_active": 0,
    "preview": "...",
    "pinned": false,
    "archived": false,
    "hidden": false
  }],
  "limit": 50,
  "offset": 0,
  "has_more": false
}
```

Adapter 只投影批准字段；不得假设 Dashboard 的 `sessions` 键。`title` 是 exact-title 上游查询，不是消息全文搜索。

精确 ID 搜索通过 `GET /api/sessions/{session_id}` 完成。404 表示没有匹配；不得枚举本地历史副本。

### 3.2 Detail

```http
GET /api/sessions/{session_id}
```

只读取 Hermes 安全 session 字段。返回 id 与请求映射不一致属于协议错误。外部客户端可能改 title/pinned/hidden；每次详情读取均以 Hermes 为准。

### 3.3 Messages

```http
GET /api/sessions/{session_id}/messages?limit=<0..500>&offset=<n>&order=oldest|latest
```

响应：

```json
{
  "object": "list",
  "session_id": "effective-resumable-id",
  "data": [{
    "id": 1,
    "session_id": "effective-resumable-id",
    "role": "user|assistant|tool|system",
    "content": "...",
    "tool_call_id": "...",
    "tool_calls": [],
    "tool_name": "...",
    "timestamp": 0,
    "token_count": 0,
    "finish_reason": "stop",
    "reasoning": "...",
    "reasoning_content": "...",
    "display_kind": "..."
  }],
  "pagination": {
    "limit": 100,
    "offset": 0,
    "order": "oldest",
    "returned": 1
  }
}
```

只允许上述 message 字段。allowlist 不表示 content/tool arguments 已脱敏：UI 仍按不可信、可能敏感的文本渲染，日志不得记录正文。

该 endpoint 先解析 resumable tip，顶层 `session_id` 可能与请求 id 不同；后端验证可读后事务更新本地引用。它只被视为当前 effective segment，不能宣称含有所有 compression 历史。禁止遍历 `parent_session_id` 拼接。

messages 是 MVP 唯一历史工作流投影：只展示已持久化消息中的有限 tool/reasoning 字段。当前没有 session 历史 run、完整 workflow、subagent tree 或 checklist endpoint。

## 4. Session 变更 API

### 4.1 创建

```http
POST /api/sessions
Content-Type: application/json

{"title":"可选标题"}
```

MVP 只发送经本契约允许的 title；不发送 system prompt、model/provider/model_options 或自造 profile 字段。成功必须为 `201` 且包含可验证的 Hermes session id。先取得上游成功，再建立本地引用；本地失败进入对账，不重复创建空 session。

### 4.2 修改 title/pinned

```http
PATCH /api/sessions/{session_id}

{"title":"新标题"}
```

或：

```json
{"pinned":true}
```

一个请求只修改一个批准字段；未知字段拒绝。成功后重新 GET detail，不用请求体乐观伪造上游状态。

Hermes 的 pinned 更新按 compression lineage 生效，且 pin 可能清除 hidden；UI 必须在置顶操作说明中提示“可能影响该压缩链的 Hermes 元数据”。MVP 不 PATCH hidden/archived/unread/end_reason。

### 4.3 分支

```http
POST /api/sessions/{session_id}/fork
```

可发送批准的可选 title。成功后以 Hermes 返回 id 建立新的 conversation；不复制 messages、queue 或事件。父 conversation 保持不变。

### 4.4 删除

```http
DELETE /api/sessions/{session_id}
```

实际语义：删除目标 segment 和 delegate children；branch/compression children 不级联，可能 orphan。不存在通常返回 404，不代表幂等成功。

Hermes DELETE 没有 session-scoped active-run 原子保护。emu-chat 必须先执行本地 run 检查及 `/health/detailed.active_agents == 0` 的保守门禁；若请求超时或返回未确认 404，不清本地引用。只有成功或随后 detail GET 明确 404 才能本地收尾。

## 5. Run 主通道

### 5.1 提交

```http
POST /v1/runs
Authorization: Bearer ...
Idempotency-Key: ec_<stable-random-operation-id>
Content-Type: application/json

{
  "session_id": "current-hermes-session-id",
  "input": "one new user input"
}
```

禁止发送完整历史、`X-Hermes-Session-Key`、未批准的 model/provider/instructions/options。key 必须在 Hermes 限制内（1–255 可见 ASCII），同一 operation 永不变化。

成功：

```json
{"run_id":"run_...","status":"started","replayed":false}
```

响应中的 `status="started"` 只是 admission acknowledgement，不属于 run status 枚举，也不得写入 `runs.upstream_status`；该字段在第一次有效 status/event 到达前保持 NULL。

- 相同 key + 相同 body 返回同一 run，可能 `replayed=true`；
- 相同 key + 不同 body 返回 409；
- 202 早于 Agent worker 中的用户消息持久化，因此不证明 input 已写入 transcript；
- Hermes durable idempotency 只保留 fingerprint/run/status，不保留 request body。

emu-chat 在取得 `run_id` 后必须持久化映射并只读恢复；绝不再次提交原输入。只有仍无 run id、仍在 86400 秒期限且保有完全相同 body/session/key 的 admission 歧义才可有界重试。

### 5.2 Status

```http
GET /v1/runs/{run_id}
```

保留上游 status：`queued|running|waiting_for_approval|stopping|completed|failed|cancelled|interrupted`。`partial`、`turn_exit_reason`、`pending_steer` 是附加字段，不是 status。

`interrupted` 可能仅在重启后的 status 中出现，不等待 `run.interrupted` SSE。已有 run id 的 404 进入人工复核，不触发输入重发。

### 5.3 Events

```http
GET /v1/runs/{run_id}/events
Accept: text/event-stream
```

当前 transport 无 replay cursor，且底层队列不是广播。每个 run 只能由 emu-chat 建立一个上游订阅；浏览器不得直接订阅或促使创建第二条上游连接。

已支持的事件投影：

| 上游事件 | MVP UI |
| --- | --- |
| `message.delta` | 临时 assistant 文本 |
| `tool.started` | 通用工具运行中 |
| `tool.completed` | 完成/失败与安全 preview |
| `reasoning.available` | 可折叠临时 reasoning |
| `subagent.start/complete` | 活动期子 Agent 摘要 |
| `approval.request` | 等待确认卡片 |
| `run.completed/failed/cancelled` | 触发 status/messages 对账 |

合法 envelope 中的未知事件名忽略并计数；非法 JSON、缺失必需 envelope 或已声明字段类型破坏为 `HERMES_PROTOCOL_ERROR`。事件中的 command、args、preview 始终按不可信文本处理。

`todo_list` 仅按普通 tool 事件显示。preview 可能截断，禁止解析为 checklist snapshot。

### 5.4 Stop

```http
POST /v1/runs/{run_id}/stop
```

返回 `stopping` 只代表请求接纳。完成由 SSE 或后续 status 的终态确定；无论最终 cancelled/failed/completed，用户主动 stop 后 conversation queue 都保持暂停，等待明确继续。

### 5.5 Approval

```http
POST /v1/runs/{run_id}/approval
Content-Type: application/json

{"choice":"once|deny","request_id":"事件提供时原样返回"}
```

- UI 只显示上游 `approval.request.choices` 中与 `once|deny` 的交集；
- 不发送 `session`、`always`、`resolve_all`；
- 不自动批准；
- 409 `approval_not_pending` 等竞态映射为冲突并刷新 status；
- request id 最大 256 字符，只能来自当前 run 的待处理事件。

## 6. 明确排除的 Hermes 路径

- `/v1/chat/completions` 和 `/v1/responses`：Hermes 自身兼容能力，不是 emu-chat MVP UI 路径；
- `/api/sessions/{id}/chat/stream`：不作为 fallback；
- Dashboard search/timeline/export：不是 8642 契约；
- archive/restore：当前 list 不能可靠发现 archived sessions，MVP 不调用；
- steer、artifacts、browser-control：不在 MVP。

`/v1/runs` 是 Hermes 自定义接口，emu-chat 不对外声称 OpenAI compatibility。

## 7. 错误映射

| 上游情况 | emu-chat code | 自动动作 |
| --- | --- | --- |
| 超时/连接失败 | `HERMES_UNAVAILABLE` | 读请求可重试；run admission 按有无 run id 的规则恢复 |
| 401/403 | `HERMES_AUTH_FAILED` | 停止 mutation，提示检查服务端配置 |
| session/run 404 | `HERMES_NOT_FOUND` | 重新对账；run 不重发；delete 需独立确认 |
| 409 | `HERMES_CONFLICT` | 读请求/普通 mutation 刷新状态；run admission fingerprint 冲突进入本地 `review_required`，禁止换 key/body/session 重试 |
| 429/5xx | `HERMES_TEMPORARY_FAILURE` | 有界退避；保留草稿/队列/恢复正文 |
| 非法契约 | `HERMES_PROTOCOL_ERROR` | 标记 incompatible/degraded，不猜字段 |

上游错误正文只能进入脱敏诊断；浏览器接收稳定安全文案。
