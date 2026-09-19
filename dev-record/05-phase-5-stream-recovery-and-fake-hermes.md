# Phase 5 开发记录：流式重连恢复、工具调用卡片与 Fake Hermes 故障注入

## 实施目标
1. 建立前端基于 `EventSource` 的指数退避断线自动重连与 `Last-Event-ID` 回放机制；
2. 实现结构化的工具调用卡片（Tool Call Card）展示组件，支持入参、结果与错误状态折叠；
3. 构建轻量、内聚的 `FakeHermesServer`，支持模拟健康检查、会话消息、Run 启动、交互暂停审批与故障注入；
4. 编写 Phase 5 断线恢复、事件重放与审批集成的自动化测试套件。

## 创建与修改的文件
- `src/client/state/use-stream-events.ts`:
  - 前端 SSE 流事件 Hook，管理连接生命周期，处理 `onopen`, `onmessage`, `onerror`；
  - 实现断线自动重连，重连时自动追加 `Last-Event-ID` 参数，重试间隔以 1s, 2s, 4s... 指数退避（最大 15s）。
- `src/client/features/tools/tool-call-card.tsx`:
  - 工具调用可视化折叠卡片组件；
  - 支持 `pending`, `running`, `completed`, `failed` 四种执行状态的清晰徽标展示；
  - 格式化渲染参数 JSON 与调用输出。
- `tests/fixtures/fake-hermes/fake-hermes-server.ts`:
  - 内存级 Fake Hermes 协议实现，提供全套符合契约的响应结构；
  - 注入开关：`failNextRun`、`pauseNextRun`，支持模拟审批流转与网络失败。
- `tests/integration/phase5-stream-recovery.test.ts`:
  - 覆盖暂停审批决策提交及 upstream 消息落地；
  - 验证基于 `Last-Event-ID` 从环形缓冲恢复事件的能力；
  - 验证 Hermes 异常时的错误捕获与降级。

## 契约与规范核对
- **02 与 03 契约**：所有会话历史与消息生命周期由 upstream/Hermes 持久化，本地只维护协调事件；
- **08 决策**：审批接口支持 approve/reject 决策并驱动 Run 恢复；
- **09 契约**：流式传输采用统一信封结构 `StreamEventEnvelope`；
- **11 基线**：严禁内联 HTML 注入，工具展示采用安全 React 虚拟 DOM 树渲染。

## 尚未运行的验证命令
- `pnpm test tests/integration/phase5-stream-recovery.test.ts`
- `pnpm typecheck`

## 状态声明
本阶段严格遵循静态编码规范，未安装任何依赖包，未生成 lockfile，未启动任何服务，未向真实 Hermes 实例发起网络请求，未运行任何测试或联调。
