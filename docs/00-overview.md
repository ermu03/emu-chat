# emu-chat 项目概览

## 1. 项目定位

**emu-chat** 是一个轻量级的、针对单用户设计的 **Hermes Agent Web 工作台**。

它的核心设计哲学是：**上游 Hermes 是对话历史的单一真相源（Single Source of Truth）**。emu-chat 本身不存储聊天记录或会话内容的完整副本。系统自带的本地 SQLite 数据库仅用于保存以下辅助性控制数据：
- **草稿 (Drafts)**：用户正在编辑但未发送的消息。
- **会话登记与元数据 (Conversations)**：本地会话 ID、Hermes 会话映射及列表偏好。
- **消息队列 (Queues)**：等待发送或按序处理的消息队列。
- **运行记录 (Runs)**：当前和近期任务的协调及对账状态。
- **运行租约 (Leases)**：多任务协调控制状态。
- **UI 偏好 (Preferences)**：用户界面的显示设置和交互偏好。

本地会话登记表是列表的边界：外部 Hermes 客户端创建的会话不会通过刷新列表被自动导入。对于已登记的会话，emu-chat 会向 Hermes 拉取最新的会话和消息状态；上游已删除的会话会从本地登记表清理。

## 2. 技术栈

项目使用全栈 TypeScript，主要依赖如下。

### 前端生态
- **框架与视图**: React 19 + React Router DOM v7
- **构建与工程化**: Vite 7；静态 Web App Manifest 提供安装元数据
- **其他**: Lucide React 图标、React Markdown（渲染 Agent 消息）

### 后端生态
- **服务框架**: Fastify v5
- **数据库**: better-sqlite3 v12 (同步 SQLite 驱动)
- **流式处理**: `HermesClient` 用原生 Fetch 读取 Hermes SSE，并逐行解析事件帧

### 共享 / 工具
- **类型安全**: Zod v4 + TypeScript 5.9
- **模块规范**: 完全基于 ECMAScript Modules (ESM)，在 `package.json` 中声明了 `"type": "module"`
- **测试栈**: Vitest v3 + Testing Library (含 jsdom 和 user-event)

### 运行环境
- **Node.js**: 要求版本 **>= 22.12** 且 **< 23**

## 3. 主要目录结构

```text
emu-chat/
├── migrations/              # SQLite 数据库的初始化和迁移脚本，系统启动时会自动执行
├── src/
│   ├── client/              # 前端源码：包含 React 组件、页面状态、路由和浏览器 API 客户端
│   ├── server/              # 后端源码：Fastify HTTP 服务、业务服务、协调器与 Hermes 的集成适配
│   └── shared/              # 前后端共用的 API Schema、枚举和限制常量
├── tests/                   # 单元测试、组件测试和集成测试目录
├── public/                  # 静态资源，如系统图标和 Web App Manifest
├── docs/                    # 项目现状、API 参考与决策笔记规则
├── .agents/notes/           # 待处理提案与工程决策笔记
├── .agents/skills/          # 项目开发 Skill 的正文
├── .claude/skills/          # Claude Code 的项目 Skill 入口
├── data/                    # 运行时生成的 SQLite 数据库及数据存储目录
├── index.html               # 前端 Vite 运行入口页面
├── package.json             # 项目元信息、依赖定义及 npm 脚本
├── tsconfig.json            # 前后端通用的基础 TS 编译配置
├── tsconfig.server.json     # 专门针对后端 Node 环境的 TS 编译配置
└── vite.config.ts           # 前端构建及开发服务器代理配置
```

HTTP 端点见 [API 参考](08-api-reference.md)，重要技术取舍见 [决策笔记规则](decision-notes.md)及 .agents/notes/。

## 4. 开发模式 vs 生产模式

| 模式 | 启动命令 | 服务架构与端口 |
| --- | --- | --- |
| **开发模式** | `npm run dev` | 使用 `concurrently` 同时启动前端和后端：<br>1. **前端 (Vite)**：运行在 `5173` 端口，提供热更新（HMR）。发送到 `/api` 的请求自动代理到后端。<br>2. **后端 (Fastify)**：使用 `tsx watch` 启动，监听 `.env` 中的端口（例如 `3104`）；未配置时默认 `3000`。 |
| **生产模式** | `npm run build` <br> `npm start` | 只启动单一 Node 进程。Fastify 运行在 `.env` 指定端口（如 `3104`），不仅提供 `/api` 接口，还会使用 `@fastify/static` 处理并提供构建好的前端静态文件（SPA 模式）。 |

## 5. npm scripts 说明

| 脚本命令 | 描述 |
| --- | --- |
| `dev` | 启动完整开发环境，同时运行前后端服务 (`concurrently`)。 |
| `dev:server` | 以监听模式 (`tsx watch`) 启动后端服务。 |
| `dev:client` | 启动 Vite 前端开发服务器。 |
| `build` | 顺序执行前后端构建任务 (`build:client` 和 `build:server`)。 |
| `build:client` | 执行 Vite 构建打包，生成前端静态文件至 `dist/client` 目录。 |
| `build:server` | 执行 TypeScript 编译，使用 `tsconfig.server.json` 生成后端代码至 `dist/server` 目录。 |
| `start` | 设置 `NODE_ENV=production` 并运行编译后的后端主程序。 |
| `typecheck` | 对整个项目（包含前后端）进行 TypeScript 类型检查，不输出编译文件。 |
| `lint` | 运行 ESLint 检查代码规范。 |
| `format:check` | 运行 Prettier 检查代码格式。 |
| `test` | 使用 Vitest 执行测试套件。 |

## 6. 环境变量说明

可通过在项目根目录创建 `.env` 文件来配置系统：

复制 `.env.example` 后填写 Hermes API key 即可得到与 Vite 默认代理端口一致的开发配置；后端在未设置 `EMU_CHAT_PORT` 时仍默认监听 `3000`。

- `EMU_CHAT_HOST`：后端服务绑定的 IP，默认 `0.0.0.0` (允许局域网访问)。如果只允许本机可改为 `127.0.0.1`。
- `EMU_CHAT_PORT`：后端 API 监听的 HTTP 端口，默认 `3000`；开发模式建议设为 `3104`，与 Vite 的默认代理目标一致。
- `EMU_CHAT_SERVER_URL`：Vite 开发服务器的 `/api` 代理目标，默认 `http://127.0.0.1:3104`。后端使用其他端口时，须在启动 Vite 的 shell 环境中同步设置；后端读取的 `.env` 不会自动传给 Vite 配置。
- `EMU_CHAT_DATA_DIR`：本地运行时数据目录（包括 SQLite 数据库文件存放处），默认 `./data`。
- `HERMES_BASE_URL`：上游 Hermes Agent 的 API 根地址，如 `http://127.0.0.1:8642`。
- `HERMES_API_KEY`：用于向 Hermes 发起请求的鉴权 Token。
- `LOG_LEVEL`：日志级别配置，可选值包括 `trace`, `debug`, `info`, `warn`, `error`, `fatal`，默认 `info`。
- `NODE_ENV`：运行环境标识，影响应用的行为（比如静态文件的托管策略）。

## 7. PWA 支持

`public/manifest.webmanifest` 提供安装元数据，开发和生产环境使用同一文件。当前没有注册 Service Worker，也没有离线缓存；聊天和状态 API 仍需要连接后端与 Hermes。

## 8. 当前界面入口

新建会话直接创建标题为「新会话」的 Hermes 会话；顶部会话标题和列表三点菜单都能就地重命名。桌面端可拖拽侧栏右边界调宽，工具栏右上角可切换明暗主题。设置抽屉已从页面移除；发送快捷键偏好仍由数据库和 API 保存，当前页面没有修改入口。侧栏调宽时浏览器会缓存宽度，并在松手后尝试写入偏好 API。
