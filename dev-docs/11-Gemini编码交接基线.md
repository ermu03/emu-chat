# Gemini 编码交接基线

状态：MVP 已批准，可据此静态编码
更新时间：2026-09-19

本文是给实现模型的最高优先级编码说明。产品语义以 `08` 为准，浏览器 API 以 `09` 为准；本文件固定技术栈、目录、DDL、事务和实现禁区。若三者冲突，停止相关模块并报告，不自行取舍。

## 1. 本次交付权限

只可修改 `/home/emu/projects/emu-chat`。不得修改、复制覆盖或自动 patch：

- `/home/emu/.hermes/hermes-agent`
- `/home/emu/projects/hermes-agent`
- `/home/emu/projects/open-webui`
- `/home/emu/projects/NextChat`
- `/home/emu/Obsidian`

只写代码、配置、migration、fixture 和测试源码。禁止安装依赖、生成伪 lockfile、启动进程、访问真实 Hermes、运行 format/lint/typecheck/build/test/e2e/smoke。交付必须明确声明未运行。

## 2. 固定运行时与依赖白名单

### 2.1 Runtime

- Node.js：`>=22.12 <23`
- pnpm：`>=10 <11`
- TypeScript：`>=5.9 <6`
- package type：ESM（`"type":"module"`）
- strict TypeScript：`strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`

Gemini 写 `package.json`，但不写 `pnpm-lock.yaml`；lockfile 只能由后续获准安装依赖的人生成。

### 2.2 Runtime dependencies

只能使用下列 major line；不得擅自增加框架、ORM、认证、WebSocket 或 UI kit：

| 包 | 版本范围 | 用途 |
| --- | --- | --- |
| `fastify` | `^5.0.0` | HTTP 服务 |
| `@fastify/static` | `^8.0.0` | 生产静态前端 |
| `better-sqlite3` | `^12.0.0` | emu-chat SQLite |
| `zod` | `^4.0.0` | 所有边界 schema |
| `eventsource-parser` | `^3.0.0` | Hermes SSE 解析 |
| `react` / `react-dom` | `^19.0.0` | UI |
| `react-router-dom` | `^7.0.0` | SPA 路由 |
| `@tanstack/react-query` | `^5.0.0` | 服务端状态缓存；禁用持久化 |
| `zustand` | `^5.0.0` | 仅临时 UI/stream 状态；禁用 persist middleware |
| `react-markdown` | `^10.0.0` | Markdown |
| `remark-gfm` | `^4.0.0` | GFM |
| `remark-math` | `^6.0.0` | 数学语法 |
| `rehype-sanitize` | `^6.0.0` | 输出净化 |
| `rehype-katex` | `^7.0.0` | 数学渲染 |
| `katex` | `^0.16.0` | KaTeX runtime/CSS |
| `rehype-highlight` | `^7.0.0` | 静态代码高亮 |
| `highlight.js` | `^11.0.0` | 高亮语言/样式 |

不要加入 `rehype-raw`。raw HTML 必须保持禁用。

### 2.3 Dev dependencies

允许：Vite 7、`@vitejs/plugin-react` 5、`vite-plugin-pwa` 1、`tsx` 4、Vitest 3、Testing Library 16、user-event 14、jsdom 26、Playwright 1、ESLint 9、typescript-eslint 8、Prettier 3、`concurrently` 9，以及相应 `@types/*`。

测试依赖只用于写测试文件，本轮不得执行。不要添加 Jest、Cypress、Tailwind、Next.js、Prisma、Drizzle、Sequelize、Knex、Socket.IO 或 axios；Node 22 原生 `fetch` 足够。

## 3. 固定 scripts

`package.json` 预留以下脚本名称，具体命令按目录实现：

```json
{
  "dev": "concurrently -k -n server,client ...",
  "dev:server": "tsx watch src/server/index.ts",
  "dev:client": "vite",
  "build": "pnpm build:client && pnpm build:server",
  "build:client": "vite build",
  "build:server": "tsc -p tsconfig.server.json",
  "start": "node dist/server/index.js",
  "typecheck": "tsc -p tsconfig.json --noEmit && tsc -p tsconfig.server.json --noEmit",
  "lint": "eslint .",
  "format:check": "prettier --check .",
  "test": "vitest run",
  "test:e2e": "playwright test"
}
```

不要在 install/postinstall/prestart 中运行 migration 以外的外部命令，也不要自动下载浏览器/模型。

## 4. 固定目录结构

```text
emu-chat/
├── dev-docs/
├── migrations/
│   └── 0001_initial.sql
├── openapi/
│   └── emu-chat-v1.yaml
├── public/
│   ├── manifest.webmanifest
│   └── icons/
├── src/
│   ├── shared/
│   │   ├── api-schemas.ts
│   │   ├── domain-enums.ts
│   │   ├── hermes-schemas.ts
│   │   ├── ids.ts
│   │   └── limits.ts
│   ├── server/
│   │   ├── index.ts
│   │   ├── app.ts
│   │   ├── config.ts
│   │   ├── logging.ts
│   │   ├── db/
│   │   │   ├── database.ts
│   │   │   ├── migrate.ts
│   │   │   └── repositories/
│   │   ├── domain/
│   │   │   ├── transitions.ts
│   │   │   └── errors.ts
│   │   ├── hermes/
│   │   │   ├── client.ts
│   │   │   ├── adapter.ts
│   │   │   ├── capabilities.ts
│   │   │   └── sse-consumer.ts
│   │   ├── services/
│   │   │   ├── status-service.ts
│   │   │   ├── conversation-service.ts
│   │   │   ├── draft-service.ts
│   │   │   ├── queue-service.ts
│   │   │   ├── run-coordinator.ts
│   │   │   ├── event-hub.ts
│   │   │   └── cleanup-service.ts
│   │   └── http/
│   │       ├── error-handler.ts
│   │       └── routes/
│   └── client/
│       ├── main.tsx
│       ├── app.tsx
│       ├── router.tsx
│       ├── api/
│       ├── stores/
│       ├── components/
│       ├── features/
│       │   ├── conversations/
│       │   ├── messages/
│       │   ├── drafts/
│       │   ├── queue/
│       │   ├── runs/
│       │   └── settings/
│       └── styles/
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── fixtures/
│   └── e2e/
├── index.html
├── package.json
├── tsconfig.json
├── tsconfig.server.json
└── vite.config.ts
```

依赖方向：routes -> services -> repositories/adapter；client -> Browser API；shared 不依赖 client/server。route 不写 SQL，repository 不发 HTTP，adapter 不访问 SQLite，React 不判断 Hermes 原始字符串。

## 5. 环境与启动行为

`.env.example` 只包含：

```dotenv
EMU_CHAT_HOST=0.0.0.0
EMU_CHAT_PORT=3000
EMU_CHAT_DATA_DIR=./data
HERMES_BASE_URL=http://127.0.0.1:8642
HERMES_API_KEY=
LOG_LEVEL=info
```

使用 Zod 启动解析。`HERMES_API_KEY` 空时 Web 服务仍启动、status=`config_error`，Hermes route 返回 `HERMES_AUTH_FAILED`，但不得打印 key。

生产：Fastify 提供 `dist/client`、SPA fallback 和 `/api/v1`。开发：Vite 5173 将 `/api` 代理到 Fastify 3000。不要启用 CORS plugin。

启动顺序：读取配置 -> 创建 data dir -> 打开 DB/PRAGMA -> migration -> 创建 services/routes -> listen -> 后台 health/recovery。migration 失败时不 listen 正常应用；只输出无敏感诊断并退出非零。

优雅关闭：停止接收新请求，关闭 Browser SSE，abort Hermes SSE（不调用 stop），停止 timer，释放本实例持有的 lease，关闭 DB。进程关闭不得取消 Hermes run。

## 6. SQLite 连接规则

每个进程一个 `better-sqlite3` connection：

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
```

所有多步 mutation 使用 `db.transaction(...).immediate()`。所有 SQL 在 repository；全部参数绑定。时间使用 `new Date().toISOString()`，依赖 ISO UTC 字符串可排序。不要使用 ORM、自动 schema sync 或删除重建数据库。

Migration runner 先创建：

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
```

然后按文件名前缀只向前应用；已应用文件不得修改 checksum/内容（MVP 可在首次提交前定稿）。

## 7. `0001_initial.sql` 精确 DDL

实现必须采用以下表/字段/枚举；不增加 messages、tool_events、transcript、archive mirror 或 FTS 表。

```sql
CREATE TABLE conversations (
  id TEXT NOT NULL PRIMARY KEY CHECK (substr(id, 1, 3) = 'cv_'),
  hermes_profile TEXT NOT NULL DEFAULT 'default'
    CHECK (hermes_profile = 'default'),
  hermes_session_id TEXT NOT NULL UNIQUE,
  tags_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(tags_json) AND json_type(tags_json) = 'array'),
  custom_order REAL,
  metadata_revision INTEGER NOT NULL DEFAULT 0
    CHECK (metadata_revision >= 0),
  queue_paused INTEGER NOT NULL DEFAULT 0
    CHECK (queue_paused IN (0, 1)),
  pause_reason TEXT CHECK (
    pause_reason IS NULL OR pause_reason IN (
      'run_failed', 'run_partial', 'run_cancelled', 'run_interrupted',
      'user_stopped', 'submission_rejected',
      'reconciliation_failed', 'review_required',
      'manual_resume_required'
    )
  ),
  delete_state TEXT NOT NULL DEFAULT 'none'
    CHECK (delete_state IN ('none', 'pending', 'failed')),
  delete_error_code TEXT,
  last_seen_upstream_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((queue_paused = 0 AND pause_reason IS NULL)
      OR (queue_paused = 1 AND pause_reason IS NOT NULL))
);

CREATE TABLE drafts (
  conversation_id TEXT NOT NULL PRIMARY KEY
    REFERENCES conversations(id) ON DELETE CASCADE,
  content TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE queue_items (
  id TEXT NOT NULL PRIMARY KEY CHECK (substr(id, 1, 3) = 'qi_'),
  conversation_id TEXT NOT NULL
    REFERENCES conversations(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL UNIQUE
    CHECK (substr(operation_id, 1, 3) = 'op_'),
  client_request_id TEXT NOT NULL UNIQUE,
  fifo_seq INTEGER NOT NULL CHECK (fifo_seq > 0),
  state TEXT NOT NULL CHECK (state IN (
    'queued', 'dispatching', 'accepted', 'reconciling', 'done',
    'paused', 'review_required', 'rejected', 'cancelled'
  )),
  payload_text TEXT,
  payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256) = 64),
  payload_bytes INTEGER NOT NULL CHECK (payload_bytes > 0),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  idempotency_key TEXT NOT NULL UNIQUE,
  dispatch_session_id TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK (attempt_count BETWEEN 0 AND 4),
  first_attempt_at TEXT,
  admission_deadline_at TEXT,
  recovery_expires_at TEXT,
  payload_expired_at TEXT,
  payload_discarded_at TEXT,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (id, conversation_id),
  UNIQUE (conversation_id, fifo_seq),
  CHECK (state <> 'queued' OR dispatch_session_id IS NULL),
  CHECK (state NOT IN ('dispatching', 'accepted', 'reconciling', 'done', 'paused')
         OR dispatch_session_id IS NOT NULL),
  CHECK (state NOT IN ('queued', 'dispatching', 'accepted', 'reconciling')
         OR payload_text IS NOT NULL),
  CHECK (state NOT IN ('done', 'cancelled') OR payload_text IS NULL)
);

CREATE UNIQUE INDEX ux_queue_one_global_active
  ON queue_items ((1))
  WHERE state IN ('dispatching', 'accepted', 'reconciling');

CREATE UNIQUE INDEX ux_queue_one_conversation_active
  ON queue_items (conversation_id)
  WHERE state IN ('dispatching', 'accepted', 'reconciling');

CREATE INDEX ix_queue_fifo
  ON queue_items (conversation_id, state, fifo_seq);

CREATE INDEX ix_queue_recovery_expiry
  ON queue_items (recovery_expires_at)
  WHERE payload_text IS NOT NULL AND recovery_expires_at IS NOT NULL;

CREATE TABLE runs (
  id TEXT NOT NULL PRIMARY KEY CHECK (substr(id, 1, 3) = 'lr_'),
  queue_item_id TEXT NOT NULL UNIQUE,
  conversation_id TEXT NOT NULL,
  hermes_run_id TEXT UNIQUE,
  local_state TEXT NOT NULL CHECK (local_state IN (
    'submitting', 'accepted', 'reconciling', 'reconciled',
    'rejected', 'review_required'
  )),
  upstream_status TEXT CHECK (
    upstream_status IS NULL OR upstream_status IN (
      'queued', 'running', 'waiting_for_approval', 'stopping',
      'completed', 'failed', 'cancelled', 'interrupted'
    )
  ),
  partial INTEGER NOT NULL DEFAULT 0 CHECK (partial IN (0, 1)),
  last_event_seq INTEGER NOT NULL DEFAULT 0 CHECK (last_event_seq >= 0),
  last_event_name TEXT,
  events_truncated INTEGER NOT NULL DEFAULT 0 CHECK (events_truncated IN (0, 1)),
  last_error_code TEXT,
  last_status_checked_at TEXT,
  reconciliation_started_at TEXT,
  started_at TEXT NOT NULL,
  terminal_at TEXT,
  reconciled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (queue_item_id, conversation_id)
    REFERENCES queue_items(id, conversation_id) ON DELETE CASCADE,
  CHECK (local_state NOT IN ('accepted', 'reconciling', 'reconciled')
         OR hermes_run_id IS NOT NULL),
  CHECK (local_state NOT IN ('submitting', 'rejected')
         OR hermes_run_id IS NULL),
  CHECK (hermes_run_id IS NOT NULL OR upstream_status IS NULL)
);

CREATE INDEX ix_runs_hermes_status
  ON runs (upstream_status, local_state);

CREATE TABLE coordinator_leases (
  scope_type TEXT NOT NULL CHECK (scope_type IN ('global', 'conversation')),
  scope_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  lease_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope_type, scope_id),
  CHECK ((scope_type = 'global' AND scope_id = 'global')
      OR (scope_type = 'conversation' AND substr(scope_id, 1, 3) = 'cv_'))
);

CREATE TABLE ui_preferences (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  theme TEXT NOT NULL DEFAULT 'system'
    CHECK (theme IN ('system', 'light', 'dark')),
  sidebar_width INTEGER NOT NULL DEFAULT 320
    CHECK (sidebar_width BETWEEN 240 AND 520),
  send_shortcut TEXT NOT NULL DEFAULT 'enter'
    CHECK (send_shortcut IN ('enter', 'mod_enter')),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at TEXT NOT NULL
);

INSERT INTO ui_preferences (
  id, theme, sidebar_width, send_shortcut, revision, updated_at
) VALUES (1, 'system', 320, 'enter', 0, '1970-01-01T00:00:00.000Z');
```

数据库复合外键保证 queue/run 的 conversation 相同。Repository/application 还必须保证：`queued/cancelled` 没有 run；`dispatching/review_required/rejected` 有一个 run，其中 dispatching/rejected 的 Hermes run id 为 NULL、review_required 可空；`accepted/reconciling/paused/done` 有 run 和 Hermes run id。所有状态变化仍必须经过第 10 节白名单。

## 8. ID、hash 与大小

- 服务端 ID：`${prefix}${crypto.randomUUID()}`，例如 `cv_550e...`。
- browser `client_request_id`：标准 UUID；前端在首次点击发送时生成并保存到该 mutation promise，响应未知时重用。
- Hermes idempotency key：`ec_${crypto.randomUUID()}`，不含正文/session/title。
- payload hash：UTF-8 原文的 SHA-256 小写十六进制。
- payload size：`Buffer.byteLength(content, 'utf8')`，不是 JS `length`。
- 不 normalize 用户正文；hash、保存和上游发送使用完全相同字符串。

共享限制严格取 `06`：64 KiB input、200 title 字符、tags 20 x 40、每 conversation 中 state 非 `done|cancelled` 的 queue records 100、JSON 128 KiB。Fastify bodyLimit 设 128 KiB。

## 9. 数据库事务规范

### 9.1 Conversation 惰性 upsert

Hermes list/detail 返回一项时：

1. 按 `hermes_session_id` 查 conversation；
2. 不存在则创建 `cv_...`、default profile、空 draft；
3. 存在只更新 `last_seen_upstream_at/updated_at`；
4. 不保存 title/pinned/hidden/archived/preview/message_count。

### 9.2 Draft CAS

`PUT draft` 在 immediate transaction 中比较 revision；相等才写 content、revision+1。冲突不改数据。draft 为空仍保留行和 revision。

### 9.3 Draft -> queue send

执行顺序固定：

1. transaction 外按 `client_request_id` 只读查询；同 conversation 已存在则立即返回原 item、当前 draft、`replayed=true`，忽略 Hermes health、expected draft revision 和当前 queue pause；不同 conversation 则 `LOCAL_CONFLICT`；
2. 只有 id 不存在时，确认最新 connection state 为 healthy；
3. 开始 immediate transaction，并再次查询 `client_request_id` 防两个请求并发：同 conversation 已存在则结束事务后按步骤 1 返回，不重复写；不同 conversation 冲突；
4. 读取 conversation/draft，校验 expected revision、正文非空、64 KiB、delete_state=none；conversation queue 已 paused 仍允许入队；
5. 统计该 conversation state 非 `done|cancelled` 的 item，必须小于 100；
6. `fifo_seq = COALESCE(MAX(fifo_seq),0)+1`；
7. 生成 queue/operation/key/hash；插入 state=queued；
8. draft 写空字符串、revision+1；
9. commit；事务后唤醒 coordinator。

不要在 transaction 内发 HTTP。若 Hermes 在步骤 2 后离线，item 已是合法 queued/dispatching 恢复状态，不回填 draft 或创建第二项。replay 保证持续到该 queue control row 被清理；前端只在同一次响应未知的 send 中复用 id。

#### 9.3.1 Queue edit/cancel

- edit 使用 immediate transaction，按 item id + `state=queued` + expected revision CAS；正文必须非空且不超过 64 KiB，随后用完全相同字节重算 text/hash/bytes、revision+1；空正文或已 dispatch 都不落库。
- cancel 同样按 queued + revision CAS，改 cancelled、payload=NULL、revision+1、updated_at=now；idempotency key/operation/hash/bytes 仅作为控制证据保留。

### 9.4 取得 dispatch slot

实例 `owner_id=inst_<uuid>`。租约 TTL 15 秒，heartbeat 每 5 秒。

新 dispatch 在同一 immediate transaction：

1. 按全局 `created_at, conversation_id, fifo_seq` 选最早、conversation 未 paused/delete 的 queued candidate；
2. 对 global 和该 conversation lease 分别执行 INSERT，或只在 `expires_at <= now` 时条件 UPDATE 为本实例和新随机 token；任一取得失败全部 rollback；
3. 再确认 connection healthy、candidate/conversation 条件未变、无 active partial-index row；
4. 将 candidate 改 `dispatching`，固定 `dispatch_session_id=current hermes id`、`first_attempt_at=now`、deadline `now + min(capability retention,86400)`；
5. 在发第一次 HTTP 前先把 `attempt_count=1` 持久化，并插入 run `local_state=submitting`；
6. commit 后发 HTTP。

fencing 规则固定如下：

- acquire 只能 INSERT 或 `WHERE expires_at <= now` 条件接管；
- heartbeat 必须同时按 scope、owner、token 且 `expires_at > now` 条件 UPDATE；
- release 必须按 scope、owner、token DELETE；
- 每次应用网络结果前，必须在同一 transaction 验证两个 token 仍匹配且都 `expires_at > now`；
- 任一步 `changes=0` 即丢失 fence：abort 本 owner 的 consumer/任务，不应用该网络结果，由新 owner 恢复。

每个后续 admission HTTP 尝试也必须先在 fenced transaction 中将 `attempt_count` 从 N 预留为 N+1；允许值最多 4。收到 202 不再次增加计数。

#### 9.4.1 Active takeover

启动扫描或 lease 过期后，coordinator 必须优先接管现有唯一 `dispatching|accepted|reconciling` item，而不是被“无 active row”条件挡住：

1. 等旧 lease 到期后，按上述 CAS 取得该 item 的 global + conversation 新 token，不改变 item 状态；
2. `dispatching` 必须对应 `submitting` run 且无 Hermes run id；只有 payload/hash/key/session 完整、deadline 未过且 `attempt_count < 4` 时，才预留下一次计数并用完全相同请求恢复 admission，否则进入 `review_required`；
3. `accepted|reconciling` 必须有 Hermes run id，只能 GET status/events/messages，绝不 POST input；
4. 任一关联/invariant 不成立时，在仍持有效 fence 的 transaction 中转 `review_required` 并暂停；
5. `review_required|rejected|paused` 不自动接管或执行。

### 9.5 Admission 收敛

- 有效 202：校验 run id；fenced transaction 写 `runs.hermes_run_id`、run/item accepted，保持 payload；响应的 `status=started` 不写 `upstream_status`；启动唯一 consumer/poller。
- 相同 key replay：同样收敛到同一 run id；如果本地已记录不同 run id，则 run/item `review_required`、pause=`review_required`。
- 400/404/405/413/415/422 及其他明确 non-retryable 4xx：run rejected、item rejected、pause=`submission_rejected`、recovery expiry=now+7d，释放 lease。
- 401/403：按明确未接纳落 rejected/submission_rejected，同时把全局 connection state 设 `auth_failed`，不继续 admission。
- 409 idempotency fingerprint 冲突：run/item `review_required`、pause=`review_required`，绝不换 key/body/session。
- 408/425/429、5xx、timeout/connection：只有仍无 run id、deadline 未过、payload/hash/session/key/fence 完整且尚未预留第 4 次时，才按 1/2/5 秒预留并发下一次；`Retry-After` 只能用于 deadline 内的安全调度，不能增加次数。
- malformed 2xx、deadline 到期、第 4 次仍不确定或任一 invariant 失败：run/item `review_required`、pause=`review_required`、recovery expiry=now+7d，释放 lease。

### 9.6 Terminal reconciliation

terminal event或 poll terminal：transaction 把 run/item 改 reconciling，首次写 `reconciliation_started_at` 和 `terminal_at`；继续持有 active slot。

然后 GET status + messages，最多重试到 reconciliation_started_at + 5 分钟（只读指数退避，最大 30 秒）：

- `completed + partial=false` 且 messages 合法：transaction 更新 effective session id、run reconciled/reconciled_at、item done、payload NULL、recovery fields NULL。原本未暂停则保持未暂停并唤醒下一项；`user_stopped` 保持原原因；从 `review_required/reconciliation_failed` 人工恢复出的 run 改为 pause=`manual_resume_required`，必须另点 resume；释放 lease。
- `failed|cancelled|interrupted` 或任何 `partial=true`，且 messages 合法：run reconciled，item paused，recovery expiry=now+7d；若当前 pause 已是 `user_stopped` 则保留，否则依次映射 `run_partial|run_failed|run_cancelled|run_interrupted`；释放 lease，不发送下一项。
- terminal 已知后超过 5 分钟、status/messages 404 或协议歧义：run/item review_required、events_truncated=1、pause=`reconciliation_failed`（已有 `user_stopped` 则保留）、recovery expiry=now+7d；释放 lease。

accepted 阶段尚未确认 terminal 时若 run 404/identity/protocol 无法恢复，则进入 review_required、pause=`review_required`；不要误用 `reconciliation_failed`。任何路径都不重新 POST 已有 run id 的 input。

### 9.7 Manual reconcile

route 不得绕过 coordinator/fencing 直接写状态：

1. `local_state=reconciling` 只唤醒当前 coordinator；若旧 owner 已失效，由 active takeover 取得新 lease；
2. `local_state=review_required` 只有 Hermes run id 非空、conversation 仍 paused、全局无其他 active item时才可继续；取得 global + conversation lease 后做只读 status/messages；
3. status 仍 non-terminal 时，可在 fenced CAS 中将 item/run `review_required -> accepted`、清除 recovery expiry、保持 conversation paused，并恢复唯一 consumer/poller；
4. terminal + messages 合法时，按 9.6 直接 `review_required -> done|paused`、run -> reconciled；completed 时 conversation 保持暂停并改为 `manual_resume_required`；
5. 仍 404/协议歧义/CAS 失败则保持 review_required；无 Hermes run id 或 item 已 paused 返回 `STATE_CONFLICT`；
6. 用户并发 resume、其他 active 出现或任一 fence 失效时，丢弃本次读取结果。

### 9.8 Stop

先在 immediate transaction join conversation/item/run 并 CAS：item/run 必须仍 accepted、有 Hermes run id，且本地尚未确认 terminal；成功才设置 pause=`user_stopped`。若已 reconciling/reconciled，不新增 pause并返回 `STATE_CONFLICT`。commit 后调用 Hermes stop；即使 stop HTTP 失败也保留 pause，用户可明确 resume。重复请求看到 `upstream_status=stopping` 时只返回 snapshot，不重复调用。stop 响应不得覆盖并发 coordinator 已写入的 terminal/对账状态。

### 9.9 Resume

immediate transaction 验证 paused、无 active、delete none、该 conversation 没有未过期 reconciliation lease，将 paused=0/reason=NULL；commit 后唤醒 coordinator。绝不修改 paused/review_required/rejected item，也不复制其 payload。

### 9.10 Recovery copy/discard

copy：state 只允许 paused/review_required/rejected，payload 非 NULL、未过期；draft revision CAS；非空 draft 必须 `overwrite_nonempty=true`；写 draft/revision+1，原 item 不变。

discard：同状态；payload=NULL、payload_discarded_at=now、updated_at=now。hash/bytes 保留。

### 9.11 Delete

严格执行 `05`。expected session id 必须等于当前 mapping。设置 delete pending 只在真正发 DELETE 前；失败保留。2xx 或二次 detail 404 时，一个 transaction 先显式删除该 conversation lease，再删除 conversation；draft/queue/run 依赖 FK cascade，global lease 不删除。删除前 active partial index 必须为空，`active_agents` 必须明确为 0。

## 10. 状态转移白名单

### Queue item

| from | to | 触发 |
| --- | --- | --- |
| queued | queued | 用户编辑 revision+1 |
| queued | cancelled | 用户取消并清 payload |
| queued | dispatching | coordinator 获得双 lease |
| dispatching | accepted | 有效 202/replay run id |
| dispatching | rejected | 明确未接纳的 non-retryable 4xx（不含 409） |
| dispatching | review_required | deadline/一致性/幂等冲突 |
| accepted | accepted | status/event 更新但未终态 |
| accepted | reconciling | 发现 terminal |
| accepted | review_required | run id 无法恢复/协议破坏 |
| reconciling | done | completed + messages 成功 |
| reconciling | paused | 非成功终态 + messages 成功 |
| reconciling | review_required | 5 分钟无法对账 |
| review_required | accepted | 手动 reconcile 读到 non-terminal 且重新取得双 lease |
| review_required | done | 后续手动 reconcile 明确 completed |
| review_required | paused | 后续手动 reconcile 明确非成功 |

其他状态变化全部 `STATE_CONFLICT`。copy/discard 不改变 item state。

### Run local state

| from | to |
| --- | --- |
| submitting | accepted / rejected / review_required |
| accepted | accepted / reconciling / review_required |
| reconciling | reconciled / review_required |
| review_required | accepted / reconciled / review_required |

`rejected` 与 `reconciled` 终止。upstream status 只按 Hermes snapshot/event 更新，不由 UI 推断。

## 11. Hermes adapter 细则

使用 Node global fetch + AbortController。普通 GET 10 秒、run submit 30 秒；create/fork/update/delete/stop/approval 等其他 mutation 10 秒。上游 SSE 首次响应头 10 秒，连接后 30 秒无任何 event/keepalive 字节即 abort 并按 gap 重连。限制非 SSE body 最大 4 MiB；超限 protocol error。不要记录 request/response body。

### 11.1 Capability 门禁

healthy 必须同时满足：

- `features.run_submission/run_status/run_events_sse/run_stop/run_approval_response/session_resources/session_fork/tool_progress_events/approval_events === true`；
- `features.runs_idempotency.supported === true`；
- `durable === true`；
- `retention_seconds >= 86400`；
- endpoints 中 method/path 与 `03` 的 sessions、create/detail/update/delete/messages/fork、runs/status/events/approval/stop、health_detailed 完全匹配；
- runtime mode=`server_agent`、tool execution=`server`。

缺失 -> incompatible，不 fallback。OpenAI-compatible、steer、artifact 能力即使存在也忽略。

### 11.2 上游请求

- 每次加 Bearer、`Accept: application/json`（SSE 除外）、固定 User-Agent `emu-chat/<version>`；
- POST run 加后端生成的 Idempotency-Key；
- 永远不加 `X-Hermes-Session-Key`；
- URL path segment 使用 `encodeURIComponent`；query 使用 `URLSearchParams`；
- list 固定 source=api_server；不传 include_children/archive/profile；
- 只发送本契约列出的 JSON 字段。

### 11.3 Response parsing

所有 JSON 先过共享 Zod schema。schema 对顶层和已用字段严格，对明确允许的未来附加字段可 `.passthrough()` 后只 pick allowlist。不要把原对象透传客户端。

messages content/tool fields 只做类型/大小校验，不在 adapter 中改写正文；日志完全跳过。

## 12. Upstream SSE consumer 与 EventHub

- 每个 `hermes_run_id` 在进程内最多一个 `RunConsumer`，用 Map 原子 get-or-create；
- consumer 独立于 Browser SSE 数量；
- 单条上游 SSE data 最大 256 KiB；非法/超限 -> events_truncated + protocol error，转 status polling；
- 首次响应头 10 秒；连接后连续 30 秒没有任何 event 或 keepalive 字节视为 liveness timeout；
- 串行重连，确保前一 fetch 已 abort/closed 后才开下一条；退避 1/2/5/10 秒，上限 10 秒；每次断流都标 `upstream_disconnected` gap，非法/超限标 `protocol_error` gap；
- 同时每 5 秒 poll run status，保证没有 terminal event 也能收尾；
- terminal 后停止上游重连，进入 reconciliation；
- approval snapshot 可从 event/status 临时投影，不把 command 写 SQLite。

EventHub：512 events 或 JSON UTF-8 1 MiB，先达者为准；驱逐最早项时 run.events_truncated=1 并产生 `buffer_evicted` gap。`local_seq` 首次从 1 开始，每次事件先原子写 `runs.last_event_seq+1` 再入 hub；进程重启后继续该值，绝不复用 id，并为所有未收尾 run 设置 `events_truncated=1`/`process_restarted` gap。浏览器 `after > last_event_seq` 使用 `cursor_ahead` gap。

hub 只在内存。只有 run 已进入 `reconciled` 或终止于 `review_required` 后才开始 60 秒删除计时；只收到 terminal event、仍在 reconciliation 时不得删除。

Browser SSE heartbeat 15 秒。连接限制按 `06`。backpressure：单浏览器写缓冲持续阻塞/超过实现阈值时关闭该浏览器连接，不影响 run/upstream consumer。

## 13. 后台循环

不得使用多个模块各自创建重复 timer。由 app lifecycle 集中启动：

- health probe：启动立即；healthy 每 15 秒，不健康每 5 秒（最大并发 1）；
- dispatch scan：事件唤醒 + 每 2 秒兜底；
- lease heartbeat：每 5 秒；
- active run status poll：每 5 秒（可由 consumer 管理，但每 run 只有一份）；
- payload expiry/terminal cleanup：启动立即 + 每 1 小时；
- terminal control cleanup：done/cancelled 从进入该状态的 `updated_at` 起保留 7 天后删除；paused/rejected/review_required 只有 payload 已清，且 `payload_expired_at` 或 `payload_discarded_at` 已满 30 天后才删除；绝不删除 queued/active。该保留期同时定义 Browser `client_request_id` replay 窗口。

timer callback 必须防重入。所有 interval 在 shutdown 清除。

## 14. Browser API 实现要求

逐字实现 `09` 路由；Zod schema 是 route 和 typed client 的共同来源。Fastify error handler 统一映射 domain/upstream/SQLite constraint，不在 route 中散落 response shape。

- SQLite unique active index冲突 -> `LOCAL_CONFLICT`；
- draft revision -> `DRAFT_CONFLICT`；
- 非法 transition -> `STATE_CONFLICT`；
- 新 `client_request_id` 在 replay 查询后发现 Hermes 非 healthy -> `HERMES_NOT_READY`，不得开始创建 mutation transaction；已有同 conversation id 的 replay 仍必须返回原 item；
- 所有错误带 request id；
- response 不含 stack/cause/SQL/upstream body；
- 不实现未列 route，尤其 retry/archive/steer/proxy。

OpenAPI 必须与 `09` 路由、status、请求体和错误码一致。不要加入 Swagger UI 或公开 debug route。

## 15. 前端实现约束

### 15.1 状态

- React Query 管理 status/conversation/messages/queue/run/preferences；`gcTime` 可配置但不 persist。
- React Query mutation 全部 `retry:false`；错误 envelope 的 `retryable` 只控制显式用户动作。send 响应未知时只由同一次 UI operation 复用原 `client_request_id`，确定响应或页面重载后不得复用。
- Zustand 只保存 drawer、queue sheet、临时 event projection、last local seq；不使用 persist/localStorage/IndexedDB。
- textarea state 以服务端 draft 为基线；500ms debounce CAS，send 前 flush。
- active run delta 与 Hermes messages 分开；reconcile/gap 后丢临时投影并 invalidate messages。

### 15.2 Markdown

插件顺序：remark GFM/math；rehype sanitize 在 KaTeX/highlight 前；不要启用 raw HTML。KaTeX/highlight 是受控库生成内容。自定义 link component 只允许 http/https/mailto，添加 noreferrer/noopener。MVP message 图片不渲染为网络资源，可显示链接文本。

禁止把模型文本、tool args、preview、error 用 `dangerouslySetInnerHTML`。KaTeX/Markdown 库内部行为除外，但调用方不能注入 raw HTML。

### 15.3 PWA

manifest/图标存在。Service Worker 只在 secure context 条件成立时注册；API/SSE network-only，不缓存 conversation/messages/draft/queue/run。HTTP LAN 下不报错、不反复 toast。

### 15.4 UI 范围

逐项实现 `10`。任何菜单/路由/按钮出现 archive、restore、hide、attachment、notification、voice、steer、always/session approval、OpenAI fallback 都是范围错误。

## 16. 测试源码要求（只写不运行）

- unit：transition 表每条合法边和所有主要非法边；DDL active index；draft CAS；payload TTL；redaction；schemas；
- integration：使用 Fastify `inject` 测 Browser API；fake Hermes 使用测试内本地 HTTP server，但本轮不启动；
- fixtures：capabilities、sessions/messages、run status/events、approval、events gap、delete、错误；
- client：关键 state/dialog/disabled rules；
- e2e：只写未来 Playwright 场景，不写假截图/假结果。

测试不得 import Hermes 源码、读真实 `state.db` 或使用真实 API key。fixture 内容不得包含真实用户历史。

## 17. 明确禁止的实现捷径

- 直接读取/复制 Hermes SQLite；
- `messages`、`transcript`、`tool_events`、FTS 或历史 event 表；
- localStorage/IndexedDB 保存消息、draft、queue payload 或 delta；
- 根据正文相等判断 Hermes 已持久化；
- 有 run id 后调用 run submit；
- 每个浏览器建立一条 Hermes SSE；
- 把 `partial` 当 status，等待不存在的 `run.partial/run.interrupted`；
- 从 Markdown/preview 推断 checklist；
- catch 后返回空数组；
- route 里直接 SQL/fetch；
- 任意 `any` 穿过边界、未经 Zod 的 `response.json()`；
- raw upstream error/body 透传；
- 写 Hermes key 到客户端、DB、日志或 `.env.example`；
- 修改 Hermes、启动/测试/联调后声称成功。

## 18. Gemini 完成编码后的固定声明

交付消息必须包含：

> 已按批准文档静态编写 emu-chat。未安装依赖，未生成 lockfile，未启动 emu-chat/Hermes，未运行 format、lint、typecheck、build、test、e2e 或真实联调；所有运行结果仍待人工验证。

并按 phase 列出文件、需求 ID、已写但未运行的测试，以及任何具体文档冲突/代码风险。不得用“测试应该能通过”代替未验证声明。
