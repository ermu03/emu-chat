# 前端已知问题清单

> 测试中发现的前端问题汇总，按严重程度排列。

---

## BUG-1：长对话（120+ 条消息）Agent 回答丢失 🔴 严重

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

## BUG-2：会话切换卡顿与闪烁 🟡 体验问题

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

## BUG-3：工具调用/思考过程的展示方式不合理 🟢 改进建议

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

## TASK-4：测试套件精简与瘦身（消除过度测试） 🔵 架构优化

### 现状分析

当前 `tests/` 目录下拥有 20 个测试文件（近千行测试代码），存在明显的**过度测试**倾向：
- 很多简单的纯函数（如 `message-display.ts` 格式化一个 JSON、`conversation-view-cache.ts` 的基础 Map 存取、`queue-state.ts` 的条件判断）都单独写了单元测试。
- 组件测试文件 `react-components.test.tsx`（486 行）中包含了大量纯静态 DOM 检查（例如检查 textarea 是否渲染了 placeholder、是否渲染了静态文字标签等）。这类测试极脆弱，UI 一改动就会挂，但毫无业务保障价值。
- 维护大量非核心测试严重拖慢了前期开发的重构效率，与现阶段目标背道而驰。

### 优化与裁剪计划

遵循 `AGENTS.md` 规范，对测试目录进行大幅瘦身：

1. **组件测试裁剪（`react-components.test.tsx`）**：
   - ❌ **删除所有纯静态渲染测试**：
     - 检查 placeholder 文本
     - 检查图标或标题是否存在
     - 检查普通按钮点击是否有回调
     - 500ms 假时钟微秒级防抖精度测试
   - ✅ **仅保留 3 个核心高危交互测试**：
     - **不可逆删除防护**：删除确认弹窗必须勾选复选框才解锁按钮并允许提交。
     - **断网防丢保护**：发送请求失败（如网络错误）时，输入框草稿内容必须原样保留，禁止清空。
     - **异步竞态安全**：用户正在输入的新内容不会被稍后返回的旧保存 ACK 覆盖。

2. **单元测试精简（`tests/unit/`）**：
   - ❌ **裁撤/合并琐碎测试**：
     - 移除 `message-display.test.ts`、`conversation-view-cache.test.ts`、`streamed-assistant-cache.test.ts`、`queue-state.test.ts` 等普通纯函数/基础数据结构测试。
   - ✅ **保留核心机制测试**：
     - 仓储层与状态机流转（CAS 乐观锁、FIFO 队列、租约争夺互斥）。
     - 上游协议适配与能力评估核心契约。
     - SSEHub 核心广播与断线重放机制。

3. **集成测试聚焦（`tests/integration/`）**：
   - 仅保留主干：端到端消息原子入队 → 协调器派发调度 → 终态对账闭环，以及进程崩溃自愈等关键容错链路。
   - 删除过分冗余、重复覆盖的矩阵子项测试。

