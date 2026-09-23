# Agent Note: 用四种状态记录工程决策

Status: implemented

## Problem

现有 [docs/](../../../../docs/) 描述系统的当前结构，[ISSUES.md](../../../../ISSUES.md) 保存待办，但重要取舍、被放弃的方案和后来应如何重新审视决定没有统一位置。独立开发时，新一轮开发或 AI 会话容易只看到代码现状，重复讨论旧方案。

## Decision

工程决策记录在 .agents/notes/，按 proposed、implemented、rejected、archived 四种状态及六种主题类别组织。写作与状态流转遵循[决策笔记规则](../../../../docs/decision-notes.md)；[AGENTS.md](../../../../AGENTS.md) 要求在非平凡改动前检索旧笔记，并在代码落地时同步更新。目录仅在有内容时建立，不维护总索引。

现有架构、接口和测试文档继续描述当前事实；Note 保存无法从这些事实直接推断的理由与取舍。笔记由开发者随变更维护。

## Alternatives considered

- **继续只用现有 docs/ 和 ISSUES.md**：文件少，当前系统和待办都能找到；但缺少对提案、已实施决定、否决方案和历史决定的明确区分，也难以定位某项约束的由来。
- **完整引入教程的校验脚本、归档封印和 GitHub CI**：能自动发现格式错误及部分链接问题；本项目由一人维护，当前更需要低负担地记录理由，因此先采用笔记生命周期和写作规则。

## Consequences

- **收益**：新会话可以按状态查找现行决定、待议方案和过去否决的路线；重要改动的理由与代码同批保留。
- **代价**：没有自动门禁保证每项重要改动都附带笔记，也没有归档哈希封印。维护者需要在改动时主动检索、同步和修复笔记链接；只记录未来仍有参考价值的决定，控制笔记数量。

## Verification

AGENTS.md 指向 docs/decision-notes.md；本篇位于 .agents/notes/implemented/process/，作为首篇已实施决策笔记。
