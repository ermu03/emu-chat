# 工程决策笔记

本项目用仓库内的 Agent Note 保存重要改动背后的理由、真正考虑过的方案和已知代价。这套做法参考 [write-notes-like-deepseek](https://github.com/czm15053/write-notes-like-deepseek)；由一人维护，依靠写作与代码同批更新，不设置笔记校验脚本或 CI。

现有 docs/ 说明系统当前如何工作，ISSUES.md 跟踪待办，决策笔记解释为什么选择现在的做法。笔记不复述接口字段、代码流程或任务清单；需要细节时链接到现有文档或源码。

## 何时写

行为、架构、跨模块约定、持久化或网络格式、测试策略、开发流程发生非平凡变化，或者未来维护者只看代码和测试仍无法推断原因时，写或更新一篇笔记。纯格式化、样式调整、常规 CRUD 和局部显而易见的修复不写。

写新笔记前，先搜索 proposed、implemented、rejected 中的同主题记录。有笔记持有同一决定，且理由没有变化时，就地更新路径、名称、默认值等现行事实；理由或决定翻转时，新建笔记并关联旧篇。不要把已实施笔记改写为相反决定。

## 路径和状态

笔记路径为 .agents/notes/<状态>/<类别>/YYYY-MM-DD-主题.md。日期是首次提出这项决定的日期；状态流转时保留文件名。类别只用 feature、bug-fix、simplification、architecture、process、testing。目录随首篇笔记创建，不预建空目录，也不维护总索引。

| 状态 | 用途 | 处理方式 |
| --- | --- | --- |
| proposed | 尚未落地的方案 | 写清问题、方案、真实备选、验收条件和风险 |
| implemented | 当前已落地的决定 | 与代码同批更新，正文描述当前事实 |
| rejected | 被否决但值得防止重犯的方案 | 保留原方案和否决理由；没有长期价值就删除 |
| archived | 已被取代、仅供历史参考的已实施决定 | 从 implemented 移入；保留旧内容，不作为当前行为依据 |

feature 记录用户可见行为，bug-fix 记录重要缺陷的修复取舍，simplification 记录收窄或删除能力，architecture 记录代码结构和模块边界，process 记录工具与协作流程，testing 记录测试策略。

## 流转

1. 有新决策时先写 proposed；实现完成后，在同一次代码变更中移入 implemented。将 Status 改为 implemented，把 Proposal 改写成描述已落地事实的 Decision，并把验收结果、收益和代价写进 Consequences。
2. 未采纳的方案只有在其失败理由将来仍可能有用时才移入 rejected；在 Status 行写一句原因。
3. 新决定部分覆盖旧决定时，两篇已实施笔记都保留，更新仍成立的事实并互相链接。完全取代时，新笔记承接旧篇仍有用的约束、备选与代价；旧篇若还有历史参考价值，移入 archived，否则删除。
4. 归档时在原有 Status: implemented 下一行加入 Archived: YYYY-MM-DD，移动文件并修正活跃笔记中指向旧路径的链接。新笔记可以链接归档快照。归档正文保持原样。

链接笔记时使用相对 Markdown 路径。备选方案只记实际比较过的选项：先说明它最强的理由，再解释为何没选；不要为了凑数量编造方案。已实施笔记的 Consequences 同时写收益和代价。

## 写作模板

### proposed

~~~markdown
# Agent Note: <标题>

Status: proposed

## Problem

<要解决的问题及约束>

## Proposal

<拟采用的方案>

## Alternatives considered

<真实考虑过的备选：先写优势，再写未采用的原因>

## Acceptance criteria

<什么可观察结果代表完成>

## Risks

<风险、代价及必要时的回退条件>
~~~

### implemented

~~~markdown
# Agent Note: <标题>

Status: implemented

## Problem

<原问题及约束>

## Decision

<当前已经落地的决定、边界和理由>

## Alternatives considered

<真实考虑过的备选及未采用的原因>

## Consequences

<收益、代价及何时需要重新审视>

## Verification

<可选：从哪些路径、行为或命令确认决定仍然生效>
~~~

### rejected

~~~markdown
# Agent Note: <标题>

Status: rejected — <一句话原因>

## Problem

<原问题>

## Proposal

<当时提出的方案>

## Alternatives considered

<当时实际比较过的选项>

## Risks

<否决原因，以及什么条件变化后才值得重提>
~~~

archived 没有新模板，直接保留已实施笔记的正文并加归档日期。
