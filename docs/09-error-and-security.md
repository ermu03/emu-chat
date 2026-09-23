# Error Handling and Security (emu-chat-v1)

## 错误处理体系

### `AppError` 基类设计
所有自定义错误继承自 `AppError` 基类，包含以下核心字段：
- **`code`**: 错误码（字符串）
- **`message`**: 人类可读信息
- **`statusCode`**: HTTP 状态码
- **`retryable`**: 是否可重试
- **`action`**: 建议前端采取的动作（`ErrorAction`）
- **`upstreamStatus`**: 上游状态码（可选）
- **`details`**: 附加详情（可选）

通过 `toEnvelope(requestId)` 方法可以将错误序列化为标准的 JSON 响应包 `ApiErrorEnvelope`。

### 全局错误拦截器
在 `app.ts` (`setErrorHandler`) 中配置了统一错误拦截，实现分流处理：
- **`AppError`**: 直接解析并返回
- **`ZodError`**: 转换为 400 Bad Request，提取校验详情
- **413 Payload Too Large**: 专门拦截大载荷错误
- **4xx 客户端错误**: 转换为相应的 AppError
- **5xx 服务端错误**: 隐蔽内部细节，统一转换为 500 内部服务器错误

### 错误码矩阵（共享枚举 19 项）

错误码由 [共享枚举](../src/shared/domain-enums.ts) 定义，HTTP 状态和动作由 [服务端错误类](../src/server/domain/errors.ts) 定义。当前错误类对应的错误码如下：

| 错误类名 | ErrorCode | HTTP 状态码 | Retryable | Action | 常见场景 |
|---|---|---:|---|---|---|
| `InvalidRequestError` | `INVALID_REQUEST` | 400 | false | none | 请求参数或载荷校验失败 |
| `PayloadTooLargeError` | `PAYLOAD_TOO_LARGE` | 413 | false | none | 请求体过大 |
| `LocalNotFoundError` | `LOCAL_NOT_FOUND` | 404 | false | refresh_status | 本地会话或资源不存在 |
| `HermesNotFoundError` | `HERMES_NOT_FOUND` | 404 | false | refresh_status | Hermes 上游资源不存在 |
| `DraftConflictError` | `DRAFT_CONFLICT` | 409 | false | resolve_conflict | 草稿 revision 冲突 |
| `LocalConflictError` | `LOCAL_CONFLICT` | 409 | false | refresh_status | 本地元数据等 revision 冲突 |
| `StateConflictError` | `STATE_CONFLICT` | 409 | false | refresh_status | 状态不允许当前操作；`QueueFullError` 继承此类，也返回此错误码 |
| `RunActiveError` | `RUN_ACTIVE` | 409 | false | refresh_status | 会话或系统已有活跃 Run |
| `ApprovalNotPendingError` | `APPROVAL_NOT_PENDING` | 409 | false | refresh_status | Run 当前没有待处理审批 |
| `HermesNotReadyError` | `HERMES_NOT_READY` | 503 | true | recheck | Hermes 尚未就绪 |
| `HermesAuthFailedError` | `HERMES_AUTH_FAILED` | 502 | false | none | Hermes 鉴权失败 |
| `HermesUnavailableError` | `HERMES_UNAVAILABLE` | 502 | true | reconnect | Hermes 不可用或连接失败 |
| `HermesConflictError` | `HERMES_CONFLICT` | 409 | false | refresh_status | Hermes 上游状态冲突 |
| `HermesTemporaryFailureError` | `HERMES_TEMPORARY_FAILURE` | 502 | true | retry | Hermes 暂时性故障 |
| `HermesProtocolError` | `HERMES_PROTOCOL_ERROR` | 502 | false | recheck | Hermes 响应不符合协议 |
| `HermesBusyGlobalError` | `HERMES_BUSY_GLOBAL` | 409 | true | retry | Hermes 正在运行另一个全局任务 |
| `DeleteUnconfirmedError` | `DELETE_UNCONFIRMED` | 503 | true | refresh_status | 无法确认上游会话已删除 |
| `InternalError` | `INTERNAL_ERROR` | 500 | false | none | 未知内部错误 |

共享枚举中的 `REVIEW_REQUIRED` 目前没有对应的 `AppError` 子类。`QueueFullError` 当前继承 `StateConflictError`，因此队列达到深度上限时返回 `STATE_CONFLICT`，而不是独立的 `QUEUE_FULL` 错误码。

### ErrorAction 前端建议动作
定义了 7 种 `ErrorAction` 供前端采取对应逻辑：
1. **`none`**: 无特定动作，展示错误信息即可
2. **`retry`**: 建议使用相同参数重试（如网络波动）
3. **`recheck`**: 建议重新检查系统状态（如后台恢复中）
4. **`refresh_status`**: 建议刷新资源状态（状态可能已更新）
5. **`resolve_conflict`**: 提示用户解决冲突（如编辑覆盖）
6. **`review_required`**: 提示用户去处理审批请求
7. **`reconnect`**: 建议重新连接或重新登录

---

## 安全与隐私设计

### 数据目录权限控制
文件系统操作强加了权限掩码：
- 目录权限：`0o700` (仅所有者可读写执行)
- 文件权限：`0o600` (仅所有者可读写)

### `SafeLogger` 日志脱敏系统
`SafeLogger` 在序列化日志前对 `meta.details` 做递归脱敏：
- **`SENSITIVE_KEYS`**: 包含 10 个凭据相关的键（如 `password`, `token`, `secret` 等），其值将被替换为 `[REDACTED_SECRET]`。
- **`FORBIDDEN_CONTENT_KEYS`**: 包含 11 个可能涉及用户隐私的内容键（如 `content`, `payload`, `text` 等）；字符串值替换为 `[REDACTED_CONTENT: length N]`，其他值替换为 `[REDACTED_CONTENT]`。
- **文件路径脱敏**: 正则匹配替换敏感路径信息为 `[PATH]`。
- 对象和数组最多深入 `details` 下 8 层；更深的容器替换为 `[MAX_DEPTH]`。当前递归路径上的循环引用替换为 `[CIRCULAR]`，独立分支间的重复引用仍分别脱敏。

日志的 `message` 和 `details` 以外的元数据字段不经过这段递归脱敏逻辑。

### 数据生命周期管理
- **载荷清除**: 队列项成功完成或取消时，`payload_text` 会设为 `NULL`；失败后的恢复载荷可由用户手动丢弃。
- **恢复载荷期限**: 系统会记录 7 天恢复期限，但目前未自动清除到期正文；待处理方案见[数据保留提案](../.agents/notes/proposed/bug-fix/2026-09-23-expire-recovery-and-terminal-control.md)。

### 请求安全性
- **API Key 隔离**: Hermes API Key 仅在服务端环境注入，前端绝不接触。
- **敏感头清理**: 代理转发时显式删除 `X-Hermes-Session-Key` 等潜在敏感头。
- **防 DoS**: 引入 `readBoundedText`，限制响应体最大为 4MiB。
- **SSE 防御**: 单帧 SSE 事件载荷限制最大为 256KiB。

---

## 系统限制常量全表

`LIMITS` 对象定义了系统各项阈值，确保系统稳定运行：

### 1. 输入限制 (Input)
- 消息最大长度
- 标题最大长度
- 元数据最大键值对数

### 2. 队列限制 (Queue)
- 队列最大深度
- 最大重试次数
- 并发任务数

### 3. 分页限制 (Pagination)
- 默认分页大小
- 最大分页大小

### 4. 并发租约 (Lease)
- 租约默认 TTL (ms)
- 租约刷新间隔 (ms)

### 5. 准入幂等 (Idempotency)
- 幂等键保留时长
- 最大允许重复提交时间窗口

### 6. 恢复生命周期 (Recovery)
- 断点恢复记录 TTL (7天)

### 7. SSE 事件环 (SSE Ring)
- 单帧最大字节数 (256KiB)
- 积压最大事件数 (缓冲池大小)

### 8. 上游超时 (Upstream)
- Liveness 超时时间 (ms)
- 读取响应超时时间 (ms)

### 9. UI 限制
- 连续滚动加载阈值
- 草稿防抖延迟时长 (ms)
