# Emu Chat 数据流图

本文档通过 Mermaid 序列图详细描述了 Emu Chat 的核心业务数据流转与异常处理流程。

## 1. 消息发送完整流程（Primary 消息 vs Follow-up 消息）

无论是发送 Primary（主干）消息，还是后续追加的 Follow-up 消息，前后端协同的整体数据流如下：

```mermaid
sequenceDiagram
    participant UI as 前端 (AppShell/Composer)
    participant Draft as 草稿/视图状态
    participant API as 后端 API
    participant Coord as 协调器 (Coordinator)
    participant SSE as SSE 通道

    UI->>UI: 判断 Primary / Follow-up，生成 UUID
    UI->>Draft: 乐观渲染 PendingUserRow
    UI->>Draft: 强制 flush 草稿
    UI->>API: apiClient.sendMessage (发送消息)
    UI->>Draft: 刷新本地队列 (乐观锁)
    
    API->>API: 幂等检查
    API->>API: 检查 Hermes 就绪状态
    API->>API: 即时事务: 写入 Queue + 清空该会话 Draft
    API->>Coord: 唤醒协调器 (Waker)
    API-->>UI: 返回成功响应 (含 enqueue 信息)

    Coord->>Coord: tick (执行心跳)
    Coord->>Coord: 获取双重租约 (Lease)
    Coord->>Coord: dispatch ()
    Coord->>Coord: submit (startRun)
    Coord->>Coord: consume (streamEvents)
    Coord->>Coord: handleEvent & reconcileById

    Coord->>SSE: 推送 stream.ready
    Coord->>SSE: 推送 run.event (携带 message.delta)
    SSE-->>UI: useStreamEvents 接收 run.event，增量拼接
    Coord->>SSE: 推送 run.reconciled (Run 完成)
    SSE-->>UI: 全量拉取最新消息替换流式占位内容
```

## 2. 工具审批流程

当后台 Agent 需要调用高危或受限工具时，将触发审批交互：

```mermaid
sequenceDiagram
    participant Agent as 上游 Agent
    participant Backend as 后端 Server
    participant SSE as 前端 SSE Hook
    participant Dialog as ApprovalDialog

    Agent->>Backend: 请求工具审批
    Backend->>SSE: 推送 waiting_for_approval 事件
    SSE->>Dialog: 挂起队列，弹出审批弹窗
    Dialog->>Dialog: 用户选择 once / deny / stop
    Dialog->>Backend: apiClient.submitApproval(action)
    Backend->>Backend: 校验合法性并转发上游
    Backend-->>Dialog: 确认提交
    Backend->>SSE: 恢复执行，继续推送后续事件 (或标记为终态)
```

## 3. 会话切换与 LRU 秒开机制

客户端为了保证切换的极速体验，采用了 LRU 缓存：

```mermaid
sequenceDiagram
    participant User as 用户
    participant AppShell as 前端 AppShell
    participant Cache as ConversationViewCache
    participant API as 后端 API

    User->>AppShell: 点击会话 B (离开会话 A)
    AppShell->>Cache: 抓取会话 A 的当前视图快照存入 LRU (容量12)
    AppShell->>Cache: 尝试读取会话 B 快照
    
    alt 缓存命中
        Cache-->>AppShell: 返回会话 B 缓存数据
        AppShell->>AppShell: 瞬间渲染 (秒开)
    else 缓存未命中
        Cache-->>AppShell: 空
        AppShell->>AppShell: 保留会话 A 快照，标题仍显示 A
        AppShell->>AppShell: 标明正在加载 B，并禁用会话级操作
    end

    AppShell->>API: activeLoadRef 开启保护，并发拉取会话详情、消息、草稿、队列
    API-->>AppShell: 消息请求先完成
    AppShell->>AppShell: 校验请求代数；立即切换消息视图到 B
    API-->>AppShell: 详情、草稿和队列分别返回
    AppShell->>AppShell: 各自数据就绪后开放对应会话操作
    alt 目标消息加载失败
        AppShell->>AppShell: 保留当前快照并显示重试入口
    end
```

首次打开且没有可保留的旧视图时，消息区显示加载状态。缓存命中时先恢复快照，再后台刷新目标会话。

## 4. 草稿同步流程

为防止用户输入丢失，客户端会自动同步草稿状态：

```mermaid
sequenceDiagram
    participant Composer as DraftComposer
    participant API as 后端 (saveDraft)

    Composer->>Composer: 用户输入触发 onChange
    Composer->>Composer: 500ms 防抖等待
    Composer->>Composer: 触发 flushDraft (单飞锁，排队保存直至一致)
    Composer->>API: 发起 saveDraft (附带乐观锁 Revision)
    API->>API: 冲突检测与保存
    API-->>Composer: 返回新的 revision (版本号)
    Composer->>Composer: 更新本地 revision，解锁单飞状态
```

## 5. 会话删除两阶段流程

为了保证分布式架构下的数据安全，删除动作分为本地标记和上游物理删除两步：

```mermaid
sequenceDiagram
    participant UI as ConversationList
    participant API as 后端 Server
    participant Upstream as 上游系统 (Hermes)

    UI->>UI: 弹窗 + 强制勾选确认
    UI->>API: 请求删除会话 (ID)
    
    API->>API: 断言 (confirmed=true, session_id匹配, 无活跃Run)
    API->>API: 本地数据库标记 status = 'pending_deletion'
    API->>Upstream: 检查 active_agents == 0
    Upstream-->>API: 确认安全
    API->>Upstream: 发送 deleteSession 指令
    
    alt 删除成功
        Upstream-->>API: Success
        API->>API: 物理删除记录 / 触发 SSE 清理
        API-->>UI: 返回删除成功
    else 删除失败 (如超时)
        Upstream-->>API: Error
        API->>API: 标记 status = 'failed'
        API-->>UI: 返回删除失败，提示重试
    end
```

## 6. 故障恢复流程

针对服务崩溃、断网等情况，提供完善的恢复机制：

```mermaid
flowchart TD
    Crash(进程崩溃/重启) --> MarkTruncate[启动时标记 events_truncated]
    MarkTruncate --> BroadGap[向所有连接广播 stream.gap: process_restarted]
    BroadGap --> ClientREST[客户端触发 REST 全量重拉替换]

    NetDrop(SSE 客户端断线) --> ExpBackoff[客户端指数退避重连 1s→15s]
    ExpBackoff --> SendCursor[带上 lastEventId （cursor） 发起连接]
    SendCursor --> ServerReplay{服务端检测 Cursor}
    ServerReplay -- Cursor 存在 --> Replay[回放遗漏的 RunEvents]
    ServerReplay -- Cursor 失效/过期 --> ReplyGap[发送 stream.gap 通知]
    ReplyGap --> ClientREST

    SubmitFail(后端向协调器提交 Run 失败) --> Rejected[标记 QueueItem 为 rejected]
    Rejected --> Paused[标记会话为 paused: submission_rejected]
    Paused --> UserAction{用户手动干预}
    UserAction -- Copy --> CopyDraft[拷贝到草稿 copyToDraft]
    UserAction -- Discard --> DiscardItem[丢弃该条目 discardRecovery]
```

## 7. SSE 事件流双轨容灾

在事件推送机制上，系统设计了双轨模型以防止卡死：

```mermaid
graph TD
    subgraph 客户端双轨机制
        SSE[主通道: useStreamEvents （实时低延迟）] 
        Poll[兜底通道: Fallback Polling]
    end

    SSE -->|正常接收| UI[更新界面]
    SSE -->|发生断线或断档| Gap[触发 stream.gap]
    Gap --> FullSync[触发全量 REST 刷新]
    
    Poll -->|判断有待派发项| FastPoll[300ms 快速轮询]
    Poll -->|判断有活跃 Run| SlowPoll[2500ms 兜底轮询]
    
    FastPoll --> UI
    SlowPoll --> UI
```
