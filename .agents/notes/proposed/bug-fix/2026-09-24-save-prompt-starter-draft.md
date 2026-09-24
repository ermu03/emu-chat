# Agent Note: 建议卡片文本发送前必须保存为草稿

Status: proposed

## Problem

[会话视图](../../../../src/client/state/use-conversation-view.ts)的 `handleSelectPrompt` 只更新 React 草稿状态。[DraftComposer](../../../../src/client/features/composer/draft-composer.tsx)接收新的 `initialDraft` 时，同时把 `contentRef` 和 `savedContentRef` 设为建议文本，没有发起保存，也没有把它标记为待保存。用户点击建议卡片后若不继续编辑就直接发送，`flushDraft` 认为内容已经保存；发送接口只传 `client_request_id` 和 `expected_draft_revision`，服务端从 SQLite 读取的可能仍是空白或旧草稿。此时界面会先显示乐观占位，随后发送可能失败或发送错误正文。

## Proposal

让建议卡片的文本进入与手工输入相同的草稿保存流程，并在提交消息前等待最新文本写入成功。处理建议文本与用户随后继续输入、旧保存回调返回之间的竞态，避免旧快照覆盖新输入。

## Alternatives considered

- 在 `AppShell` 或 `useConversationView` 中直接调用草稿 API：容易绕开 `DraftComposer` 已有的防抖、单飞和代数隔离机制，需要额外协调同一草稿的并发写入。
- 在发送请求中另传正文：可以绕过草稿同步，但会改变当前由服务端草稿原子入队的接口约定。

## Acceptance criteria

- 点击建议卡片后不再编辑，直接发送会入队所选文本，成功后输入框清空。
- 草稿保存或发送失败时，建议文本仍可见且可重试；不会发送旧草稿。
- 点击建议卡片后继续输入，新文本不会被先前的异步保存结果覆盖。
- 输入框已有未保存编辑时，点击建议卡片的结果应明确且一致，不会造成用户原输入静默丢失。

## Risks

程序化更新与用户输入共用同一草稿 revision；修复时需要维持现有的 CAS 冲突与跨会话隔离行为。
