# emu-chat

emu-chat 是轻量、单用户、在线使用的 Hermes Agent Web 工作台。Hermes 是会话历史的唯一来源；emu-chat 只保存草稿、未发送队列、运行协调状态和少量 UI 元数据，不保存完整会话副本。

当前仓库处于实现与验证阶段。浏览器前端、Fastify 服务、SQLite 本地控制数据和 Fake Hermes 测试均位于本仓库；产品语义仍以批准的开发文档为准。

## 文档入口

建议按以下顺序阅读：

1. [项目章程与范围](dev-docs/00-项目章程与范围.md)
2. [产品需求与验收](dev-docs/01-产品需求与验收.md)
3. [系统架构与数据边界](dev-docs/02-系统架构与数据边界.md)
4. [Hermes 接口契约](dev-docs/03-Hermes接口契约.md)
5. [运行状态、队列与断线恢复](dev-docs/04-运行状态队列与断线恢复.md)
6. [会话生命周期与删除策略](dev-docs/05-会话生命周期与删除策略.md)
7. [部署、安全与渲染策略](dev-docs/06-部署安全与渲染策略.md)
8. [实施计划与验收测试](dev-docs/07-实施计划与验收测试.md)
9. [MVP 决策记录](dev-docs/08-待确认决策清单.md)
10. [内部 API 与错误包契约](dev-docs/09-内部API与错误包契约.md)
11. [页面信息架构与状态稿](dev-docs/10-页面信息架构与状态稿.md)
12. [Gemini 编码交接基线](dev-docs/11-Gemini编码交接基线.md)
13. [架构决策记录](dev-docs/adr/README.md)

若文档表述不一致，以 `08` 的已批准产品决策和 `11` 的精确编码约束为准；实现模型不得自行扩大 MVP 范围。

## 当前实现约束

- 实现模型只允许编写 `/home/emu/projects/emu-chat` 内的 emu-chat 文件。
- 不得修改 `/home/emu/.hermes/hermes-agent` 或 `/home/emu/projects/hermes-agent`。
- Gemini 编码阶段不得安装依赖、启动服务、运行 build/lint/typecheck/test、请求真实 Hermes 或做联调；所有运行验证留给后续人工或独立验证阶段。
- 不得以 Open WebUI、NextChat 或浏览器存储复制 Hermes transcript。

## 人工安装、运行与验证指南（由获准人员执行）

> 注意：根据交接基线，静态编写阶段不得安装依赖或运行命令。以下指令供后续人工/独立验证阶段执行。

### 1. 依赖安装

```bash
# 本项目要求 Node.js >=22.12 且 <23
# 在项目根目录下安装依赖
npm install
```

### 2. 静态检查与构建验证

```bash
# 类型检查
npm run typecheck

# 代码规范检查与格式
npm run lint
npm run format:check

# 前端与服务端编译
npm run build
```

### 3. 运行自动化测试套件

```bash
# 运行单元测试
npm test -- tests/unit

# 运行组件静态测试
npm test -- tests/components

# 运行 Fake Hermes 全矩阵集成测试
npm test -- tests/integration

# 运行端到端/全量矩阵验证
npm test -- tests/integration/phase6-fake-hermes-full-matrix.test.ts
```

### 4. 环境变量配置与本地运行

```bash
# 复制环境变量文件
cp .env.example .env

# 编辑 .env 配置 Hermes 服务地址与端口
# HERMES_BASE_URL=http://127.0.0.1:8642
# HERMES_API_KEY=your_token_here
# EMU_CHAT_PORT=3000

# 启动开发服务器（含 Vite 前端与 Fastify 后端代理）
npm run dev

# 或以生产模式启动
npm run build
npm start
```
