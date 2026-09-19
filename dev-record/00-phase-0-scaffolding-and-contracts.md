# Phase 0 开发记录：仓库骨架与共享契约

## 1. 本阶段实施目标
按照 `dev-docs/07-实施计划与验收测试.md` 与 `dev-docs/11-Gemini编码交接基线.md`，完成 Phase 0：
- 搭建前端（Vite + React 19 + PWA）与后端（Fastify 5 + better-sqlite3）基础骨架；
- 建立共享契约层（Zod request/response/SSE schemas、枚举、限额、ID 生成校验规范）；
- 建立服务端基础配置、安全日志敏感信息脱敏与统一错误处理契约；
- 编写初始 SQLite 迁移脚本与迁移运行器；
- 编写客户端应用壳与强类型 API Client；
- 生成与 `dev-docs/09-内部API与错误包契约.md` 严格一致的 OpenAPI 3.1 规范。

## 2. 新增与修改的文件清单
1. 基础配置与工程构建：
   - `package.json`：定义 ESM 依赖与规范中的构建/测试/开发脚本。
   - `tsconfig.json`：客户端及共享层 TypeScript 严格配置。
   - `tsconfig.server.json`：服务端 TypeScript 严格配置（NodeNext 模块解析）。
   - `vite.config.ts`：Vite 7 配置，集成 React 插件、PWA 配置及后端 API 代理（5173 -> 3000）。
   - `.env.example`：环境变量模板。
   - `index.html`：Web/PWA 宿主 HTML。
   - `public/manifest.webmanifest`：PWA 清单配置。
   - `public/icons/icon.svg`：PWA 与应用图标占位。

2. 共享契约与领域模型 (`src/shared/`)：
   - `src/shared/domain-enums.ts`：定义 Hermes 连接状态、队列项状态、本地/上游 Run 状态、暂停原因、审批选项、错误代码等全部批准枚举。
   - `src/shared/ids.ts`：定义规范的六种 ID 前缀（cv_, qi_, op_, lr_, rq_, ec_）及基于 UUIDv4 的生成和校验器。
   - `src/shared/limits.ts`：定义输入大小（64 KiB）、标题/标签长度限制、分页上限、队列上限、SSE 环形缓冲区上限等系统硬约束。
   - `src/shared/hermes-schemas.ts`：Hermes 原生接口的数据结构与 SSE 事件 Zod 解析 Schema。
   - `src/shared/api-schemas.ts`：依据 09 号文档定义的全部 27 个内部 API 路由 Request/Response/Error 契约。

3. 服务端基础层 (`src/server/`)：
   - `src/server/config.ts`：加载与严格校验环境变量配置。
   - `src/server/logging.ts`：安全日志记录器，强制脱敏 Token、密钥、用户输入、消息正文、工具参数与绝对路径。
   - `src/server/domain/errors.ts`：统一领域错误 `AppError` 及各个具体错误子类，包含序列化为标准错误响应包的辅助方法。
   - `src/server/db/migrate.ts`：SQLite 迁移执行器（PRAGMA WAL、foreign_keys、事务保证）。
   - `src/server/app.ts`：Fastify 应用工厂，配置统一 Request ID 生成、全局错误包装和静态资源挂载。
   - `src/server/index.ts`：服务启动入口与优雅停机处理。

4. 数据库迁移 (`migrations/`)：
   - `migrations/0001_initial.sql`：完整的初始 DDL，涵盖 conversations、drafts、queue_items、queue_recovery_payloads、runs、ui_preferences、client_request_dedup、admission_leases、operation_log 9 张表及相关索引。

5. 客户端基础层 (`src/client/`)：
   - `src/client/api/client.ts`：强类型的内部 API 客户端，封装状态、会话、消息、草稿、队列、Run、偏好设置和 SSE 事件流订阅。
   - `src/client/app.tsx`：工作台界面壳，包含连接状态栏、非安全局域网警告条、左右分栏与草稿输入占位。
   - `src/client/router.tsx`：基础路由挂载。
   - `src/client/main.tsx`：React 应用入口。
   - `src/client/index.css`：全局基础样式与暗色模式支持。

6. 接口规范 (`openapi/`)：
   - `openapi/emu-chat-v1.yaml`：覆盖全部 27 个端点、未扩展任何多余路由的标准 OpenAPI 3.1 规范文档。

## 3. 对应需求与契约的落实情况
- 严格遵循 `dev-docs/02-系统架构与数据边界.md`：本地数据库不包含消息历史副本（无 transcript/message 表），所有历史消息均只定义为通过 Hermes 会话接口按需查询。
- 严格遵循 `dev-docs/08-待确认决策清单.md`：无 archive 归档表或归档接口，无 Session-Key 概念，元数据修改仅限 title 与 pinned；支持乐观锁 revision 校验。
- 严格遵循 `dev-docs/09-内部API与错误包契约.md`：错误统一使用 `{ error: { code, message, retryable, action, request_id, ... } }`；HTTP 状态码和业务错误码一一映射。
- 严格遵循 `dev-docs/11-Gemini编码交接基线.md`：严格检查模块单向依赖（shared 不依赖 server/client，client 不依赖 server）；严格使用枚举白名单。

## 4. 声明与状态
- 本轮开发严格处于**静态编码与基线建立**阶段。
- **未安装任何依赖**（未执行 pnpm install / npm install / yarn）。
- **未生成 lockfile**。
- **未启动任何服务**（未运行 Fastify、Vite 或测试服务）。
- **未访问真实 Hermes 实例**。
- **未运行任何编译、类型检查、格式化、测试或联调命令**（未执行 tsc, eslint, prettier, vitest, playwright）。
