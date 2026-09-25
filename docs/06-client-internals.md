# Emu Chat 客户端内部实现

本文档详细介绍了 Emu Chat 客户端的核心内部实现细节，涵盖了路由、状态管理、核心组件机制、网络通信以及样式系统。

## 1. 入口与路由 (Entry & Routing)

应用的客户端入口由 `main.tsx` 引导，核心路由结构如下：
- **`AppRouter(BrowserRouter)`**: 负责整体应用的 HTML5 History 路由。
- **`AppShell`**: 作为通配路由挂载，处理所有应用的 URL。这种设计保证了即使在不同会话之间切换，外壳组件及其上下文也不会被卸载，从而维持核心状态和缓存。

## 2. AppShell 与状态 Hook

`AppShell` 保留路由、连接状态、会话列表、偏好设置和布局组合。会话视图、Run 生命周期与发送过程由三个状态 Hook 持有：

| 模块 | 持有状态与副作用 |
| --- | --- |
| `useConversationView` | 当前会话详情、消息、草稿、队列、Run 快照、有序实时回合、LRU 缓存、历史消息加载和旧请求隔离。`messagesConversationId` 标明消息属于哪个会话。 |
| `useRunRuntime` | Run 的 SSE 订阅、工具完成后的增量读取、事件缺口提示、运行状态单飞轮询、终态对账，以及队列项和 Run 操作。 |
| `useMessageSend` | 发送请求 UUID、待确认提交的乐观占位、发送后队列与草稿更新。 |

`AppShell` 将 `useConversationView` 的视图状态传给 Run 和发送 Hook。Run Hook 通过视图提供的更新方法写入队列、Run 和消息；发送 Hook 在 API 接受提交后写入队列项并触发 Run 刷新。共享状态只有一个所有者，避免两条异步流程各维护一份当前队列。

`useConversationView` 用 `activeLoadRef` 标记每次会话加载。切换时立即使旧请求失效；缓存命中先恢复快照，随后刷新服务端状态。`activeConversationIdRef` 使发送、Run 操作和轮询在网络返回后确认目标会话仍然选中。`currentViewSnapshotRef` 保留正在展示的旧会话；目标消息尚未就绪时不会把它误当成新会话。`useMessageSend` 的 `pendingSendRef` 保存重试所需的发送 UUID。

冷缓存切换会在顶部标明目标会话，同时暂时显示当前会话。目标消息请求独立完成后立即切换消息视图，不等待会话详情、草稿或队列请求；其他操作仍会等各自所需数据就绪。消息加载失败时保留当前视图并提供重试。首次打开且没有可保留的会话时显示加载状态。缓存命中仍会立即恢复快照，并继续向服务端刷新状态。

## 3. API 客户端 (EmuChatApiClient)

`EmuChatApiClient` 提供了统一的 API 调用封装：
- **统一 `request<T>` 管道**: 自动附加 JSON Header、解析响应，并在 HTTP 响应非成功时抛出 `ApiClientError`。
- **合成错误信封**: 非成功 HTTP 响应体不是合法 JSON 时，会合成 `INTERNAL_ERROR` 信封；客户端不对可解析的错误 JSON 做 Schema 校验。Fetch 层网络错误仍以原始异常抛出。

## 4. 核心组件功能

### ConversationList (会话列表)
- **数据分组**: 按照“置顶”与“最近”进行逻辑分组，日期采用相对时间格式化显示（如“2小时前”）。
- **交互设计**: 行级操作菜单支持就地修改标题、置顶、分叉 (Fork) 和删除。修改标题按 Enter 或失焦保存，按 Escape 取消；菜单支持通过 `pointerdown` 或 `Escape` 键关闭。
- **布局调整**: 桌面端拖拽侧栏右边界即可调宽，范围为 240～480 像素，最大不超过视口宽度的 45%；折叠时宽度为 64 像素。拖拽过程只改本地状态，松手后写入 `localStorage` 并尝试更新偏好 API。初始宽度从 `localStorage` 读取，缺失时使用 300 像素；目前不会用 GET `/preferences` 返回的 `sidebar_width` 初始化侧栏。
- **安全删除**: 删除流程需要二次确认弹窗，并强制勾选复选框，防止误删。

### DraftComposer (输入框与草稿管理)
- **自适应高度**: 根据内容实时调整输入框高度，区间为 `84px` 至 `230px`。
- **悬浮岛聚焦**: 容器获得焦点（`:focus-within`）时呈现柔和主题色光环扩散（Ring Glow）与层次浮起感。
- **代数隔离**: 通过 `generationRef` 实现跨会话隔离，避免草稿错乱。
- **防抖与单飞**: 支持 500ms 防抖存盘，采用单飞锁（保证同一时间只有一个请求）控制。
- **实时校验**: 使用 `TextEncoder` 进行 UTF-8 字节数实时统计和校验。
- **发送管道**: 发送前强制触发 `flush` 保存最新草稿，随后执行 `handleSend` 管道。
- **快捷键**: 区分单纯换行（`Enter` 或根据偏好）和发送提交（`Mod+Enter`），底部状态栏提供等宽快捷键提示胶囊。

### MessageView (消息展示)
- **智能吸底滚动**: 当用户滚动位置接近底部（`scrollHeight - scrollTop - clientHeight < 80`）时，新消息到达或文本流式增长会自动触发滚动吸底。
- **稳定历史消息渲染**: 仅当 `messages` 引用变化时重新执行回合分组；用户、系统、助手、工具和 Markdown 行使用 `React.memo`。仅流式内容变化时，已加载的历史 Markdown 不会重新解析。
- **Markdown 渲染管道**: 采用 `remarkGfm` + `remarkMath` + `rehypeHighlight` + `rehypeKatex` 的标准渲染链。
- **自定义代码块与复制**: 独立 `CodeBlock` 组件提供语言标签“药丸”顶栏以及一键复制代码按钮（附带复制成功反馈）。
- **工具调用与结果**: 同一助手回合按消息顺序展示文字、思考和工具，不把思考统一前置，也不把最后一个工具后的正文合并为最终答案。每个工具独立成紧凑卡片，完成时摘要内显示结果预览；展开可读完整输入和输出，`getToolResultContent` 解析工具响应。思考只使用 Hermes 历史消息中确认的 `reasoning` 字段，在所属消息位置显示默认折叠的紧凑入口；`reasoning.available` 可能只是普通助手正文的临时投影，不能当作已保存的思考内容。当前流式视图没有可靠的思考事件，入口可能在终态历史核对后补充。
- **空状态引导**: 会话无历史消息时提供快捷开始建议卡片（Prompt Starters）。点击后由 `DraftComposer` 更新输入框并按正常流程保存草稿；直接发送也会等待保存成功。输入框已有用户内容时，卡片不会覆盖它，而是提示先清空；已选且未编辑的建议可以切换。详见[建议卡片草稿修正决定](../.agents/notes/implemented/bug-fix/2026-09-24-save-prompt-starter-draft.md)。
- **流式与乐观渲染**: `AssistantTurnRow` 同时承载实时 Run 回合和 Hermes 历史回合。SSE 文字段与工具卡片逐个加入；终态后保留该行并显示核对状态，直到历史消息到达，再用相同 React key 切换权威内容，保留工具展开状态并避免整行重新淡入。`PendingUserRow` 显示发送占位。
- **长会话分页**: 初次加载请求最新的 100 条（`order: "latest"`），显示时按消息 ID 升序排列。顶部「加载更早历史消息」使用单独保存的最早消息 ID 和 `latest` offset；新消息使 offset 移动时，以重叠页扫描到更早的消息。终态对账和缓存会话刷新会逐页补齐至已知消息，按 ID 合并去重；分页位置随会话快照恢复。详见[消息分页修正决定](../.agents/notes/implemented/bug-fix/2026-09-24-correct-message-pagination.md)。

### 顶部工具栏与偏好
- **新建与重命名**: 点击新建会话直接向 Hermes 创建标题为「新会话」的会话；点击当前会话标题可就地修改，Enter 或失焦保存，Escape 取消。
- **主题切换**: 工具栏右上角按钮在浅色和深色间切换，并通过偏好 API 保存；载入的 `system` 主题偏好会跟随系统配色。
- **侧栏调宽**: 桌面端拖拽侧栏边界时即时更新宽度，松手后写入浏览器缓存并尝试同步到偏好 API。
- **发送快捷键**: `DraftComposer` 遵循偏好 API 返回的 `enter` 或 `mod_enter`；当前页面没有修改快捷键的入口。

### QueuePanel (排队面板)
- **队列管理**: 基于 FIFO 的排序展示。
- **就地编辑**: 列表内的项支持就地内联编辑（基于 `textarea` 和乐观锁）。
- **取消排队**: 支持取消尚未派发的项目。乐观提交项由 `PendingQueueItem` 渲染。

### 弹窗与辅助组件
- **ApprovalDialog (审批弹窗)**: 提供“停止”、“拒绝”和“允许一次 (once)”三种操作选项。
- **StatusBar (状态栏)**: Hermes 健康且无局域网 HTTP 提示时隐藏；连接或能力异常时显示重检入口。SSE 断线由 `AppShell` 的独立提示条显示。
页面没有设置抽屉。

## 5. 核心状态模块与缓存

### queue-state.ts
封装了诸多用于推断队列和 Run 状态的纯函数：
`isLiveQueueState`, `isLiveRun`, `getCurrentRunId`, `getPrimaryQueueItem`, `getQueuedFollowUps`, `isAgentGenerating`。

### useStreamEvents (SSE Hook)
- **连接代数锁**: 使用 `connectionGenerationRef` 确保多路切换时不发生事件混乱。
- **事件类型**: 主要处理 `stream.ready`, `run.event` 和 `stream.gap`。
- **重连策略**: 采用指数退避机制重连（1s → 2s → 4s → 8s → 最高 15s 封顶）。
- **断点续传**: 通过 `lastEventId` 实现序号追踪和断线恢复。

### ConversationViewCache 与 RunDisplay
- **ConversationViewCache**: 容量为 12 的 LRU 缓存，利用 JS 原生 `Map` 对插入顺序的保持特性实现 `get`/`set`/`delete`。
- **RunDisplay**: 按 Run ID 保存文字和工具事件的有序块；`local_seq` 去重，最多保留近期 24 个 Run 的临时视图。收到 `tool.started` 时创建只有工具名和执行状态的卡片；`tool.completed` 将结果预览置入展开区。后续合并读取 Hermes 历史消息；只有工具名与结果唯一可对应（或以 `tool_call_id` 精确配对）时才补齐完整输入输出，同名并发调用缺失 ID 时保持待核对。SSE 缺口提示用户部分过程不可恢复。
- **工具卡片与展示脱敏**: 折叠卡片左侧只显示工具名，右侧显示状态；展开区展示完整的脱敏参数/命令及工具输出。服务端在 API 消息和 SSEHub 事件分发前对凭据实施展示脱敏。
- **终态交接**: Run 已对账但历史读取未成功时继续显示实时回合，并以轮询或手动核对重试。消息合并与 RunDisplay 结算在同一次 React 更新中提交；历史来源始终是 Hermes。

## 6. CSS 设计系统
- **双轨主题**: 依赖于 `:root` (浅色默认) 及 `data-theme="dark"` (深色模式) 的原生 CSS 变量机制。
- **核心变量**: 定义了 `canvas`, `surface`, `ink`, `accent`, `danger` 等语义化色板，以及四级微阴影体系 (`--shadow-sm`, `--shadow-soft`, `--shadow-float`, `--shadow-glow`)。
- **层次与质感**: 顶部导航工具栏与模态弹窗遮罩启用 `backdrop-filter: blur(...)` 毛玻璃模糊。
- **响应式布局**: 以 `760px` 为断点，移动端触发全屏抽屉式的侧边栏模式。
- **交互与无障碍**: 实现流式光标动画 (`cursor-blink`)，并通过 `@media (prefers-reduced-motion)` 禁用不必要的动画效果。
- **数学公式**: 前端入口加载 KaTeX 样式，保证 MathML 仅供辅助阅读且公式结构正确排版；过长的块级公式在自身区域横向滚动。
