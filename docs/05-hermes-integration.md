# Hermes Integration

本文档阐述 Emu-Chat 接入核心上游服务 Hermes 的网络层与协议适配层设计。

## HermesClient 底层HTTP/SSE客户端

`HermesClient` 负责与 Hermes 的直接 HTTP 以及 SSE (Server-Sent Events) 通信。

- **鉴权注入**: 每个请求自动注入 Bearer Token 并在必要时显式删除 `X-Hermes-Session-Key` 头以适配身份切换等操作。
- **request<T> 管道**:
  1. `isConfigured` 检查，确保基础 URL 和认证配置有效。
  2. URL 拼接与构建。
  3. 挂载 `AbortController` 控制请求超时。
  4. `readBoundedText` 在 `Content-Length` 超限时提前拒绝；其他响应读取完整正文后再按 UTF-8 字节数检查 4 MiB，上游未声明长度时没有逐块限流。
  5. 经过 `throwForStatus` 的状态码映射，转换为特定业务异常（如 `HermesNotFoundError`、`HermesAuthFailedError`）。
- **stream SSE管道**:
  - **握手超时**: 限制 10s 内必须完成连接。
  - **readSseChunk竞速**: 利用 `Promise.race` 检查网络活跃度（Liveness 保活上限 30s）。
  - **行解析状态机**: `HermesClient` 自行按行增量解析 SSE 帧。
  - **接收缓冲限制**: 每次读取 chunk 后、分行前检查当前字符串缓冲区是否超过 256 KiB；当前实现并未累计限制多行组成的整帧大小。
  - **输出**: 解析完成即 `yield HermesSseEvent` 对象供外层使用。

## HermesAdapter 协议适配器（反腐层 Anti-Corruption Layer）

`HermesAdapter` 作为系统的反腐层，屏蔽上游协议的脏细节，输出强类型及领域模型。

- **getDetailedHealth**: 组合式探活，合并调用 `/health/detailed` 与 `/v1/capabilities` 双端点确认整体存活及能力详情。
- **assertReady**: 将健康状态评估与能力是否符合预期的检查进行组合校验，只有两项均过关才判定为 Ready。
- **会话管理API映射**: 包装了针对 Hermes session 相关的各种调用（`getSession`, `createSession`, `updateSession`, `forkSession`, `deleteSession`）。
- **未命名会话**: `createSession` 省略标题时仍提交 JSON `{}`；Hermes 返回的 `title: null` 在创建、详情及列表读取的统一适配入口转为空字符串。内部和前端会话模型始终使用字符串标题，用户输入的标题继续由 Hermes 校验。
- **标题校验错误**: Client 仅保留有界 400 响应中的结构化错误码和原因；Adapter 只在提交标题时识别 `invalid_title`，明确重名时转换为 `HERMES_TITLE_CONFLICT`，其他标题校验转换为 `HERMES_TITLE_INVALID`。其他 400 保持通用协议错误；原始上游原因和会话 ID 不进入前端错误信息。
- **startRun**: 发起运行调用。内部限制请求超时 30 秒，并附加 `Idempotency-Key` 标头以防止网络抖动导致的重复执行。
- **getRunStatus**: 拉取状态信息，并对获取到的 `run_id` 实施强一致性校验。
- **streamEvents**: 异步迭代器接口，负责将来自 Client 的纯净流进行转换。逐帧校验 JSON 格式、对比 `run_id` 确保不错乱，并验证 timestamp 合法性。
- **normalizeSession**: 日期格式标准化处理。将上游返回的秒级 Unix 时间戳转换为内部统一使用的 ISO 8601 字符串格式。
- **协议校验 (Zod Schema)**: 会话、健康、消息和 Run 等需要读取结构化数据的响应经过 Schema 解析或字段校验；删除、停止和审批等无数据响应不做同样的结构验证。格式偏差会抛出 `HermesProtocolError`。

```mermaid
flowchart LR
    HC[HermesClient] -->|"HTTP/SSE Raw Data"| HA["HermesAdapter (Anti-Corruption Layer)"]
    HA -->|"Zod 验证/转换"| Core["Emu-Chat 核心服务"]
    Core --> HA
    HA -->|"Idempotency-Key/超时控制"| HC
    
    subgraph 过滤逻辑
        HA_ERR[HermesProtocolError]
    end
    HA -.->|"格式偏差"| HA_ERR
```

## evaluateHermesCapabilities 能力评估函数

该函数专门用于解析 `/v1/capabilities` 返回的数据并形成综合评估报告。

- **9项特性检查**: 确认诸如 `run_submission` 等是否得到上游支持。
- **幂等性检查**: 判断是否支持 `durable`，且要求 `retention_seconds >= 86400`（即至少24小时保留）。
- **端点存在性验证**: 预定义 12 个关键端点，依次校验是否存在于声明中。
- **运行时模式检查**: 验证是否具备 `server_agent` 及 `server tool_execution` 权限。
- **评估结果**: 能力完整时返回 `healthy`，缺少必需条件时返回 `incompatible`。网络、鉴权和其他探测错误由 `StatusService` 捕获并映射到连接状态，不由此函数分类。

```mermaid
stateDiagram-v2
    [*] --> Evaluation : 获取 capabilities 报文
    Evaluation --> CheckFeatures : 9项特性检查
    CheckFeatures --> CheckIdempotency : durable & retention
    CheckIdempotency --> CheckEndpoints : 12个端点验证
    CheckEndpoints --> CheckRuntime : 运行时模式
    
    CheckRuntime --> Healthy : 全量通过
    CheckRuntime --> Incompatible : 关键能力缺失
```

## 独立图片插件

图片资源接口使用独立的 `MediaClient`，通过 Hermes API listener 的 `/v1/emu-media` 命名空间访问 `emu-media` 插件；它不借用只处理 JSON 的 `HermesClient.request` 传送二进制图片。插件使用单独的 `EMU_MEDIA_API_KEY`。图片能力探测与原 Hermes 文字聊天健康检查分开，插件失效不阻断纯文字 Run。

带附件的队列项在派发前由 `MediaDispatchService` 检查图片状态及摘要、登记会话和队列引用、绑定 operation，再冻结完整的 `/v1/runs` 字符串输入。输入末尾的规范化 `<emu-media-input-v1>` 清单只在后台验证绑定后从展示文本剥离。Run 的幂等键、停止、审批、SSE 和终态对账继续走原路径。

插件通过公开 Hook 为已绑定的图片提供 `emu-media://asset_id` 表示，只转换 `vision_analyze` 与 `image_generate` 的授权图片参数；输出 Hook 记录来源后交由插件采集 worker 保存。漏掉的 Hook 事件由公开 Hermes 历史补偿。当前 `local` terminal backend 下，OpenAI、OpenRouter、xAI 的已验证本地文件编辑可用；FAL 图片编辑会把本地路径原样传出，因此报告为不支持，FAL 纯文字生图不受此限制。能力状态不表示供应商实时可用或保证模型一定调用工具。
