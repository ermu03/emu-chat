# Agent Note: 用 proposed 笔记承接待处理事项

Status: implemented

## Problem

根目录的 `ISSUES.md` 和 `.agents/notes/proposed/` 都在记录待做的 BUG、TASK 与改进方案。同一个主题分散在两处，会让独立开发和后续 AI 会话难以确定哪份记录应更新。测试套件精简（原 TASK-4）已完成，并已有[测试决策笔记](../testing/2026-09-23-focus-test-suite-on-critical-behavior.md)。

## Decision

删除 `ISSUES.md`。值得跨会话跟进的未完成问题和改进方案按主题写入 `.agents/notes/proposed/<类别>/`；紧密相连的事项合并成一篇，例如原 BUG-1 与 ISSUE-6 共用一篇长对话分页提案。笔记同时保存问题、候选方案、验收条件和风险，不再维护第二份待办清单。简单的一次性工作可直接按用户请求实施，无需为了登记任务新建笔记。

复杂规格仍可按需放在 `.agents/specs/`，研究资料按需放在 `.agents/research/`；它们为提案提供细节，不另充当待办入口。落地后按[决策笔记规则](../../../../docs/decision-notes.md)处理 proposed、implemented、rejected、archived 的流转。

## Alternatives considered

- **保留 `ISSUES.md`，只把重大取舍写成 proposed**：小任务的列表浏览很方便；但当前清单已包含完整根因和解决方案，与 proposed 的内容重复。
- **所有条目都迁成独立笔记**：可逐条对应原编号；原 BUG-1 和 ISSUE-6 会重复描述同一分页问题，完成时容易漏改其中一篇。
- **改用外部 Issue 平台**：有筛选和通知能力；当前一人维护、以仓库文档协作，不需要额外系统。

## Consequences

- **收益**：每个待处理主题只有一个可搜索的记录；完成工作时可沿用同一笔记记录实施结果和取舍。
- **代价**：没有单页待办总览；检索未完成工作要浏览 `proposed/`。笔记只记录有持续价值的事项，避免每个小改动都生成文档。

## Verification

未完成的原清单内容已按主题迁入 proposed；原 TASK-4 由 implemented/testing 中的现有笔记承接；项目规范和 Skill 均指向四状态笔记，不再引用根目录清单。
