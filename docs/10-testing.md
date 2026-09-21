# Testing Strategy (emu-chat-v1)

本文档概述了 emu-chat 项目的测试策略和基础设施。

## 测试金字塔

项目采用标准测试金字塔模型：
- **单元测试 (Unit Tests)**: 12 个，覆盖核心纯函数、缓存逻辑、状态转换。
- **集成测试 (Integration Tests)**: 5 个，覆盖数据库、HTTP 路由、工作流协作。
- **组件测试 (Component Tests)**: 1 个，覆盖前端 React 组件及交互。

## 测试基础设施

- **测试框架**: `Vitest`，具备快速执行、原生支持 TypeScript 的特点。
- **数据库**: 使用 `better-sqlite3` 与 `:memory:` 内存模式确保测试间的隔离与极速。
- **UI 测试**: 采用 `@testing-library/react` + `jsdom` 进行组件渲染和 DOM 断言。
- **`FakeHermesServer`**: 完整的上游仿真系统 (基于 Fastify 进程)，支持 CRUD、Run 调度、SSE 事件流发送、审批模拟、幂等校验以及故障注入。
- **真实报文夹**: 使用 `real-hermes-021.fixture.ts` 导入真实匿名采样数据以确保协议兼容性。

## 测试文件覆盖范围简述

通过执行 `npm test`，测试套件将运行以下核心文件：

### 1. 核心流程与仓储 (Phase 1 & 2)
- **`phase1-repositories.test.ts`**: 测试数据仓储层，包含 CAS 操作、FIFO 队列读写、租约锁机制。
- **`phase2-conversations.test.ts`**: 验证会话全生命周期，包括 Session 轮转机制、CAS 冲突处理及删除的闭环逻辑。

### 2. 草稿与偏好 (Phase 3)
- **`phase3-draft-preferences.test.ts`**: 测试草稿的读写、偏好服务的保存以及数据尺寸校验。

### 3. 队列与运行 (Phase 4)
- **`phase4-queue-coordinator.test.ts`**: 验证队列入队流转与 SSE 游标的正确重放。
- **`phase4-queue-runs.test.ts`**: 测试草稿入队、幂等重放、审批流触发与完成、游标的严格校验。

### 4. 恢复与韧性 (Phase 5 & 6)
- **`phase5-stream-recovery.test.ts`**: 专注于异常情况：审批中断后的恢复、断线后 SSE 的精准回放、故障发生时的重试逻辑。
- **`phase6-fake-hermes-full-matrix.test.ts`**: 全功能矩阵测试，验证在离线环境下的系统韧性以及并发请求的租约隔离能力。

### 5. Hermes 适配与契约
- **`hermes-client.test.ts`**: 验证 HTTP 请求头的合规性、状态码的映射正确性以及 Liveness 探活超时。
- **`hermes-capabilities.test.ts`**: 测试不同服务端版本下能力评估矩阵的正确映射。
- **`hermes-adapter-real-contract.test.ts`**: 测试与 Hermes 0.21 真实契约的适配，包含 SSE 解包以及防混淆逻辑。

### 6. 流与前端机制
- **`sse-hub-contract.test.ts`**: 验证 SSE Hub：首帧到达、断档处理、心跳保活、并发连接限制及清理机制。
- **`message-display.test.ts`**: 测试空帧过滤与工具输出内容的 Markdown 格式化逻辑。
- **`conversation-view-cache.test.ts`**: 验证前端视图缓存的 LRU 淘汰机制。
- **`streamed-assistant-cache.test.ts`**: 测试流式数据的增量去重能力以及多个 Run 之间的数据隔离。
- **`queue-state.test.ts`**: 针对状态判断纯函数的高覆盖率测试。
- **`configuration.test.ts`**: 验证在空 API Key 时的安全降级逻辑。

### 7. UI 组件
- **`react-components.test.tsx`**: 覆盖组件级交互，包括删除确认弹窗、草稿防抖保存、队列项编辑、流式文本渲染、审批弹窗响应以及系统状态栏显示。

## 运行测试
开发环境或 CI 中可执行：
```bash
npm test
```
