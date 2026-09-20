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

开发模式：

```bash
npm run dev
```

生产模式：

```bash
npm run build
npm start
```

## 验证

```bash
npm run typecheck
npm run lint
npm run format:check
npm run build
npm test
```
