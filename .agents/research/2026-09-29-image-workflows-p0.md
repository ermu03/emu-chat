# 图片工作流 P0：已部署 Hermes 的隔离验证

验证日期：2026-09-29。代码基线：已安装 Hermes `6005aa1`；`/home/emu/projects/hermes-agent` 的 `f5d1926` 是另一份开发源码。复现脚本为 [p0-hermes-probe.py](p0-hermes-probe.py)，使用已安装 Hermes 的 Python 虚拟环境、隔离的临时 `HERMES_HOME`、模拟模型回复和模拟图片工具结果。没有连接现有网关、修改生产配置或调用付费模型。

运行方式：

```bash
PYTHONPATH=/home/emu/.hermes/hermes-agent \
  /home/emu/.hermes/hermes-agent/venv/bin/python \
  .agents/research/p0-hermes-probe.py
```

## 已验证的边界

| 边界 | 证据与结果 |
| --- | --- |
| `/v1/runs` | 实际 API handler 返回 202；真实 `AIAgent` 用模拟模型完成一回合，用户消息中的试验清单原文出现在公开 `/api/sessions/{id}/messages`。同一幂等键及 body 重放同一 run ID，改变 body 返回 409。 |
| 公开历史 | 同一实际回合返回 user、assistant(tool_calls)、tool、assistant；工具调用 ID 同时在 assistant 的 `tool_calls[].id` 和 tool 的 `tool_call_id` 中。历史响应没有 `turn_id`，不能从历史单独重建这一身份。 |
| Hook | 隔离目录中的原生用户插件经正常发现加载；真实 agent 回合依次触发 `pre_llm_call`、`pre_tool_call`、`post_tool_call`。后两个 Hook 有相同的 `session_id`、`turn_id`、`tool_call_id`；`pre_tool_call` 的 `modify` 被实际工具分发收到。 |
| 插件路由 | `register_platform_handler("api_server", ...)` 注入路由；试验路由无凭据和错凭据均为 401，正确插件凭据为 200，未配置插件凭据为 503。插件路由自身需要鉴权。 |
| 识图输入 | 当前终端后端为 `local`；`vision_analyze` 可通过受管理的本地图片文件路径读取真实 PNG 字节。 |
| 编辑输入 | 当前 `local` 后端让 `image_generate` 的本地路径原样进入 FAL 请求参数，供应商无法读取宿主机路径。Hermes 内置 OpenAI、OpenRouter、xAI 图片供应商各有本地路径读取/转换代码，隔离验证分别取得原字节或 data URI。 |
| data URI | 在真实 API Run 的模拟生图回合中，Hook 将受管理引用转换为 data URI，模拟工具收到完整字节；成功回合的公开历史、Run 事件和普通日志均未出现该 URI。通用 `redact_tool_args_for_display("image_generate", ...)` 保留原始 URI，故这一成功路径不能证明异常、其他平台或其他观察插件也不会记录它。 |

## 输入桥接结论

用户在 2026-09-29 确认保持独立插件，首版仅启用已验证会读取本地文件的图片供应商。识图走受管理的暂存路径；编辑可用于已验证的 OpenAI、OpenRouter、xAI 适配。FAL 在当前 `local` 后端下的图片编辑报告 `unsupported`，不向模型暴露该编辑能力；FAL 纯文字生图仍可按 Hermes 原配置使用。不为支持 FAL 编辑修改 Hermes 核心、切换终端后端或在 Hook 中注入 data URI。

## 后续包仍需验证的事项

1. 当前 Hermes 配置没有显式的 `image_gen.provider`/`image_gen.model` 选择；本次没有探测账号资格或发起真实供应商调用。FAL 官方模型文档说明文件字段接受 data URI，但这不能替代对 Hermes 日志和生命周期参数的完整保证：[FAL 文件输入说明](https://fal.ai/models/fal-ai/flowedit/api)。
2. 脚本只模拟图片工具的业务结果；多图上限、真实供应商接受输入、输出文件采集、Hook 漏事件补偿尚待后续包和受控联调验证。P0 不能因此写作完整图片链路已可用。
3. 普通网关创建的 agent 是 `quiet_mode=True`，Run 事件忽略工具参数；这一点解释了成功回合没有泄露 data URI。通用显示函数仍不会遮盖它，错误或第三方观察 Hook 的路径尚无保证，因此首版禁用 FAL `local` 编辑。实际启用某个图片供应商之前仍需确认其配置状态，能力接口不做付费调用。

## 代码定位

- Hermes `gateway/platforms/api_server.py`、`gateway/platforms/api_server_runs.py`：路由、Run、公开历史、安静模式。
- Hermes `agent/turn_context.py`、`agent/tool_executor.py`、`model_tools.py`：Hook 与工具参数变更。
- Hermes `tools/image_source.py`、`tools/image_generation_tool.py`：识图来源与 FAL 输入处理。
- Hermes `plugins/image_gen/{openai,openrouter,xai}/__init__.py`：供应商本地文件输入路径。

跨项目资源 JSON 契约和 fixture 与本记录同批固定，后续包可依此实施；新增供应商的路径支持验证属于能力扩展，不重新打开 P0 基础设施结论。
