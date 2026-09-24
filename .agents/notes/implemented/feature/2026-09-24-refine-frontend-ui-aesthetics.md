# Agent Note: 前端视觉美化与细节交互质感升级

Status: implemented

## Problem

在前期完成基础视觉规范落地（参见 [2026-09-23-modernize-ui-presentation.md](2026-09-23-modernize-ui-presentation.md)）后，当前前端界面仍保留了较多工程后台的粗硬感，与现代高水准 AI 工作台（如 Linear、Raycast、Claude Web）相比，存在以下明显痛点：

1. **新建会话交互生硬破壁**：
   - 点击「新建会话」时调用浏览器原生 `window.prompt`，在页面顶部弹出粗糙的系统级灰色输入框，打断操作沉浸感，脱离了现代 AI 工作台「即开即用、零阻滞新建」的流畅体验。
2. **Logo 与标题区域框体冗余粗糙**：
   - 中间顶部会话标题前保留了一个带方框的字母「e」，在核心阅读区显得多余而突兀；
   - 侧边栏顶部品牌位同样是一个生硬的字母方框，现有 `icon.svg` 为老旧的蓝色简陋气泡，与当前系统的深色冷石板和青碧设计语言完全不符。
3. **字体大小偏小导致阅读吃力**：
   - 消息文本和代码字号较小，行距紧凑，在长文本分析场景下容易产生视觉疲劳；界面其他辅助区域的文字字号亦偏小。
4. **暗色基底生硬，缺少环境光与层次感**：
   - 当前深色模式主要依靠纯黑与硬灰色块（`#0d0f12`、`#15181c`），组件边缘线条生硬；高饱和度青绿（`#2dd4bf`）在暗色底上略显刺眼，对比突兀。
5. **侧边栏视觉焦点不协调**：
   - 「+ 新建会话」使用全填充高亮实心药丸按钮，喧宾夺主；
   - 会话列表激活项采用左侧单根绿色垂直线，在暗色背景下显得突兀断层；时间与消息数堆叠排版偏紧凑。
6. **思考过程与工具调用展示厚重粗糙**：
   - 纯文本思考折叠框直接呈现为一个长条灰框，缺乏思考流动感与层级区分；
   - 工具调用卡片边缘硬朗，状态标签单调，缺乏现代 DevOps / 终端的专业精致度。
7. **底部草稿输入区缺少悬浮通透与按键质感**：
   - 输入框外框线条较重，常驻显眼的 `0 / 65,536 bytes` 带来不必要的技术后台压迫感；
   - 快捷键提示仅为扁平文字，发送按钮偏居一隅且缺少立体微动效。
8. **顶部栏单薄且缺少快捷操作**：
   - 顶部工具栏仅靠标题和边栏折叠按钮，右侧设置入口单一，未提供无需进入抽屉即可切换深/浅主题的快捷控制。

## Decision & Implementation

在保证所有现有接口协议、状态机流转、无障碍属性（`aria-label` / `role` / `data-message-id`）以及 4 项高风险核心交互机制（防误删确认、草稿断网防丢、异步竞态安全、跨会话隔离）100% 稳定的前提下，系统化完成前端展示层重构：

### 1. 新建会话交互重塑：即开即建与就地重命名 ([src/client/app.tsx](../../../../src/client/app.tsx))
- **无感新建**：彻底移除 `window.prompt` 原生顶栏弹窗。点击「新建会话」时立即发起创建请求（默认标题「新会话」），瞬时完成并自动切换选中、聚焦输入框，交互一气呵成；
- **顶部标题就地重命名**：中间顶部工具栏支持点击会话标题直接就地内联编辑（悬停显示微调铅笔），用户在需要自定义标题时随时可优雅修改（Enter 保存，Escape 撤销），并同步回写 Hermes 元数据。

### 2. Logo 图标重构与标题区通透化 ([src/client/app.tsx](../../../../src/client/app.tsx) & [src/client/features/conversations/conversation-list.tsx](../../../../src/client/features/conversations/conversation-list.tsx))
- **移除会话标题前的方框**：彻底去掉中间工具栏会话标题左侧的 `brand-mark`（方框+e），使主工作区顶部视野开阔，标题聚焦清晰；
- **启用全新重画的矢量 Brand Icon**（采用 [public/icons/icon.svg](../../../../public/icons/icon.svg)）：
  - 融合 **emu（轻灵流动）** 与 **chat/agent（智能思维脉冲、多维节点）** 意象；
  - 采用深石板暗光底板 + 渐变翡翠翠玉（Emerald-Teal `#14b8a6`, `#2dd4bf`, `#5eead4`）科技微光线条，侧边栏作为高质量品牌 Mark 渲染，折叠状态自适应居中。

### 3. 全局字号阶梯放大与可读性优化 ([src/client/index.css](../../../../src/client/index.css))
- **聊天正文与代码字号**：
  - 聊天正文 `.message-body` 字号由 `14.5px` 提升至 `15.5px`（移动端 `14.5px`），行高调整至 `1.76`，字间距略作平滑微调（`-0.005em`）；
  - 代码块 `.message-code pre` 代码字号由 `13px` 放大至 `13.5px`，行高由 `1.62` 增至 `1.65`；
- **全局其他区域字号阶梯**：
  - 基础 `body` 字体由 `14px` 放大至 `15px`；
  - 顶部会话标题 `.main-toolbar-title` 由 `13.5px` 提升至 `15px`；
  - 侧边栏会话标题 `.conversation-title` 提升至 `14px`；
  - 输入框文本 `.composer-textarea` 由 `14.5px` 提升至 `15px`；
  - 角色标签 `.message-role` 提升至 `14px`，时间戳提升至 `12px`；
  - 状态栏与侧栏底部文本字号均微调放大，清晰护眼。

### 4. 现代 Design Tokens 与暗色光影重塑 ([src/client/index.css](../../../../src/client/index.css))
- **深色基底转向深曜石/冷石板体系（Obsidian / Zinc）**：
  - Canvas 调整为深邃的 `#0b0f14`，Surface 为 `#12171e`，高亮层 `#1f2733`；
  - 强调色升级为高质感温润的翡翠青绿（`#2dd4bf` / `#5eead4` / `#14b8a6`），与应用品牌图标完美契合；
  - 引入内高光边框阴影（Inner border highlight），提升容器微立体厚度感与层级分界。

### 5. 侧边栏呼吸感与会话项精致化 ([src/client/features/conversations/conversation-list.tsx](../../../../src/client/features/conversations/conversation-list.tsx))
- **新建会话按钮**：采用微渐变科技翡翠风格（`accent-light` 到 `accent-strong`），悬停带有平滑微上浮与光泽投影；
- **会话项样式**：激活态平滑融入背景，保留柔和圆角卡片感与精致翡翠色指示标条；
- **元信息排版**：相对时间与消息数清晰分布，视觉舒适自然。

### 6. 灵动思考流与终端风格工具卡片 ([src/client/features/messages/message-view.tsx](../../../../src/client/features/messages/message-view.tsx))
- **思维流折叠块 (Reasoning)**：
  - 纯思考过程采用专属 `.reasoning-card`，左侧带有贯通的渐变导引轴 `.reasoning-trace-line`，配合 Sparkles 微光图标与深邃背景流；
- **DevOps 风格工具调用卡片 (Tool Calls)**：
  - 终端风格输入输出区域，参数与状态胶囊清晰可见；
- **消息气泡排版**：
  - 用户气泡应用极深冷灰渐变与圆角弧度优化，配合顶部 1px 细微高光，彻底摆脱单调方框。

### 7. 悬浮岛输入区与键帽交互升级 ([src/client/features/composer/draft-composer.tsx](../../../../src/client/features/composer/draft-composer.tsx))
- **毛玻璃悬浮岛**：获得焦点时触发柔和环状光晕（Ambient Ring Glow）；
- **拟物立体键帽 (Kbd Keycap)**：快捷键提示升级为拟物风格的键盘键帽样式（`.kbd-cap`），直观呈现 `↵` 或 `⌘ / Ctrl` + `↵`；
- **字节统计低扰动化**：等宽紧凑字号，溢出时醒目警示；
- **发送按钮质感**：微渐变高光按钮，悬停上浮与点击微缩。

### 8. 顶部工具栏与快捷主题切换 ([src/client/app.tsx](../../../../src/client/app.tsx))
- 增强顶部栏的毛玻璃通透感；
- 在右侧设置按钮旁增加一键切换明暗主题（☀️ / 🌙）的快捷按钮，直接联动偏好设置 API，切换平滑无卡顿。

## Verification

1. **自动化构建与类型校验**：
   - `npm run typecheck`：通过（0 错误）；
   - `npm run lint`：通过（0 警告，0 错误）；
   - `npm test`：11 个测试套件，50 项测试全部通过（100% passed）。
2. **核心业务无害性验证**：
   - 确认对话删除的双重手动勾选确认弹窗逻辑依旧完整；
   - 异步草稿保存防竞态逻辑安全；
   - 切换会话时跨会话隔离与响应丢弃逻辑验证通过。
