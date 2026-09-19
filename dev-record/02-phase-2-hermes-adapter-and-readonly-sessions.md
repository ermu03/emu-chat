# Phase 2 改动记录：Hermes Adapter 与只读会话

## 1. 改动概述
完成了 Phase 2 的静态代码、测试用例与前端只读会话工作台实现。
核心目标包括：构建专供服务端使用的 Hermes Bearer Client、超时控制、Hermes 适配器（Zod 校验与错误映射）、只读会话生命周期与消息代理（严格遵循 Hermes 唯一真理源，零本地消息副本）、连接状态机探测以及只读前端 UI（连接状态栏、会话列表、当前 segment 提示与 Markdown 安全渲染）。

## 2. 新增与修改文件
- `src/server/hermes/capabilities.ts`：Hermes 契约能力评估器，严格判定 8 项核心功能支持度、runs_idempotency、durable、retention_seconds >= 86400 与 runtime/tool 执行模式。
- `src/server/hermes/client.ts`：Server-only Hermes HTTP 客户端，封装 AbortSignal 超时控制、Bearer Token 注入、统一错误映射（401/403/404/409/408/425/429/5xx 与协议损坏解析异常）、脱敏日志，禁止发送 `X-Hermes-Session-Key`。
- `src/server/hermes/adapter.ts`：Hermes 协议适配层，包含 detailed health、session list/detail/messages、create/update/fork/delete，所有响应均通过 Zod Schema 进行严格 safe-parse。
- `src/server/services/status-service.ts`：连接状态服务，支持状态探测、短缓存与主动 recheck，检测 LAN HTTP 非安全上下文。
- `src/server/services/conversation-service.ts`：会话编排服务，从 Hermes 获取会话列表时懒同步至本地会话表与初始草稿、代理直读会话历史消息（零本地持久化）、维护 effective segment 切换、支持 revision CAS 本地元数据更新与删除门禁。
- `src/server/db/repositories/conversation.repository.ts`：扩展会话仓储，增加 `updateHermesSessionId`（支持 compression tip 切换）与 `updateLastSeen`。
- `src/server/db/repositories/run.repository.ts`：扩展 `findActiveAll` 支持全局活跃 Run 查询。
- `src/server/http/routes/status.ts`：Fastify 状态路由（`GET /api/v1/status`、`POST /api/v1/status/recheck`）。
- `src/server/http/routes/conversations.ts`：Fastify 会话路由，提供完整的 9 个会话相关契约端点。
- `src/server/app.ts`：整合依赖注入、注册状态与会话路由。
- `tests/fixtures/hermes/health.fixture.ts`：Hermes 健康与能力契约 Mock Fixture。
- `tests/fixtures/hermes/sessions.fixture.ts`：Hermes 会话列表与详情 Mock Fixture。
- `tests/fixtures/hermes/messages.fixture.ts`：Hermes 会话消息历史 Mock Fixture。
- `tests/unit/hermes-capabilities.test.ts`：Hermes 能力兼容性单元测试用例。
- `tests/unit/hermes-client.test.ts`：Hermes 客户端请求头、超时与 HTTP 错误映射单元测试用例。
- `tests/integration/phase2-conversations.test.ts`：会话接口集成测试用例（覆盖懒同步、零消息落地直读、revision CAS 冲突与删除门禁）。
- `src/client/features/status/status-bar.tsx`：连接状态、能力标签、运行计数与局域网 HTTP 警告横幅。
- `src/client/features/conversations/conversation-list.tsx`：会话列表组件，支持置顶/常规分组、精确 ID/标题过滤、新建、Fork 与二次确认删除。
- `src/client/features/messages/current-segment-banner.tsx`：当前会话片段提示栏，清晰标示当前 effective segment 与父会话继承来源，严格遵循不拼接父历史规则。
- `src/client/features/messages/message-view.tsx`：安全消息渲染视图，采用纯虚拟 DOM 渲染与链接重写，工具调用折叠卡片化，绝不使用 dangerouslySetInnerHTML。
- `src/client/app.tsx`：工作台主页面，串联状态检测、会话管理与消息查看。

## 3. 需求与契约对齐
- 遵循 02 与 03 契约：Hermes 为唯一真理源，本地 SQLite 无任何 transcript/messages 表，消息列表完全由 upstream 代理返回。
- 遵循 08 决策：会话只通过 revision 乐观锁更新 local-metadata；无 archive 状态；搜索仅限于精确 ID 与标题匹配；会话删除严格校验 `expected_hermes_session_id`、活跃队列项以及 Hermes active_agents 门禁。
- 遵循 09 契约：全部 11 个 Phase 2 端点完全对齐契约 Schema 与统一错误包。
- 遵循 11 交接基线：前端严禁 dangerouslySetInnerHTML，链接强制带 `rel="noreferrer noopener"`，工具调用使用折叠卡片呈现。

## 4. 静态约束声明
本阶段严格遵循无侵入开发约束，未安装任何依赖包（未执行 `pnpm install`），未生成 lockfile，未启动本地/远程服务，未向真实 Hermes 实例发起网络请求，未运行任何测试、编译、代码检查或联调。
