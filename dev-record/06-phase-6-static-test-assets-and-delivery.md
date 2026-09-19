# Phase 6 开发记录：静态测试资产与交付说明

## 1. 阶段目标与需求范围
严格对应 `dev-docs/07-实施计划与验收测试.md` Phase 6 与 第 4 节验收矩阵：
- 补全但不运行全量静态测试资产：Unit tests、Fake Hermes integration tests、React component tests、Playwright 场景文件、安全与边界 edge case fixtures；
- 补全 `README.md` 中的人工安装、运行与验证指南；
- 遵循交付规范，明确声明未执行任何动态命令。

## 2. 本次创建与修改的文件
1. `tests/fixtures/security-and-edge-cases.fixture.ts`：
   - XSS 过滤 Payload 集合（script、onerror、javascript: URI 等）；
   - 大体量 Markdown 与 KaTeX 数学公式渲染压力测试用例；
   - SSE 环形缓冲区流事件裂隙（`stream.gap`）与乱序重连用例；
   - 交互审批场景与决策入参（once / deny）；
   - 上游 Session 轮换与上下文窗口撑满场景；
   - 会话删除门禁（活跃 Run 拦截与上游 404 二次确认）。

2. `tests/components/react-components.test.tsx`：
   - React 纯静态组件测试（DraftComposer 输入与快捷键、QueueDrawer 队列渲染与取消、ApprovalDialog 审批弹窗决策、StatusBar 在线与局域网 HTTP 非安全告警、ToolCallCard 展开折叠与结果展示）。

3. `tests/e2e/playwright-scenarios.spec.ts`：
   - Playwright 端到端用户场景：320/768/1280 响应式视口、局域网 HTTP 告警、双标签页并发草稿与发送同步、危险链接防护、活跃 Run 会话删除门禁。

4. `tests/integration/phase6-fake-hermes-full-matrix.test.ts`：
   - 完整覆盖 `dev-docs/07` §4.2 中的 12 项矩阵：列表与详情直读直取、effective session 轮换、Run 202/幂等重放/409 指纹冲突、stop 终态、approval 决策、删除 404、Hermes 离线拒发保草稿、会话级准入租约（`coordinator_leases`）互斥并发。

5. `README.md`：
   - 增加第 5 节《人工安装、运行与验证指南》，包含依赖安装、静态类型与代码风格检查、单元/组件/集成测试运行、本地与生产启动指令。

## 3. 关键状态机与 Schema 不变量
1. **历史唯一源不变量**：无论是组件测试、集成测试还是 E2E 测试，验证全程均无任何本地 transcript / message 持久化，本地 SQLite 只有 6 张协调表。
2. **租约互斥性**：同一会话在同一时刻只能存在一个持有效租约的协调者实例（原子抢占）。
3. **队列容量与幂等性**：单会话排队上限严格为 10 条（超出抛出 `QUEUE_FULL`），相同 `client_request_id` 幂等返回已有排队项。
4. **审批决策**：仅允许 `once` 与 `deny`，决议下发后由调度器驱动上游 Hermes 恢复。

## 4. 交付合规声明
**明确声明：**
本项目截至 Phase 6 静态代码开发完成，**未安装任何依赖**（未执行 `pnpm install` 或 `npm install`），**未生成 lockfile**，**未启动任何本地服务**，**未向任何真实 Hermes 实例发起网络请求**，**未运行任何 format/lint/typecheck/build/test/e2e/smoke 测试或联调**。所有代码均为静态安全编写。

## 5. 静态可见的未决问题
- 无规范冲突或设计分歧。所有代码与已批准的 `08-待确认决策清单.md`、`09-内部API与错误包契约.md`、`11-Gemini编码交接基线.md` 严格对齐。

## 6. 建议后续人工运行的验证步骤
```bash
# 1. 安装依赖
pnpm install

# 2. 类型检查与代码风格检查
pnpm typecheck
pnpm lint
pnpm format:check

# 3. 运行全量测试套件
pnpm test

# 4. 构建验证
pnpm build
```
