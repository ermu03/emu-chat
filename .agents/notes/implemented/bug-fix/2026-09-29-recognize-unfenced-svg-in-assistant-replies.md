# Agent Note: 识别助手正文中的完整裸 SVG

Status: implemented

## Problem

[成果预览首版](../feature/2026-09-26-add-html-svg-artifact-preview.md)只识别闭合代码围栏。Hermes 会按用户要求直接在说明文字中输出完整 `<svg>…</svg>`，用户实际看到一长串标签，必须重新要求助手加围栏才能预览。Markdown 将这些标签拆成 HTML 节点和文字节点，不会走代码块入口。

## Decision

已保存的助手普通正文中，若 Markdown AST 的 HTML 节点或同一段落内的 HTML 标签序列构成完整的独立 SVG 根元素，就按原文位置提取，并在消息中的原位置显示为 SVG 代码块，复用已有的点击预览入口及面板内的源码、复制和下载操作。正文前后的说明保留。提取仍受 256 KiB 限制，并经过原有 XML 根元素、命名空间、DOCTYPE/实体和解析错误校验；不完整或无效的裸标签继续按普通 Markdown 显示。代码围栏内、行内代码、用户消息、工具、思考和实时未核对内容不扩大执行范围。入口布局后来按[简化笔记](../simplification/2026-09-29-simplify-artifact-actions.md)收窄。

## Alternatives considered

- **要求用户每次提示助手加代码围栏**：实现最少，但自然生成的完整 SVG 无法直接试用，用户刚遇到的故障会持续出现。
- **在消息正文中直接插入 SVG DOM**：可以立即显示图形，但绕过现有的图片上下文隔离，也使阅读消息时被动运行生成内容。沿用点击式预览更符合首版安全边界。
- **用全文正则查找所有 SVG 字符串**：可覆盖更多排版形式，但容易跨越围栏、行内代码或不相关片段；基于 Markdown AST 的节点和原文位置更容易约束来源。

## Consequences

助手正文里完整的独立 SVG 可以像围栏 SVG 一样预览，说明文字仍按原顺序显示。识别依赖 Markdown 将起止标签放在同一段落或完整 HTML 节点中；跨段落拆散的 SVG 仍需代码围栏。原始消息没有改写，下载和源码使用提取到的原文。额外的 AST 处理只在有成果资格的已保存助手正文上进行。

## Verification

- 提取测试覆盖正文前后有说明、无效/未闭合/行内代码 SVG；组件交互测试覆盖已保存助手正文的预览入口和用户正文无入口。
- `npm run typecheck`、相关 Vitest、`npm run lint`、`npm run format:check`、`npm run build` 通过。
