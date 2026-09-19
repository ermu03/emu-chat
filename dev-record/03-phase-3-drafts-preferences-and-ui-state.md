# Phase 3 开发记录：草稿管理与 UI 偏好持久化

## 1. 目标与实现范围
本阶段依据 `07-实施计划与验收测试.md` 中 Phase 3 的规划，完成本地会话草稿与全局 UI 偏好设置的存储、乐观锁并发控制、HTTP 契约端点与前端集成交互。

## 2. 代码改动清单

### 2.1 服务端业务与路由
- `src/server/services/draft-preferences-service.ts`：
  - 草稿查询 `getDraft`（草稿不存在时返回空字符串与 revision 0）。
  - 草稿保存 `putDraft`（实施 `64 KiB` 长度拦截、revision 校验与 CAS 乐观更新）。
  - UI 偏好获取 `getPreferences`。
  - UI 偏好更新 `putPreferences`（校验合法主题、侧边栏宽度区间、快捷键选项及 CAS 冲突拦截）。
- `src/server/http/routes/drafts-and-preferences.ts`：
  - `GET /api/v1/conversations/:id/draft`
  - `PUT /api/v1/conversations/:id/draft`
  - `GET /api/v1/preferences`
  - `PUT /api/v1/preferences`
- `src/server/app.ts`：
  - 依赖注入 `DraftPreferencesService` 并挂载对应路由。

### 2.2 前端组件
- `src/client/features/composer/draft-composer.tsx`：
  - 防抖 1000ms 自动保存草稿。
  - 字节计数与 `64 KiB` 上限报警及禁止提交。
  - 支持 `enter`（Shift+Enter 换行）与 `mod_enter` 快捷键切换。
  - 消息发送后自动触发草稿清空。
- `src/client/features/preferences/preferences-drawer.tsx`：
  - 主题切换（系统/浅色/深色）。
  - 发送快捷键切换。
  - 侧边栏宽度滑块调节与 revision 展示。

### 2.3 测试用例
- `tests/unit/phase3-draft-preferences.test.ts`：
  - 草稿不存在时的默认状态。
  - 乐观锁 CAS 递增与版本冲突拦截。
  - 输入体积上限校验。
  - 偏好设置读取、修改与版本冲突拦截。

## 3. 契约遵循验证
- 严格遵循 `02-系统架构与模块边界.md` 与 `03-会话历史与真理源设计.md`：本地数据库只维护草稿与偏好，不沉淀任何会话消息历史。
- 严格遵循 `08-待确认决策清单.md`：更新必须携带 `expected_revision`，发生冲突抛出 `CONFLICT`（HTTP 409）。
- 严格遵循 `09-内部API与错误包契约.md`：端点路径、字段结构与错误返回均与统一规范对齐。
