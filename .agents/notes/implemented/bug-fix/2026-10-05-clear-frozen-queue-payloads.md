# Agent Note: 统一清理队列中的完整正文副本

Status: implemented

## Problem

2026-10-05 使用内存 SQLite 复现确认：图片队列到期或主动丢弃恢复载荷后，`payload_text` 已为空，`payload_run_input` 仍包含完整用户正文；待人工核对项模拟经过 100 天后仍保留该副本。

[MediaDispatchService](../../../../src/server/media/dispatch.ts) 冻结的 Run 输入由[清单构造器](../../../../src/server/media/manifest.ts)将原文与机器清单拼接形成。[QueueRepository](../../../../src/server/db/repositories/queue.repository.ts) 的终态迁移和到期清理，以及[QueueRunService](../../../../src/server/services/queue-run-service.ts) 的主动丢弃只清空 `payload_text`。`review_required` 控制记录按现有决定保留，导致冻结正文绕过恢复期限；普通终态也会在控制记录清除前多留一份正文。

清空冻结列还涉及历史关联：[MediaService.decorateHistory](../../../../src/server/media/service.ts) 原先把冻结输入与 Hermes 用户消息比较，作为本地图片清单验证依据。因此需要用不含完整正文的摘要和身份记录替代这一证明，保留插件离线时的历史关联能力，而不能仅增加一条清空 SQL。

本篇补全[恢复载荷保留决定](../../implemented/bug-fix/2026-09-23-expire-recovery-and-terminal-control.md)在图片输入上的边界。Hermes 仍是完整历史的权威存储；图片引用保护见[关联提案](../../proposed/bug-fix/2026-10-05-preserve-media-references-through-branch-and-delete.md)。

## Decision

1. 队列完成、取消和主动丢弃通过仓储的即时事务同时清空 `payload_text` 与 `payload_run_input`。后台每轮最多补清 100 条到期、已丢弃和旧终态正文，复核队列与关联 Run；提交、接纳、对账中的输入不被补清或主动丢弃。接口仍在截止时间立即停止提供恢复内容，`review_required` 的控制身份可以继续保留。
2. 增量迁移新增 `media_submission_proofs`，持久保存 scope、operation、冻结 session、有序资产 ID、用户文字 SHA-256、冻结输入 SHA-256 及原队列引用 ID。新图片请求在远端引用及绑定确认后，将冻结输入和凭据一起本地提交；凭据绑定不可被不同请求覆盖。重启重放保持原请求不变。
3. 旧记录在清空前用规范清单、冻结身份、附件顺序及已保存的队列正文/附件指纹补建凭据；补建与清空同批提交或回滚。缺少本地证明时，历史只接受插件返回的精确绑定，验证成功后保存凭据；不从用户消息的自声明清单推断权限。
4. 控制记录自动删除需等待冻结正文处理完成，避免批次未覆盖的旧记录先失去证明。仅补清旧冻结列时保留原更新时间，不额外延长控制窗口。没有正文的凭据按会话历史图片生命周期保留，与队列控制外键解耦，随会话物理删除级联清理。已知的原队列引用 ID 用于控制记录删除后的历史交接，缺少旧证明时不猜测引用身份。
5. session 映射采用把含历史凭据的会话视为已有本地数据，不能当作空投影丢弃。图片孤儿判定计入提交凭据；正文清理不删除历史图片、有效附件或待交接 outbox。历史验证逐项匹配身份、摘要和图片顺序，插件离线时仍可验证已知输入图并给出原有不可用占位。

## Alternatives considered

- **只清空 `payload_run_input`**：可直接减少敏感正文留存，改动较小。但历史目前依赖该列做本地验证，直接清空会让插件离线时已知输入图片失去证明，需要一起保留摘要与身份信息。
- **等待整个控制记录到期再删除正文**：可复用既有控制清理，并保留历史校验依据。但控制记录与正文保留期限不同，待人工核对项还可能长期保留，不能满足主动丢弃和七天恢复约定。
- **清空后完全依赖插件在线校验**：能少存一份本地验证凭据。但会增加历史读取的远端请求，并在插件暂时不可用时退化已知附件展示，选择保留受验证的摘要凭据。

## Consequences

- 新请求完成、取消、到期或主动丢弃后，两份本地逻辑正文同步清空；七天恢复期限不会被冻结输入绕过。旧数据包括长期保留的 review_required 记录也可由有界批次处理，重启继续推进。
- 新凭据比完整 Run 输入小，控制记录删除后仍可离线确认历史输入图片；代价是每次图片提交保存一条随会话保留的身份与摘要记录。它不是新的聊天历史存储。
- 无法验证的旧冻结输入仍按期限清除，历史保留原机器清单，等待插件核验；不为维持展示而放宽授权。清单内容、scope、session、operation、摘要或附件顺序不匹配时不会装饰图片。
- 图片引用与正文分开保留；没有改变图片分支/删除任务的同步策略，后续保护见[关联提案](../../proposed/bug-fix/2026-10-05-preserve-media-references-through-branch-and-delete.md)。本篇补全[恢复期限决定](2026-09-23-expire-recovery-and-terminal-control.md)，沿用[独立图片工作流](../feature/2026-09-28-add-image-workflows.md)的授权边界。
- 验收针对逻辑记录与 API。SQLite 空闲页、WAL 和已有备份的物理擦除不由字段置空保证，仍沿用[按实际占用回收的决定](../architecture/2026-09-23-reclaim-sqlite-free-pages.md)。

## Verification

- [保留策略测试](../../../../tests/unit/data-retention.test.ts)：旧数据按 100 条批次补建和补清；注入凭据写入失败验证整个批次回滚；长期 review_required 清空正文但保留控制身份；活跃 Run 和有效恢复正文不被清理；验证完成、取消及主动丢弃同时清空两列，历史凭据不含完整正文。
- [图片主干集成测试](../../../../tests/integration/media-run-flow.test.ts)：附件 CAS、丢失接纳响应后的重启重放保持完全相同的冻结输入与绑定，只有一条上游用户消息；完成清空正文、控制到期后仍可在线及离线装饰历史。缺失证明时核验插件 binding，错误 operation 被拒绝。
- 旧冻结证明需匹配队列指纹；未知、文本或身份变化、附件重排的历史清单不会获得本地授权。增量迁移测试保留既有草稿及队列数据。

- 完整测试 19 个文件、106 个用例通过；补上 session 采用保护后，相关 4 个文件、10 个用例再次通过，类型检查、lint、格式检查复验通过；构建通过。构建仍有已有的大 bundle 提示。
