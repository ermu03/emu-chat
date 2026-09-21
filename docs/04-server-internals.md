# Server Internals

本文档详细介绍了 Emu-Chat 服务端的内部实现，包括各层业务服务（Services）的设计以及核心系统引擎（Coordinator & SSE Hub）的工作原理。

## 业务服务层

### ConversationService
提供会话级别的生命周期管理与数据操作。

- **listConversations**: 负责遍历本地数据库，与上游 Hermes 同步状态，并通过 `removeMissingLocalConversation` 清理在本地存在但上游已不存在的孤儿会话。
- **getMessages**: 处理消息的读取请求，并在发现会话 ID 不一致时执行 Session ID 自愈（`adoptEffectiveHermesSessionId`）。
- **两阶段安全删除算法**:
  1. **前置断言**: 确保会话可以被删除。
  2. **本地标记 pending**: 在本地数据库将状态置为 `pending`。
  3. **全局防死锁 active_agents 检查**: 检查当前是否有活跃的 agent 正在使用此会话。
  4. **上游删除**: 调用 Hermes 接口实际删除。
  5. **本地物理清理/标记 failed**: 删除成功则在本地物理移除，否则回退并标记为 `failed`。
- **fork/reset 操作流程**: 建立会话快照，派生新会话或重置当前会话历史。

```mermaid
stateDiagram-v2
    [*] --> Pending : 开始删除
    Pending --> ActiveAgentsCheck : 本地标记 pending
    ActiveAgentsCheck --> UpstreamDelete : 无活跃 agent
    ActiveAgentsCheck --> Failed : 检查失败
    UpstreamDelete --> LocalCleanup : 删除成功
    UpstreamDelete --> Failed : 上游报错
    LocalCleanup --> [*]
    Failed --> [*]
```

### DraftPreferencesService
负责管理草稿和用户偏好。
- **UTF-8字节级校验**: 采用 `TextEncoder` 确保草稿内容不超过长度限制。
- **乐观锁保存**: 避免并发写入造成的草稿覆盖。
- **DraftConflictError**: 冲突时抛出相应错误。
- **偏好设置校验**: 对主题枚举、侧边栏宽度范围以及快捷键枚举进行严格校验。

### QueueRunService
负责运行队列和消息投递。
- **sendMessage 原子入队算法**:
  1. 重放检查及 Hermes 就绪断言。
  2. 即时事务开始：二次重放验证，检查删除中状态，确保草稿非空并进行字节校验。
  3. 计算队列深度限制与 FIFO 序号。
  4. 生成 SHA256 哈希防重防篡改。
  5. 插入 `queue_item`。
  6. 清空草稿并令 `revision++`。
  7. 唤醒协调器（AdmissionCoordinator）。
- **stopRun / submitApproval 流程**: 提供终止当前运行或提交人工审批的能力。
- **故障载荷恢复**: 
  - `copyToDraft`: 检查 TTL、设置 `overwrite_nonempty` 参数将队列中失败或中断的任务内容写回草稿箱。
  - `discardRecovery`: 丢弃不再需要的恢复载荷。

```mermaid
sequenceDiagram
    participant C as Client
    participant QRS as QueueRunService
    participant DB as Database
    participant Coord as AdmissionCoordinator
    
    C->>QRS: sendMessage()
    QRS->>QRS: 重放检查 & Hermes 就绪断言
    QRS->>DB: 开始即时事务
    DB-->>QRS: 二次验证，草稿校验
    QRS->>DB: 插入 queue_item, revision++, 清空草稿
    DB-->>QRS: 提交事务
    QRS->>Coord: 唤醒协调器
```

### StatusService
- **TTL缓存**: 数据默认在本地缓存 5 秒。
- **Promise单飞复用 (Single-Flight)**: 相同参数的并发请求复用同一个 Promise 避免击穿。
- **探测分流**: 基于后端健康状况决定前端探测策略。

## 核心引擎

### AdmissionCoordinator 准入协调器
负责从队列中拉取任务，派发至外部系统（Hermes）。
- **实例标识**: `ownerId` 基于 `inst_<pid>_<random>` 生成，区分不同节点。
- **启动与崩溃恢复**: 异常后标记 `events_truncated` 并广播 `process_restarted` gap，防止客户端遗漏状态。
- **tick() 2秒轮询循环**:
  执行 `heartbeatLeases`，检查活跃项，调用 `recoverRun` 或 `findNextGlobalQueued` 寻找可用任务进行 `dispatch`。
- **dispatch 双重租约算法**:
  先后获取**全局租约**与**会话租约**，进行二次校验。成功后状态更新为 `dispatching`，插入 Run 数据并启动 `submit`。
- **submit 提交流程**:
  尝试执行 `startRun`，成功则标记为 `accepted` 并进入 `consume` 流程；失败则标记为 `rejected` 且暂停对应队列。
- **consume SSE消费转发循环**: 建立上游长连接并持续接收结果。
- **reconcileById 权威对账算法**:
  1. 拉取上游最新状态，确认是否为终态。
  2. 验证消息是否可读。
  3. 分支判定：完全成功则标记 `done`；部分成功/失败进入 `paused` 状态，并拥有 7 天恢复窗口；验证失败触发 `review_required`。
- **租约释放与SSE延迟清理**: 安全退出的重要环节，避免僵尸进程和内存泄漏。

### SSEHub 事件广播中枢
负责向前端或下游推送实时事件流。
- **数据结构**: `clients` Map，以及 `streams` Map (存储 `events[]`, `latest_seq`, `dropped_before`, `latest_gap`)。
- **subscribe 订阅流程**:
  检查连接数上限，写入 SSE 响应头。使用 `stream.ready` 控制初始化事件，并在客户端携带的 seq 落后时进行断档与重放判定（`replayGap`）。
- **storeRunEvent 环形缓冲驱逐算法**:
  每个流维持最大 512 条或 1MiB 内存占用。超限时执行 `shift` 淘汰，产生 `buffer_evicted` gap。
- **publishGap 断档通知**: 当发现缺失事件时主动通知客户端。
- **scheduleCleanup 60秒延迟清理**: 对无消费者的 stream 使用 `unref` 定时器执行 60 秒倒计时销毁。
- **心跳保活**: 每 15 秒向空闲连接发送 heartbeat，防止被网关切断。

```mermaid
flowchart TD
    Sub["subscribe()"] --> CheckLimits["连接数检查"]
    CheckLimits --> WriteHeader["写 SSE Header"]
    WriteHeader --> StreamReady["等待 stream.ready"]
    StreamReady --> ReplayCheck["断档与重放判定 (replayGap)"]
    ReplayCheck --> ListenEvents["监听实时事件"]
```
