# API Reference (emu-chat-v1)

本文档是 emu-chat 项目的 API 参考指南。

## 基础信息
- **基准路径**: `/api/v1`

## 统一错误响应格式
所有 API 在发生错误时均返回统一的 `ApiErrorEnvelope` 格式：

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human readable message",
    "retryable": true,
    "action": "retry",
    "details": {}
  },
  "requestId": "req-123456"
}
```

## 按功能分组端点

### 1. 系统状态
- **GET `/status`**
  - **描述**: 获取系统状态
  - **OperationId**: `getSystemStatus`
  - **响应**: `SystemStatusSchema` (200 OK)
- **POST `/status/recheck`**
  - **描述**: 重新检查系统状态并尝试重连
  - **OperationId**: `recheckSystemStatus`
  - **响应**: `SystemStatusSchema` (200 OK)

### 2. 会话管理
- **GET `/conversations`**
  - **描述**: 列出所有会话
  - **参数**: 分页参数等
  - **响应**: `ConversationListSchema` (200 OK)
- **POST `/conversations`**
  - **描述**: 创建新会话
  - **请求体**: `CreateConversationSchema`
  - **响应**: `ConversationSchema` (201 Created)
- **GET `/conversations/:id`**
  - **描述**: 获取会话详情
  - **响应**: `ConversationSchema` (200 OK)
- **GET `/conversations/:id/messages`**
  - **描述**: 获取会话消息列表
  - **响应**: `MessageListSchema` (200 OK)
- **POST `/conversations/:id/messages`**
  - **描述**: 向会话发送新消息
  - **请求体**: `SendMessageSchema`
  - **响应**: `MessageSchema` (201 Created)
- **POST `/conversations/:id/reset`**
  - **描述**: 重置会话上下文
  - **响应**: 204 No Content
- **POST `/conversations/:id/fork`**
  - **描述**: 分支当前会话
  - **请求体**: `ForkConversationSchema`
  - **响应**: `ConversationSchema` (201 Created)
- **PATCH `/conversations/:id/hermes-metadata`**
  - **描述**: 更新 Hermes 元数据
  - **请求体**: `UpdateHermesMetadataSchema`
  - **响应**: 204 No Content
- **PATCH `/conversations/:id/local-metadata`**
  - **描述**: 更新本地元数据
  - **请求体**: `UpdateLocalMetadataSchema`
  - **响应**: 204 No Content
- **POST `/conversations/:id/delete`**
  - **描述**: 删除会话
  - **响应**: 204 No Content

### 3. 草稿
- **GET `/conversations/:id/draft`**
  - **描述**: 获取会话草稿
  - **响应**: `DraftSchema` (200 OK)
- **PUT `/conversations/:id/draft`**
  - **描述**: 更新会话草稿
  - **请求体**: `DraftSchema`
  - **响应**: 204 No Content

### 4. 队列
- **GET `/conversations/:id/queue`**
  - **描述**: 获取会话队列状态
  - **响应**: `QueueStateSchema` (200 OK)
- **POST `/conversations/:id/queue/resume`**
  - **描述**: 恢复队列执行
  - **响应**: 204 No Content
- **PATCH `/queue-items/:id`**
  - **描述**: 修改队列项
  - **请求体**: `UpdateQueueItemSchema`
  - **响应**: `QueueItemSchema` (200 OK)
- **POST `/queue-items/:id/cancel`**
  - **描述**: 取消队列项
  - **响应**: 204 No Content
- **POST `/queue-items/:id/copy-to-draft`**
  - **描述**: 将队列项复制到草稿
  - **响应**: 204 No Content
- **POST `/queue-items/:id/discard-recovery`**
  - **描述**: 丢弃恢复数据
  - **响应**: 204 No Content

### 5. 运行控制
- **GET `/runs/:id`**
  - **描述**: 获取运行状态
  - **响应**: `RunSchema` (200 OK)
- **GET `/runs/:id/events`**
  - **描述**: 订阅运行事件流 (SSE)
  - **参数**: `after` (Last-Event-ID)
  - **响应**: SSE 响应流
- **POST `/runs/:id/stop`**
  - **描述**: 停止当前运行
  - **响应**: 204 No Content
- **POST `/runs/:id/approval`**
  - **描述**: 提交审批决策
  - **请求体**: `ApprovalSchema`
  - **响应**: 204 No Content
- **POST `/runs/:id/reconcile`**
  - **描述**: 强制协调运行状态
  - **响应**: 204 No Content

### 6. 偏好设置
- **GET `/preferences`**
  - **描述**: 获取用户偏好设置
  - **响应**: `PreferencesSchema` (200 OK)
- **PUT `/preferences`**
  - **描述**: 更新偏好设置
  - **请求体**: `PreferencesSchema`
  - **响应**: 204 No Content

## SSE 事件流协议说明

SSE 接口返回标准 Server-Sent Events 流，支持以下三种事件类型：

1. **`stream.ready`**
   - 连接成功并准备好发送事件时触发。
2. **`run.event`**
   - 运行过程中的各类事件载荷，包含消息块、状态更新、审批请求等。
3. **`stream.gap`**
   - 用于通知客户端事件流出现断档，需要采取补救措施。

客户端可通过 `Last-Event-ID` 请求头或 `after` 查询参数传递最后接收到的事件 ID，以便在断线后恢复事件流。
