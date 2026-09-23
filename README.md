# emu-chat

emu-chat 是轻量、单用户、在线使用的 Hermes Agent Web 工作台。Hermes 是会话历史的唯一来源；emu-chat 只保存草稿、未发送队列、运行协调状态和少量 UI 元数据，不保存完整会话副本。

emu-chat 是单用户 Hermes Web 工作台。Hermes 保存会话历史，emu-chat 保存草稿、队列和运行控制状态；外部 Hermes 客户端创建的会话不会自动出现在 emu-chat 中。

## 运行

```bash
# Node.js >=22.12 且 <23
npm install
```

在项目根目录创建 `.env`，填写 Hermes 地址、API key 和端口：

```bash
HERMES_BASE_URL=http://127.0.0.1:8642
HERMES_API_KEY=your_token_here
EMU_CHAT_PORT=3000
```

环境变量说明：

- `EMU_CHAT_HOST=0.0.0.0`：让 emu-chat 监听本机所有网络接口，局域网内的其他设备也可以访问。如果只允许本机访问，可改为 `127.0.0.1`。
- `EMU_CHAT_PORT=3104`：emu-chat 后端 API 使用的 HTTP 端口。生产模式下也由这个端口提供前端页面；端口必须没有被其他程序占用。

## 项目目录

```text
emu-chat/
├── migrations/              # SQLite 数据库迁移脚本，启动时自动执行
├── src/
│   ├── client/              # React 前端、页面状态和浏览器 API client
│   ├── server/              # Fastify HTTP 服务、Hermes 适配器和队列协调器
│   └── shared/              # 前后端共用的 schema、类型、枚举和限制
├── tests/                   # 单元、组件和集成测试
├── public/                  # PWA manifest 和静态图标
├── docs/                    # 当前架构、API 与决策笔记规则
├── .agents/notes/           # 待处理提案与四状态工程决策笔记
├── .agents/skills/          # 项目开发 Skill 的唯一正文
├── .claude/skills/          # 指向项目 Skill 的 Claude Code 入口
├── data/                    # 运行时 SQLite 数据库目录
├── index.html               # Vite 前端入口
├── package.json             # npm 脚本和依赖
├── AGENTS.md                # Codex 与 Claude 共用的开发规范
├── CLAUDE.md                # Claude Code 导入 AGENTS.md 的入口
└── vite.config.ts           # 前端构建配置
```

系统现状见 [项目文档](docs/00-overview.md)，HTTP 接口见 [API 参考](docs/08-api-reference.md)。待处理问题与改进方案见 [proposed 笔记](.agents/notes/proposed/)，重要技术取舍遵循[决策笔记规则](docs/decision-notes.md)。

开发模式：

```bash
npm run dev
```

开发模式会同时启动两个服务：Vite 前端开发服务器默认使用 `5173`，Fastify 后端使用 `.env` 中的 `EMU_CHAT_PORT`（例如 `3104`）。浏览器应打开 `http://<主机地址>:5173/`；前端发往 `/api` 的请求会由 Vite 自动转发到 `3104` 后端。Vite 端口被占用时可能自动改用下一个可用端口。

生产模式：

```bash
npm run build
npm start
```

生产模式不启动 Vite，Fastify 会同时提供构建后的前端页面和 API，因此只需访问 `http://<主机地址>:3104/`。

## 验证

```bash
npm run typecheck
npm run lint
npm run format:check
npm run build
npm test
```
