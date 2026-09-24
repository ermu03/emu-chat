# Agent Note: 建议卡片文本发送前必须保存为草稿

Status: implemented

## Problem

[会话视图](../../../../src/client/state/use-conversation-view.ts)的 `handleSelectPrompt` 只更新 React 草稿状态。[DraftComposer](../../../../src/client/features/composer/draft-composer.tsx)接收新的 `initialDraft` 时，同时把 `contentRef` 和 `savedContentRef` 设为建议文本，没有发起保存，也没有把它标记为待保存。用户点击建议卡片后若不继续编辑就直接发送，`flushDraft` 认为内容已经保存；发送接口只传 `client_request_id` 和 `expected_draft_revision`，服务端从 SQLite 读取的可能仍是空白或旧草稿。此时界面会先显示乐观占位，随后发送可能失败或发送错误正文。

## Decision

- 建议卡片将文本交给 [DraftComposer](../../../../src/client/features/composer/draft-composer.tsx)，由它更新输入框并触发与手工输入相同的防抖保存；发送前的 `flushDraft` 必须等待保存成功，才使用返回的 revision 提交消息。视图状态不再把尚未保存的建议文本伪装成服务端草稿。
- 输入框已有用户内容时，点击建议卡片会保留原文并显示先清空的提示；用户尚未编辑的已选建议可以换成另一张卡片。保存失败或发送失败时保留建议文本以便重试。
- 程序化选取建议与手工编辑共享单飞保存队列。旧保存响应只更新已保存快照和 revision，不覆盖较新的输入；切换会话时终止旧 flush 对新会话的后续保存。

## Alternatives considered

- 在 `AppShell` 或 `useConversationView` 中直接调用草稿 API：容易绕开 `DraftComposer` 已有的防抖、单飞和代数隔离机制，需要额外协调同一草稿的并发写入。
- 在发送请求中另传正文：可以绕过草稿同步，但会改变当前由服务端草稿原子入队的接口约定。

## Consequences

- 直接点击建议后发送会先保存草稿，再入队所选文本；成功后输入框清空。保存失败时不会调用发送接口，文本仍可重试。
- 代价是空会话的建议卡片与输入框之间需要一条命令通道，输入框也需记录当前内容是否仍是未编辑的建议，以避免覆盖用户原输入。

## Verification

`tests/components/app-shell-flow.test.tsx` 验证建议文本在发送前写入服务端草稿、保存失败不发送且可重试；`tests/components/react-components.test.tsx` 验证保存中的用户编辑和旧保存响应不会造成文本丢失。
