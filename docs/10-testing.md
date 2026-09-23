# 测试策略

测试范围遵循 [AGENTS.md](../AGENTS.md) 的必要测试原则：只检查复杂状态、并发边界、上游协议和会造成数据丢失的交互，不以覆盖率为目标。简单 CRUD、基础缓存读写和静态组件渲染不单独测试。

## 保留的测试

| 层级 | 文件 | 保障的行为 |
| --- | --- | --- |
| 单元 | `tests/unit/phase1-repositories.test.ts` | 元数据与草稿 CAS、会话映射时保留草稿、队列 FIFO/幂等/深度上限、租约互斥与令牌校验 |
| 单元 | `tests/unit/hermes-client.test.ts` | 认证头、安全边界、错误映射、SSE 存活超时 |
| 单元 | `tests/unit/hermes-capabilities.test.ts` | Hermes 必需能力与健康状态评估 |
| 单元 | `tests/unit/hermes-adapter-real-contract.test.ts` | 匿名真实 Hermes 0.21 报文的规范化、Run 接纳和 SSE 契约 |
| 单元 | `tests/unit/sse-hub-contract.test.ts` | 浏览器 SSE 广播、断线重放、缺口和缓冲限制 |
| 集成 | `tests/integration/phase4-queue-runs.test.ts` | 草稿原子入队与幂等、协调器派发、审批与终态对账，以及保留数据库和上游状态的服务重建恢复 |
| 组件 | `tests/components/react-components.test.tsx` | 删除前复选确认、发送失败保留草稿、旧保存 ACK 不覆盖新输入 |

集成测试用 `FakeHermesServer` 提供可控的 Hermes HTTP/SSE 服务，用内存 SQLite 隔离用例；协议测试使用 `tests/fixtures/hermes/real-hermes-021.fixture.ts` 中的匿名报文。重建恢复用例会关闭并重建 Fastify 实例，沿用同一数据库和 Fake Hermes，以验证已接纳 Run 继续对账；它不启动或杀死独立操作系统进程。

## 运行

```bash
npm test
npm run typecheck
npm run lint
npm run format:check
```

新增测试前先判断失败风险和现有用例是否已覆盖该行为；业务变更导致旧测试失败时，先判断断言是否过时或过细。详见 [AGENTS.md](../AGENTS.md)。
