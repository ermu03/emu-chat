# Agent Note: 前端全方位视觉与交互体验升级

Status: implemented

## Problem

emu-chat 作为 Hermes Agent 的单用户 Web 工作台，核心状态机与后端通信已趋于完备，但前端展示层此前存在明显的初级工程后台质感：
1. **视觉层次与调色偏平淡**：原有深/浅色变量对比生硬，缺乏环境光扩散阴影（ambient shadows）与微高光边界，顶部与浮层缺乏现代工作台的通透毛玻璃质感。
2. **代码阅读与复制成本高**：Markdown 渲染出的代码块无一键复制功能，也缺乏标准的顶栏容器；在解析部分内联代码时存在结构嵌套不规整的问题。
3. **输入与排队区厚重**：底部草稿输入框在焦点状态下缺乏交互呼吸感，快捷键提示不直观。
4. **空状态缺少引导**：首次打开或进入空白会话时只有单调提示文本，缺乏现代 AI 工具的快捷指令引导卡片。

## Decision

在严格保持原有后端接口协议、并发单飞锁、草稿防丢机制及全部高风险测试（防误删复选框、发送失败保留输入、异步时序保护）不变的前提下，对前端展示层进行全方位系统性视觉与交互升级：

1. **升级现代 Design Tokens 与层次体系**（[src/client/index.css](../../../../src/client/index.css)）：
   - 优化深/浅双轨调色板，强调色（`--accent`）采用深邃青碧与鲜亮青碧色调，搭配纯净背景层级（`--canvas`、`--surface`、`--surface-subtle`、`--surface-raised`）。
   - 建立四级微阴影体系（`--shadow-sm`、`--shadow-soft`、`--shadow-float`、`--shadow-glow`），强化元素悬浮深度。
   - 顶部工具栏（`.main-toolbar`）与弹窗遮罩（`.confirmation-backdrop`、`.drawer-backdrop`）引入 `backdrop-filter: blur(...)` 毛玻璃质感。
   - 全局引入纤细半透明圆角药丸滚动条及平滑贝塞尔曲线微动效（`cubic-bezier(0.16, 1, 0.3, 1)`）。

2. **代码块顶栏与一键复制功能**（[src/client/features/messages/message-view.tsx](../../../../src/client/features/messages/message-view.tsx)）：
   - 封装独立 `CodeBlock` 组件，为多行代码块提供暗色磨砂顶栏，左侧显示语言药丸标签，右侧提供一键复制按钮。
   - 复制触发后提取纯文本并写入剪贴板，平滑切换为绿色对勾图标与「已复制」状态，2 秒后自动恢复。
   - 区分块级代码与普通行内代码，确保段落中的单个行内代码正常应用内联胶囊样式。

3. **空状态欢迎页与快捷开始建议**（[src/client/features/messages/message-view.tsx](../../../../src/client/features/messages/message-view.tsx) & [src/client/app.tsx](../../../../src/client/app.tsx)）：
   - 空会话页面引入精致的 Hermes 发光图标徽章。
   - 新增 4 张针对软件工程高频场景的快捷建议卡片（系统架构分析、代码性能优化、高风险测试编写、新功能方案头脑风暴）。
   - 用户点击建议卡片时，通过 `onSelectPrompt` 将建议交给 `DraftComposer`，输入框接收文本并聚焦，随后走常规草稿保存流程；输入框已有用户内容时会提示先清空。发送前保存约束见[建议卡片草稿修正决定](../bug-fix/2026-09-24-save-prompt-starter-draft.md)。

4. **底部输入框悬浮岛（Floating Island）**（[src/client/features/composer/draft-composer.tsx](../../../../src/client/features/composer/draft-composer.tsx)）：
   - 输入框容器改用现代化大圆角（`18px`），获得焦点时（`:focus-within`）触发主题色外发光光环扩散（Ring Glow）。
   - 底部状态栏集成等宽按键提示胶囊（`⌘/Ctrl + ↵ 发送`）。
   - 发送按钮优化为渐变圆角微动效按钮，hover 轻微上浮，发送中与禁用态优雅呈现。

5. **侧边栏与排队面板统一**（[src/client/features/conversations/conversation-list.tsx](../../../../src/client/features/conversations/conversation-list.tsx) & [src/client/features/queue/queue-panel.tsx](../../../../src/client/features/queue/queue-panel.tsx)）：
   - 侧边栏当前激活项改用圆角胶囊悬浮态 + 柔和主题色背景 + 左侧微指示条。
   - 排队面板卡片与状态胶囊更圆润紧凑。

## Alternatives considered

- **引入 Tailwind CSS 等外部重量级原子化框架**：样式编写更简单，但会引入庞大的依赖链和构建体积，且破坏项目原生 CSS 变量设计系统的简洁性与完全受控性；原生语义化变量与纯 CSS 已足够完成高品质交互。
- **仅进行局部样式打磨（只改颜色或只改代码块）**：改动范围虽小，但由于字体、输入框、工具栏与空状态风格未协同调整，会导致整体视觉体验割裂、缺乏现代产品的统一质感。

## Consequences

- **收益**：界面品质达到现代主流 AI 工具（如 Linear / Claude Web）的视觉与交互水准，代码复制和快速开始交互显著降低用户操作成本；所有改造无额外运行时依赖，完全向后兼容现有的所有状态流转与网络逻辑。
- **代价**：增加了部分展示层组件（如代码块复制组件、空状态卡片）和样式规则，维护时需确保样式选择器与无障碍属性（`aria-label`、`title`）继续保持对测试断言的稳定性。

## Verification

- 运行全部自动化测试套件：`npm test`（9 个测试文件、45 个测试用例全部通过，重点验证高风险删除确认防误触、草稿网络失败防丢保护等核心逻辑）。
- 运行代码类型检查与规范检查：`npm run typecheck && npm run lint && npm run format:check`。
- 运行全量构建：`npm run build`。
