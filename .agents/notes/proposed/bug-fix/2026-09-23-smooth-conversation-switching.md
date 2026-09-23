# Agent Note: 减少会话切换空白与消息重绘

Status: proposed

## Problem

原 BUG-2：切到未命中缓存的会话时，[AppShell](../../../../src/client/app.tsx) 会立即清空当前会话、消息、草稿与 Run 状态，消息区短暂出现加载空白。命中 [ConversationViewCache](../../../../src/client/features/conversations/conversation-view-cache.ts) 时虽可恢复快照，但大量消息仍可能在一次渲染中造成卡顿。原 BUG-1 也报告了流式更新时的闪烁；[MessageRow](../../../../src/client/features/messages/message-view.tsx) 当前没有独立的渲染缓存。

## Proposal

切换时让当前视图保持稳定，直到目标会话数据可显示，同时明确标示目标正在加载，避免旧内容被误认为目标会话；发送、编辑等操作须绑定真实的当前会话。对消息列表做性能分析后，再选择稳定 props、`React.memo`、分段加载或虚拟列表等措施。`React.memo` 只对引用未变的消息行有效，不能代替测量。

## Alternatives considered

- **立即清空并展示加载态**：实现简单，且绝不会把旧会话内容显示在新路由下；目前造成可见空白。
- **仅添加骨架屏或过渡动画**：能改善空白观感，但不解决大量消息重绘。
- **直接引入虚拟列表**：长会话下可减少 DOM 数量；滚动定位、动态高度和流式内容会增加实现复杂度，先以实测判断是否需要。

## Acceptance criteria

- 在缓存命中和未命中时切换会话，没有明显空白闪烁；加载态不会让用户把旧会话当作新会话操作。
- 长对话的切换和流式更新没有明显的重复 Markdown 渲染卡顿；关键交互保持正常。

## Risks

保留旧视图可能造成路由、展示内容和可操作会话短暂不一致；性能优化还可能影响自动滚动与流式消息展示。
