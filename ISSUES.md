# 前端已知问题清单与优化点总结
---

## BUG-1：长对话（120+ 条消息）Agent 回答丢失

### 现象

当一个会话的消息数达到 120+ 条后：
- Agent 正在生成回答时，前端界面时不时闪烁
- Agent 回答完成后，回答内容直接从界面消失

### 根因分析

**分页截断 + 流式内容清除的组合导致。**

1. **消息拉取硬编码为 100 条**：在 [`app.tsx` 第 276-278 行](src/client/app.tsx#L276-L278) 和 [第 451-453 行](src/client/app.tsx#L451-L453)，两处拉取消息的调用都写死了 `{ limit: 100, order: "oldest" }`：

   ```typescript
   // 初始加载（第 276 行）
   apiClient.listMessages(conversationId, { limit: 100, order: "oldest" })
   
   // 对账完成后刷新（第 451 行）— 这里是问题核心
   apiClient.listMessages(conversationId, { limit: 100, order: "oldest" })
   ```

   当对话超过 100 条时，**只取回最早的 100 条**，最新的消息（包括 Agent 刚生成的回答）被截断丢弃。

2. **对账流程同时清除流式内容**：在 [第 456-460 行](src/client/app.tsx#L456-L460)，对账完成后：
   ```typescript
   setMessages(messageResponse.items);        // ← 用截断的 100 条覆盖
   setStreamedAssistantContent("");            // ← 清除流式显示的内容
   streamedAssistantRunIdRef.current = null;   // ← 标记流式结束
   ```
   流式内容被清除，但持久化消息只有最早的 100 条，Agent 的新回答既不在 messages 里，流式内容也被清空 → **回答彻底消失**。

3. **流式过程中的闪烁**：SSE 每收到一个 token 就更新 `streamedAssistantContent` 状态，由于 `MessageRow` 组件 [没有用 `React.memo` 包裹](src/client/features/messages/message-view.tsx#L118)，每次状态变化都会触发**全部 120+ 条消息的 Markdown 重新解析和 DOM 重建**，造成严重的 UI 卡顿和闪烁。

### 解决方案

1. **修复分页逻辑**（修复丢失问题）：
   - 方案 A：改用 `order: "newest"` 拉取最新的消息，然后反转数组显示
   - 方案 B：实现分页循环拉取，直到 `has_more === false`
   - 方案 C（推荐）：对账时只增量拉取新消息（`offset: messages.length`），追加到现有消息数组末尾，而不是全量替换

2. **`MessageRow` 加 `React.memo`**（修复闪烁问题）：
   ```typescript
   const MessageRow = React.memo(function MessageRow({ message }: { message: MessageItem }) {
     // ...原有逻辑
   });
   ```
   这样流式更新时只有 `LiveAssistantRow` 会重新渲染，已有的 120 条消息不会被重复渲染。

---

## BUG-2：会话切换卡顿与闪烁

### 现象

- 点击切换到另一个会话时，界面先短暂变空白（显示"正在加载"），再加载出新内容
- 切换到消息较多的会话时明显卡顿
- 对比 ChatGPT/Gemini 等产品，切换是瞬时无闪烁的

### 根因分析

1. **状态粗暴清零**：在 [`app.tsx` 第 254-264 行](src/client/app.tsx#L254-L264)，当目标会话不在 LRU 缓存中时，立即将所有状态同步清空：
   ```typescript
   setActiveConversation(null);
   setMessages([]);           // ← 瞬间清空 → 界面变空白
   setDraft(null);
   setQueue(null);
   setActiveRun(null);
   setStreamedAssistantContent("");
   ```
   这导致当前会话内容立即消失，显示空白/加载状态，等网络请求返回后才渲染新会话 → 用户看到闪烁。

2. **缓存命中时也卡顿**：即使命中了 `ConversationViewCache`（LRU 容量 12），恢复快照时一次性渲染大量消息，由于 `MessageRow` 没有 `React.memo`，每条消息都会做完整的 Markdown 解析 → 主线程阻塞 → 界面卡顿。

### 解决方案

1. **保留旧视图直到新数据就绪**：切换时不要立即清空 `messages`，改为在新数据拉取完成后一次性替换，避免中间的空白闪烁。可以用 React `startTransition` 标记为低优先级更新。

2. **`MessageRow` 加 `React.memo`**：避免缓存恢复或数据替换时对每条消息做不必要的重新渲染。

3. **参考 ChatGPT/Gemini 的实现思路**：
   - 首次加载只渲染视口内可见的消息（虚拟滚动）
   - 使用骨架屏（skeleton）代替空白加载态
   - 会话列表和消息区域做分区过渡动画

---

## BUG-3：工具调用/思考过程的展示方式不合理

### 现象

- 每个工具调用（assistant 发起 + tool 返回结果）各占一个独立消息气泡
- 每个工具调用和结果都被单独计为一条"消息"
- 实际使用中，Agent 一次回答可能调用 5-10 个工具，产生 10-20 条"消息"，严重稀释了真正的对话内容

### 根因分析

在 [`message-display.ts` 第 3-9 行](src/client/features/messages/message-display.ts#L3-L9)，`getRenderableMessages` 只是做了简单的过滤（去掉空消息），**没有任何分组/聚合逻辑**：

```typescript
export function getRenderableMessages(messages: MessageItem[]): MessageItem[] {
  return messages.filter(
    (message) =>
      Boolean(message.content.trim()) ||
      Boolean(message.tool_name) ||
      Boolean(message.reasoning?.trim()),
  );
}
```

然后在 [`message-view.tsx` 第 102-104 行](src/client/features/messages/message-view.tsx#L102-L104) 直接扁平渲染：

```tsx
{renderableMessages.map((message) => (
  <MessageRow key={message.id} message={message} />
))}
```

每条工具消息都独立渲染为一个 `<article class="message-row">` 气泡。

### 解决方案

**引入消息分组机制**：将 assistant 的一次连续交互（思考 + 工具调用 + 工具结果 + 最终文本回复）聚合为一个"回合"（turn）。

1. **在 `message-display.ts` 中增加分组函数**：
   ```typescript
   interface MessageGroup {
     id: string;
     role: 'user' | 'assistant';
     // assistant 回合中包含的中间步骤
     toolCalls: { name: string; args: string; result: string }[];
     reasoning?: string;
     content: string;        // 最终文本回复
     timestamp: string;
   }
   
   export function groupMessages(messages: MessageItem[]): MessageGroup[] {
     // 将连续的 assistant + tool 消息合并为一个 group
     // user 消息单独成组
   }
   ```

2. **在 `MessageRow` 中渲染分组**：
   - 用户消息：普通气泡
   - 助手回合：一个气泡，内含：
     - 🔽 可折叠的"思考过程"区域（如有 reasoning）
     - 🔽 可折叠的"工具调用 (N)"区域，列出所有工具调用及结果
     - 最终文本回复（始终展开显示）

3. **参考效果**：类似 Claude/ChatGPT 的工具调用展示 — 工具调用折叠在助手消息内部，只显示最终回复，需要时点击展开查看中间过程。

---

## TASK-4：测试套件精简与瘦身（已完成）

原测试套件有 17 个测试文件、88 个用例、3118 行，包含静态 DOM、简单纯函数和重复的上游 HTTP 矩阵测试。现已按 `AGENTS.md` 收敛为 7 个文件、37 个用例、1232 行：

- 组件只保留删除勾选确认、发送失败保留草稿、旧保存 ACK 不覆盖新输入三个交互用例。
- 单元保留 CAS、FIFO、租约、Hermes 协议与能力评估、SSE 广播和重放等核心机制。
- 集成聚焦消息原子入队、派发、审批与终态对账；用共享数据库和 Fake Hermes 模拟服务重建后的 Run 恢复。删去了重复的会话和适配器矩阵。

现行范围与运行方式见 [测试策略](docs/10-testing.md)，取舍见 [决策笔记](.agents/notes/implemented/testing/2026-09-23-focus-test-suite-on-critical-behavior.md)。

---

## TASK-5：AppShell 单体解耦与瘦身（消除过大单体组件）

### 现状分析

当前 `src/client/app.tsx`（约 1290 行）承担了“上帝组件”（God Component）的角色，过度臃肿：
- **职责严重过载**：一个文件同时处理了会话路由解析、会话列表加载、单会话详情拉取、LRU 视图快照恢复、草稿同步、消息队列管理、大模型实时 SSE 流消费、Run 终态对账刷新、网络轮询兜底、以及各类弹窗控制。
- **状态交织复杂**：单个组件内声明了 18 个 `useState` 与 10 个 `useRef`，状态之间的依赖与同步链路极长（有 8 个 `useEffect`），阅读和修改时心智负担极重。
- **改动风险高**：任何细小功能的修改（如修改发消息逻辑）都需要在千行单体大文件里穿梭，极易产生非预期的副作用与代码冲突。

### 优化与重构计划

遵循 React 现代工程最佳实践，采用**自定义 Hook（Custom Hooks）**将业务逻辑切片拆离，将 `AppShell` 瘦身至 200 行以内的纯骨架/布局组件：

1. **提取会话切换与视图缓存 Hook（`useConversationView.ts`）**：
   - 负责加载当前会话（详情/消息/草稿/队列）。
   - 封装 `loadId` 递增防竞态逻辑与 `ConversationViewCache` 快照读写。
   - 产出：`activeConversation`, `messages`, `draft`, `queue`, `loadActiveConversation` 等。

2. **提取流式运行与对账 Hook（`useRunRuntime.ts`）**：
   - 封装 `useStreamEvents` 订阅与 `handleRunStreamEvent` 逻辑。
   - 管理大模型打字机流式增量文本（`streamedAssistantCache`）。
   - 封装终态自动对账与轮询保活逻辑（`refreshRuntime`）。
   - 产出：`activeRun`, `streamedAssistantContent`, `onStopGenerating`, `onReconcile` 等。

3. **提取消息发送与排队 Hook（`useMessageSend.ts`）**：
   - 负责点击发送消息的完整事务流程（强制 flush 草稿 $\rightarrow$ 生成 UUID $\rightarrow$ 插入 PendingUserRow $\rightarrow$ 调接口 $\rightarrow$ 刷新队列）。
   - 产出：`handleSendMessage`, `pendingSubmissions` 等。

4. **保持 `AppShell` 纯粹的骨架定位**：
   - 瘦身后 `AppShell` 仅负责声明式地调用上述 3 个 Hook，并将状态与回调作为 props 传递给各业务组件（`ConversationList`、`MessageView`、`DraftComposer` 等），彻底消除逻辑泥潭。


# other

## ISSUE-6：后端消息分页协议缺失 `has_more` 与 `total` 字段

### 现状分析

在后端消息接口与上游协议适配中，存在分页元数据丢失与硬编码问题：
- 在 [`src/server/hermes/adapter.ts` 第 144 行](src/server/hermes/adapter.ts#L144)，适配器在标准化上游消息列表时硬编码写死了 `has_more: false`。
- 在前后端共享契约 [`src/shared/api-schemas.ts` 第 208~216 行](src/shared/api-schemas.ts#L208-L216) 的 `MessageListResponseSchema` 中，仅定义了 `items, limit, offset, returned`，完全缺失了 `has_more` 和 `total`。
- 业务服务 [`src/server/services/conversation-service.ts` 第 132~139 行](src/server/services/conversation-service.ts#L132-L139) 也未向上透传上游的真实消息总量。

### 根因与影响

- 与前端 **BUG-1** 紧密关联。前端无法得知会话是否已全部拉取完毕；当会话消息超过 100 条时，前端无法判断是否存在下一页，默认误以为只有这 100 条消息，进而导致长对话中新回答被截断。

### 解决方案

1. 在 `MessageListResponseSchema` 中增补 `has_more: boolean` 与可选的 `total: number` 字段。
2. 在 `hermes/adapter.ts` 中根据上游真实的 `total` 或 `pagination` 动态计算 `has_more = (offset + returned < total)`。
3. 确保路由与服务层对 `order: "latest"` 的逆向分页支持完备，方便前端在打开会话时优先拉取最新的 N 条消息。

---

## TASK-7：全局单活跃 Run 并发模型约束与多槽位演进

### 现状分析

在数据库定义 [`migrations/0001_initial.sql` 第 87~90 行](migrations/0001_initial.sql#L87-L90) 中声明了一条全局唯一索引：
```sql
CREATE UNIQUE INDEX ux_queue_one_global_active 
ON queue_items ((1)) 
WHERE state IN ('dispatching', 'accepted', 'reconciling');
```
这意味着系统在数据库层做了强互斥：**整个应用在同一时刻全局只允许存在 1 个处于活跃执行态的 Run**。

### 影响与考量

- **现状合理性**：当前定位为“单用户本地工作台”，串行执行保证了 SQLite 状态机的绝对简单与外部 Hermes 调度的原子性。
- **业务局限**：若用户在会话 A 中触发了耗时较长的大模型生成任务，切换至会话 B 发送新问题时，会话 B 的消息将被强制排队等待，无法多任务并行。

### 改进计划

- 前期开发阶段保留单并发设计，优先保证状态机稳定。
- 中后期若需支持多任务并行，将全局单租约与唯一索引改造为基于**并发槽位（Semaphore）**的模型（如配置 `MAX_ACTIVE_GLOBAL_RUNS = 2~3`）。

---

## TASK-8：`SafeLogger` 日志脱敏系统递归深度防护

### 现状分析

在 [`src/server/logging.ts` 第 80~120 行](src/server/logging.ts#L80-L120) 中，`SafeLogger` 负责递归脱敏所有日志对象（过滤 token、密码、敏感提示词等）。
目前的递归遍历未设置深度阈值，也未防御循环引用。

### 潜在风险

若打印的对象中包含过深的嵌套结构（如第三方库复杂的 AST、超大深度 JSON），可能触发 V8 引擎的 `Maximum call stack size exceeded` 导致进程直接崩溃。

### 解决方案

在递归脱敏函数中加入 `depth` 计数器，限制最大递归深度（例如 `maxDepth: 8`）；超出层级限制时直接截断为 `"[MAX_DEPTH_REACHED]"`，避免栈溢出。

---

## TASK-9：SQLite 长期运行磁盘碎片与空间回收

### 现状分析

为了节省磁盘并保护敏感数据，系统在队列项执行终态后会将 `payload_text` 字段更新为 `NULL`。
但 SQLite 的默认存储机制不会将置空腾出的扇区自动归还给操作系统，而是留作内部空洞复用。

### 潜在影响

系统在云服务器上连续运行数月、执行成千上万次对话后，SQLite 数据库物理文件可能会因碎片产生体积膨胀。

### 解决方案

1. 在 [`src/server/db/connection.ts`](src/server/db/connection.ts) 初始化连接时设置增量整理模式：
   ```sql
   PRAGMA auto_vacuum = INCREMENTAL;
   ```
2. 在服务启动初始化或定时巡检中执行一次轻量的增量整理指令：
   ```sql
   PRAGMA incremental_vacuum;
   ```
