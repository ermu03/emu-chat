# Agent Note: 限制日志脱敏遍历的深度与循环引用

Status: implemented

## Problem

原 TASK-8：[sanitizeLogValue](../../../../src/server/logging.ts) 此前递归处理对象和数组时没有最大深度或循环引用检测。异常深的元数据会导致栈溢出，循环引用也会让递归无法结束；日志记录本身不应让服务崩溃。

## Decision

在 [logging.ts](../../../../src/server/logging.ts) 中，`sanitizeLogValue` 以 `details` 为第 0 层，最多深入 8 层对象和数组。更深的容器输出 `[MAX_DEPTH]`；当前递归路径上再次出现的对象输出 `[CIRCULAR]`。先按字段名执行现有的凭据与内容脱敏，再检查循环和深度，避免在边界处暴露敏感值。

使用 `WeakSet` 跟踪当前递归路径，离开对象时移除该对象。同一引用出现在独立分支时分别处理，不把它误判为循环。

## Alternatives considered

- **维持无限递归**：完整保留普通嵌套对象；对非预期结构没有保护。
- **只加深度限制**：能挡住很深的无环对象；浅层循环引用仍会反复递归。
- **全局已见对象集合**：实现简单，但独立分支复用同一对象时会误报循环，因此改用当前路径检测。

## Consequences

深层或循环 `details` 可以完成序列化，浅层字段维持原有脱敏行为。超过深度上限的调试信息会被截断；独立分支中的共享对象会重复遍历。该边界仅限制深度与循环，对极宽对象、抛错的 getter 或不能被 JSON 序列化的其他值没有额外保证。

## Verification

[logging.test.ts](../../../../tests/unit/logging.test.ts) 验证日志写入、循环引用、共享引用、深层对象与数组截断，以及脱敏优先级。`npx vitest run tests/unit/logging.test.ts --reporter=dot`、`npm run typecheck` 和 `npm run lint` 均通过。
