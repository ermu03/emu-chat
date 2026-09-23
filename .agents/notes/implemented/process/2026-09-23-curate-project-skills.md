# Agent Note: 将通用 Skill 集合收敛为项目工作流

Status: implemented

## Problem

项目原先安装了完整的通用 Skill 集合，其中不少面向课程写作、外部 Issue/PR、自动提交或强制测试流程。emu-chat 由一人维护，开发规范与决策笔记已有固定位置；未来还可能同时使用 Codex 和 Claude。原集合容易让后续助手选择不合适的流程，或生成第二套文档。

## Decision

仅保留需求澄清、规格、任务拆分、研究、实现、架构设计与评估、代码评审、会话交接这十个项目 Skill。正文以 .agents/skills/ 为唯一维护源；Claude Code 通过 .claude/skills/ 中的目录链接读取同一份正文，根目录的 CLAUDE.md 导入 AGENTS.md。

值得持续跟进的待处理事项记录在 .agents/notes/proposed/，不另设本地待办清单；复杂规格和可复用研究分别按需存入 .agents/specs/ 与 .agents/research/。工程决策在 .agents/notes/ 按四状态管理，具体迁移决定见[流程笔记](2026-09-23-track-pending-work-in-proposed-notes.md)。实现流程遵守 AGENTS.md 的测试范围，交付工作树改动和 commit 信息，由用户手动提交。定制后的 Skill 不再使用上游安装锁文件管理。

## Alternatives considered

- **保留完整上游集合**：随时可调用更多现成流程；但大量技能预设本项目没有的跟踪器、ADR 目录和多人交付方式，选错流程的成本高。
- **为 Codex 与 Claude 各维护一份 Skill 正文**：无需目录链接；但相同规则会在两处逐渐分叉。当前开发环境支持符号链接，因此采用同一正文加 Claude 入口。
- **继续保留上游 skills-lock.json**：便于按原来源检查更新；现有 Skill 已针对项目改写，锁文件的上游来源与内容哈希不再代表当前正文，后续更新还可能覆盖定制内容。

## Consequences

- **收益**：两个工具使用同一套项目规则；规格、待处理提案、研究和已实施决策各有明确位置；实现与评审流程不再默认创建 PR、自动提交或运行不必要的测试。
- **代价**：这些 Skill 由项目自行维护，不能直接用上游安装锁文件更新。Claude Code 的目录链接依赖克隆环境正确保留符号链接；若迁到不支持链接的环境，需要重新提供 Claude 入口。

## Verification

十个保留 Skill 均通过结构校验；.agents/skills/ 与 .claude/skills/ 各有十个对应入口，所有链接均能解析。相关项目约定见 [AGENTS.md](../../../../AGENTS.md) 和 [决策笔记规则](../../../../docs/decision-notes.md)。
