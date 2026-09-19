# ADR-0001：Hermes 作为唯一历史来源，emu-chat 只保存最小本地状态

- 状态：已接受（用户明确要求）
- 日期：2026-09-19
- 决策依据：用户已明确要求 Hermes 作为会话历史唯一来源；MVP 执行细节见已批准的 Q-00～Q-18

## 背景

Open WebUI 当前将聊天写入 `webui.db`，Hermes 同时写入 `state.db`。这会产生两份事实来源、上下文一致性风险和删除语义分裂。NextChat 的 IndexedDB local-first 方案也不符合 emu-chat 的 Hermes 唯一历史要求。

## 决策

1. Hermes `state.db`/native API 是消息、工具结果、会话谱系和运行 transcript 的唯一权威。
2. emu-chat 不直接读写 Hermes SQLite，不建立 transcript/tool-event 镜像表。
3. emu-chat SQLite 只保存 conversation mapping、UI metadata、草稿、未发送队列、有界恢复 input、run control/idempotency/reconnect state。恢复 input 只用于防丢和人工恢复：成功完成并对账后立即清除；失败/取消/中断最多保留 7 天，不能用于历史或搜索。
4. 浏览器只访问 emu-chat 后端；Hermes key 不进入浏览器。
5. Hermes 不可用时 emu-chat 显示可重试错误，不把本地缓存当作历史成功。

## 后果

好处：删除和压缩语义由 Hermes 单点定义；本地数据库小、易备份；不会因为客户端 schema 重建完整历史。

代价：Hermes 读取 API 的分页/搜索/事件能力成为硬依赖；断线时无法补齐 Hermes 没有 replay 的过程事件；emu-chat UI 元数据可能与 Hermes 外部修改暂时不一致，需要定期对账。

## 禁止的替代方案

- 为搜索建立本地 messages FTS；
- 将流式 delta 全量长期保存；
- 把前端 IndexedDB 作为会话历史；
- 在删除时先删本地再异步“希望”删除 Hermes。
