# Agent Note: 增加 HTML 与 SVG 成果预览面板

Status: implemented

## Problem

用户希望在聊天中直接试用 Hermes 生成的单文件网页和 SVG 图标，并能查看源码、复制、下载，再通过聊天要求修改。原 [MessageView](../../../../src/client/features/messages/message-view.tsx) 只显示并复制代码块；Hermes 也没有供此功能使用的成果文件或版本 API。生成内容不可信，预览不能直接注入宿主页面。会话与消息的权威来源仍为 Hermes，emu-chat 不另存作品正文。

## Decision

- 从已保存的助手正文识别已闭合的 Markdown 代码围栏。`html` 中的完整文档，以及 `svg`、`xml`、`html` 中完整的独立 SVG 根元素可成为成果；普通片段、未闭合围栏、思考、工具输出、用户消息及流式回合没有预览入口。超过 256 KiB 的代码块继续作为普通代码。Markdown AST 提供代码原文和位置；HTML 标题用不创建浏览器元素的 parse5 读取，SVG 用 XML 解析并拒绝 DOCTYPE、实体声明和解析错误。显式 `svg` 围栏无效时按普通代码块显示、可复制，预览不可用。后来对正文中完整裸 SVG 的识别范围扩展见[修复笔记](../bug-fix/2026-09-29-recognize-unfenced-svg-in-assistant-replies.md)；成果按钮布局的收窄见[简化笔记](../simplification/2026-09-29-simplify-artifact-actions.md)。
- 成果引用包含本地会话 ID、Hermes 会话 ID、消息 ID、代码块序号和内容标识。面板持有选中时的源码快照；新消息和历史分页不会替换正在查看的作品。切换会话或关闭面板会销毁当前预览，SVG Blob URL 同时撤销。没有成果正文数据库、服务端文件读取或自动版本归并。
- 桌面宽屏在聊天右侧打开单个面板，窄屏覆盖全屏；草稿编辑器和消息视图不因开关面板而卸载。HTML、SVG 都能切换预览和源码、复制原文并下载原始文件；HTML 可主动重新运行。首次只查看源码时不创建 iframe。SVG 用 `<img>` 显示，提供缩放、适应面板及三种观察背景，背景不写入文件。
- HTML 放在只有 `allow-scripts` 的 sandbox iframe 中。应用在 `srcdoc` 的任何用户内容之前写入 CSP：允许内联脚本和样式以及数据图片/字体，阻止常见外部资源、fetch、嵌套框架、插件、表单、worker 和 base URI；不授予同源、顶层导航、弹窗或下载能力。源码与下载不包含这段包装。SVG 使用 `image/svg+xml` Blob URL 和 `<img>` 图片上下文，不以内联 DOM 或文档 iframe 呈现。父页面不向作品提供凭据、草稿、历史或 API 桥接。
- 继续修改仍通过现有聊天与草稿流程，用户要求小H返回新的完整文件后从新消息打开。不同消息的成果互不自动视为同一作品的版本。本决定遵循[会话视图隔离](../architecture/2026-09-26-guard-conversation-view-updates.md)。

## Alternatives considered

- **只保留代码复制和下载**：最少实现，但用户不能直接试用番茄钟、测验和图标效果。
- **在消息流中自动执行代码**：无需点击，但流式片段会反复启动，多个作品消耗资源，并让用户被动运行生成脚本。
- **读取 Hermes 服务器文件**：可覆盖多文件工程，但当前缺少文件归属、读取权限和生命周期接口；首版从消息里的自包含代码开始。
- **在线 IDE 与自动版本树**：适合复杂项目，但必须另定构建、依赖和作品身份规则。

## Consequences

用户可直接试用并保存单文件 HTML/SVG；旧结果仍能从旧消息打开。外部 CDN、图片、字体、接口和构建依赖不在首版支持范围，复杂 SVG 也可能影响浏览器响应。下载后独立打开的 HTML 不再受面板 CSP 和 sandbox 约束，SVG 作为文档打开也不同于图片上下文。

**HTML 预览不保证完全离线。** Chromium 实测阻止了普通资源加载与 fetch，却允许脚本让 iframe **自身**导航并发出 GET。CSP 元标签只约束当前 `srcdoc` 文档；`navigate-to` 在实测 Chromium 中不受支持。sandbox 阻止顶层导航、父页面读取和弹窗，但不能把自身导航变成可靠的网络隔离。因此界面明确提示这一限制，不向作品传入私密上下文；若将来需要“绝不向外发请求”的保证，必须采用更强的浏览器/网络隔离方案，不能仅调整 CSP 字符串。

## Verification

- `npm run typecheck`、`npm run lint`、`npm run format:check`、`npm run build` 通过；类型检查、构建及 11 项相关自动测试另在项目支持的 Node.js 22.23.3 下通过。测试核对 AST 围栏闭合、独立作品、非法 XML/SVG、超大代码块、普通助手与用户内容的执行区分，以及键盘关闭后的焦点归还、跨会话关闭预览与草稿保留。
- Chromium 151 的桌面与移动视口：HTML 按钮可操作，切源码不重启，主动重新运行会重置；HTML/SVG 下载均与消息代码一致；开关面板不丢当前草稿，切会话关闭面板并撤销 SVG Blob URL。只打开源码不创建 iframe。SVG 渐变及内部引用正常、缩放和背景切换可用。
- 同一真实浏览器中，iframe 读取父 DOM/存储抛出 `SecurityError`，fetch、外部图片、嵌套框架和弹窗均未发出请求，顶层导航被拒绝；SVG 图片中的脚本和外部图片没有发出请求。自身导航到测试域名确实发出 GET，已按上述限制记录。移动视口使用桌面 Chromium 仿真；尚未在 Safari/Firefox 或真实手机上验证。
