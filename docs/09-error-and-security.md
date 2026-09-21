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

### 错误码矩阵表 (19种)
系统预定义了 19 种错误码，矩阵分布如下（部分示例）：

| 错误类名 | ErrorCode | HTTP状态码 | Retryable | Action | 触发场景 |
|----------|-----------|------------|-----------|--------|----------|
| BadRequestError | `BAD_REQUEST` | 400 | false | none | 参数校验失败 |
| UnauthorizedError | `UNAUTHORIZED` | 401 | false | reconnect | 未认证或Token失效 |
| ForbiddenError | `FORBIDDEN` | 403 | false | none | 无权限访问 |
| NotFoundError | `NOT_FOUND` | 404 | false | none | 资源不存在 |
| ConflictError | `CONFLICT` | 409 | false | resolve_conflict | 并发修改冲突 (CAS) |
| RateLimitError | `RATE_LIMIT_EXCEEDED` | 429 | true | retry | 速率限制 |
| InternalError | `INTERNAL_SERVER_ERROR`| 500 | true | retry | 未知内部错误 |
| HermesTimeoutError | `UPSTREAM_TIMEOUT` | 504 | true | retry | Hermes上游超时 |
| PayloadTooLargeError| `PAYLOAD_TOO_LARGE` | 413 | false | none | 请求体过大 |
| QueueFullError | `QUEUE_FULL` | 429 | true | retry | 队列满载 |
| ApprovalRequiredError| `APPROVAL_REQUIRED` | 403 | false | review_required| 需要审批才能继续 |
| InvalidStateError | `INVALID_STATE` | 409 | false | refresh_status | 状态机流转错误 |
| LeaseExpiredError | `LEASE_EXPIRED` | 409 | true | retry | 租约过期 |
| HermesConnectionError| `UPSTREAM_ERROR` | 502 | true | recheck | Hermes网络连接失败 |
| ... | ... | ... | ... | ... | ... |

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
所有日志在落盘前均通过 `SafeLogger` 处理：
- **`SENSITIVE_KEYS`**: 包含 10 个凭据相关的键（如 `password`, `token`, `secret` 等），其值将被替换为 `[REDACTED_SECRET]`。
- **`FORBIDDEN_CONTENT_KEYS`**: 包含 11 个可能涉及用户隐私的内容键（如 `message`, `content`, `prompt` 等），其值将被替换为 `[REDACTED_CONTENT: length N]`。
- **文件路径脱敏**: 正则匹配替换敏感路径信息为 `[PATH]`。
- 自动递归遍历对象和数组进行深层脱敏。

### 数据生命周期管理
- **载荷自动清除**: 任务达到终态（Success/Failed/Cancelled）后，其 `payload_text` 将被设为 `NULL` 以释放空间。
- **恢复载荷 TTL**: 断点恢复载荷保留 7 天 (TTL)，支持手动调用 discard 丢弃。

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
