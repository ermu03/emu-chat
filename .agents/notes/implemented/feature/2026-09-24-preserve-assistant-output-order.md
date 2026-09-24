# Agent Note: 保留助手输出的发生顺序

Status: implemented

## Problem

上一轮[逐步展示工具进度](./2026-09-24-progressive-tool-events-and-stable-run-handoff.md)已让工具在运行中出现，但历史消息的组装仍有重新排序：无工具回合先收集全部 `reasoning`，再合并全部正文；有工具回合把最后一个工具之后的所有助手正文合并成末尾文本。若一个回合包含多条交错的助手消息，历史展示可能不等于原始消息顺序。

实时回合只接收正文增量和工具事件。按[已实施的修复](../bug-fix/2026-09-24-avoid-transient-reasoning-card.md)，Hermes 的 `reasoning.available` 不能证明该内容会保存在历史 `reasoning` 字段中，因此思考只能在读取权威历史后显示。这会让一个折叠入口在已有正文或工具旁较晚出现；尤其当历史组装把它统一放在正文之前时，看起来像终态重排。

产品参照：OpenAI 的[ChatGPT 应用界面规范](https://developers.openai.com/plugins/concepts/ui-guidelines)把内联应用卡片放在生成的回复之前，其[开发文档](https://developers.openai.com/api/docs/guides/deployment-checklist)区分过程更新与最终回答；[Claude 帮助文档](https://support.claude.com/en/articles/8664678-change-the-model-effort-and-thinking-settings)描述了回复上方的可展开思考摘要，其[搜索文档](https://support.claude.com/en/articles/10684626-enable-and-use-web-search)说明搜索期间有状态提示；[Gemini Deep Research 介绍](https://blog.google/products-and-platforms/products/gemini/tips-how-to-use-deep-research/)描述了工作期间可查看思考步骤、浏览站点，以及完成后的报告。这些模式说明“过程可折叠、答案突出”是可行的；它们并不能证明需要在完成后把已展示的中途正文挪到末尾。

## Decision

1. [历史分组](../../../../src/client/features/messages/message-display.ts)对同一助手回合只遍历一次消息：每条助手消息先放已确认的思考，再放正文或工具调用；工具结果回填原卡片。移除“收集所有思考再合并正文”和“最后一个工具之后统一收集最终正文”的规则。Hermes 当前没有明确的最终回答阶段，界面不从位置猜测。
2. [实时回合](../../../../src/client/features/messages/run-display.ts)继续按事件顺序追加正文和工具卡片，可靠对应的完成事件更新原卡片。终态保留已有的稳定助手行，以历史消息校正内容；历史分组不再为分类而移动正文或工具。
3. 已确认的 `reasoning` 在所属消息位置使用默认折叠的紧凑入口；只有展开后才显示长内容。没有权威 `reasoning` 的回合不显示思考入口。当前 `reasoning.available` 仍不作为实时思考增量；真正的实时思考需要 Hermes 提供语义明确、可与历史消息对应的事件。

## Alternatives considered

- **统一过程区放在最终回答上方**：类似某些产品的概览布局，答案集中、页面简洁；但本项目已有工具之间的中途正文，而且实时卡片在发生时就出现。终态再将它们统一搬到顶部会改变已读顺序。
- **继续用当前位置推断最终正文**：实现简单，常见的“工具后仅一条最终回复”也显示正常；多条助手消息的思考与正文交错时仍会改变顺序，因此不能作为通用规则。
- **直接展示 `reasoning.available`**：可更早给出思考反馈；现有事件可能来自普通正文，曾造成思考卡片闪现后消失，不能采用。

## Consequences

多条无工具助手消息的思考与正文按消息交替展示；工具前后的正文也留在原位置。终态补入思考时只有一个默认折叠的小入口，不会自动展开长文本。界面仍只能表示 Hermes 保存的消息顺序，不能还原单条消息内部更细的生成时间线；实时事件没有稳定消息 ID，终态正文与流式正文若有差异，仍可能发生局部校正。

## Verification

- [历史分组用例](../../../../tests/unit/message-display.test.ts)覆盖无工具交错思考与正文、工具后多条助手消息、结果与调用 ID 配对。
- [跨模块异步用例](../../../../tests/components/app-shell-flow.test.tsx)覆盖实时顺序、延迟历史读取后的稳定助手行、已保存思考在所属位置补入且默认折叠。
- 同名并发工具调用和 SSE 缺口继续遵循既有对账约束；当前实现没有尝试推断不存在的关联。浏览器视觉联调仍应检查思考入口较晚出现时的细小布局变化。
