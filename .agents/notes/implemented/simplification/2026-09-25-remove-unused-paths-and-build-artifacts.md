# Agent Note: 清理未接入的运行路径与构建产物

Status: implemented

## Problem

设置抽屉已从页面移除，但组件、样式和类型依赖仍留在代码中。服务端同时保留了一套无人调用的协调器入队及运行操作，容易与实际由 `QueueRunService` 执行的流程混淆。前端构建还生成没有注册入口的 Service Worker，并与静态 manifest 重复维护安装元数据。

## Decision

- 删除设置抽屉及其样式，由现有偏好响应类型承载页面需要的字段；保留正在使用的偏好 API。
- 删除协调器中无人调用的入队、取消、查询和审批路径，以及只服务于旧入队实现的仓储方法与测试。消息入队继续由 `QueueRunService.sendMessage` 在即时事务中完成，协调器负责派发和对账。
- 使用 `public/manifest.webmanifest` 作为开发与生产共用的安装元数据；移除未注册的 Service Worker 构建插件。移除未调用的 SSE 解析包和测试交互包。
- 让服务启动时使用已解析的 `LOG_LEVEL` 配置设置日志器级别，并删除配置对象中未被读取的 `nodeEnv` 字段。

## Alternatives considered

- 保留 PWA 插件以便以后启用离线能力：重新启用时会少一步安装，但当前没有注册 Service Worker 的产品入口，生成文件不能提供离线功能，还会维护两份 manifest 信息。
- 保留协调器的旧操作作为备用：代码可供参考，但它绕过当前的草稿原子入队流程，继续存在容易被误接入。

## Consequences

活动路径更明确，构建不再输出无人使用的 Service Worker，生产页面只有一条 manifest 链接。若以后需要离线能力，应按当时的需求重新设计注册、缓存与失效策略。

## Verification

类型检查、lint、格式检查、构建与现有测试通过；构建产物只包含一份 manifest，且不包含 Service Worker。
