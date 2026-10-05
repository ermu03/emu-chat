# 图片工作流安装与维护

图片能力由 emu-chat 和独立 Hermes 插件 `emu-media` 共同提供。当前部署组合为 Hermes `6005aa1`、emu-media **0.2.0**（协议 v1）和 emu-chat `v1.0.2`（`c27c10e`）。插件 0.2.0 包含 JSON 请求与历史响应分块读取修复，沿用现有数据库结构。两个开发仓库的改动需要各自固定提交后再发布；开发工作树不是运行目录。

## 发布顺序

1. 暂停相关写入后备份 emu-chat 数据库、Hermes 会话与配置、`$HERMES_HOME/emu-media/`。SQLite 主库使用 backup API，不忽略 WAL；记录 Hermes、插件和 emu-chat 的提交号。
2. 将固定提交的插件安装到 `$HERMES_HOME/plugin-releases/emu-media/<版本>/`，让 `$HERMES_HOME/plugins/emu-media/` 指向该目录。数据继续放在 `$HERMES_HOME/emu-media/`，沿用 Hermes 当前 Python 环境，不修改 Hermes 核心。
3. 在 Hermes 服务环境配置 `EMU_MEDIA_API_KEY`、`EMU_MEDIA_HERMES_BASE_URL` 和 `EMU_MEDIA_HERMES_READ_KEY`。后者必须是 Hermes 实际接受的 API key；当前基线使用与 emu-chat `HERMES_API_KEY` 相同的值，没有独立只读 key 注册机制。启用插件并重启 Hermes；验证无密钥能力接口返回 401、认证接口返回协议 v1，以及历史 key 能读取 `/api/sessions/<id>/messages`。只检查 capabilities 不能发现历史凭据错误。这些检查不发起模型调用。
4. 在 emu-chat 服务环境配置相同的 `EMU_MEDIA_API_KEY`，发布构建版本并启动。启动时自动应用 `0002_media.sql`；不要改写已应用的 `0001_initial.sql`。普通 Hermes `HERMES_API_KEY` 与插件密钥分别管理。
5. 在隔离会话验证 PNG/JPEG/WebP 上传、草稿刷新、仅附图发送、生成图片采集、下载、复用、分支和删除。桌面与窄屏浏览器分别检查文件选择、粘贴、拖放、查看器和取消上传。实际模型图像质量与模型是否主动调用工具不属于基础设施保证。

## 本机插件发版

插件工具源码和完整维护说明在 `/home/emu/projects/hermes-emu-media/scripts/release.py` 与该仓库 `DEPLOYMENT.md`。已同步的工具位于 `/home/emu/.hermes/bin/emu-media-release`：

```bash
/home/emu/.hermes/bin/emu-media-release build 0.2.0 v0.2.0
/home/emu/.hermes/bin/emu-media-release deploy 0.2.0
```

构建在固定源码上运行现有隔离资源与 Hook 验证。部署通过独立 `emu-media-deploy-*` systemd 用户任务执行，可跨 Hermes 自身重启继续完成。工具拒绝中断 active agents；暂停 emu-chat 和 Hermes 后备份，修正历史配置，切换插件链接，先启动 Hermes 再启动 emu-chat并验证。命令提交后必须查看返回的任务日志确认上线，不能将任务提交当作发布成功。

插件目录 `RELEASE_INFO` 记录源码提交、版本、协议、部署时间、前一个版本和备份路径。0.2.0 部署不会升级 emu-chat 或改变 Node；emu-chat 的发版流程见 [部署说明](deployment.md)。

插件发布备份保存到 `/home/emu/.hermes/plugin-backups/emu-media/`。Hermes 当前内置备份仅对 `.db` 做 SQLite backup，插件 `media.sqlite` 被当作普通文件，不能依赖它在线生成可靠的插件索引快照。emu-chat 发版工具会单独对该库做安全快照，但备份时 Hermes 仍在线，各库不保证同一时间点一致；插件发版工具则暂停两个服务后做快照，独立外部 CLI 写入需另外暂停。

## 运行和故障恢复

插件数据在 `$HERMES_HOME/emu-media/`，emu-chat 的本地 `media_outbox` 保存待重试的会话登记、引用交接和删除。插件暂停时，纯文字聊天照常工作；附件草稿保留，但带不可用图片的发送必须等待恢复。恢复插件后重启或等待 worker 重试，并打开对应会话触发历史对账。`capture_failed` 可用“重试保存”再次采集已知来源，不会再次执行付费 Run。

当前会话中，已完成且含生图工具调用的 Run 若图片仍在采集或历史补偿中，前端每 2.5 秒刷新历史，最多持续 90 秒；切换会话会取消该刷新。点击“重试保存”后，卡片每 2.5 秒检查对应工具调用的资产列表，状态改变或 90 秒到期后停止。插件读取 Hermes 历史与自身 JSON 请求时会处理分块传输，同时保留 8 MiB 历史响应上限、128 KiB 请求上限及现有超时。

图片初始上传成功但草稿保存冲突时，应重新保存草稿或删除未使用的附件；已进入本地缓存且超过 24 小时没有本地引用的上传会排队释放。插件再检查持久提交和引用，最后一份引用消失后至少保留 24 小时才物理删除。历史图片不跟随队列控制记录 7 天期限回收。图片请求的正文与冻结 Run 输入按同一正文期限清空；后台保留不含正文的提交摘要凭据，控制记录到期或插件暂时离线时仍能验证历史输入图片。旧凭据缺失时需插件绑定核验，不能仅凭消息里的机器清单关联资源。

压缩导致 Hermes 有效 session ID 变化时会登记别名；分支复制消息的图片经权威历史映射后才授予新 scope。映射待处理期间不能删除来源会话。会话删除会持久化插件 scope 删除任务，失败可在服务重启后继续；已删除会话的图片访问立即撤销。

## 升级与回退

升级 Hermes 前，在隔离环境重新运行插件的公开 API/Hook 测试，检查本地文件输入、输出字段及插件持久目录是否仍被保留。升级顺序仍是插件先于 emu-chat。回退代码之前备份当前状态；如果 schema 或协议不兼容，恢复同一备份中的 emu-chat 控制库、Hermes 会话以及插件索引和文件，不能仅运行 `git checkout`。回退后检查能力接口、附件读取、未完成采集和删除任务。

初始开发批次的自动化使用模拟工具输出和隔离的 Hermes profile。0.2.0 正式部署检查包含认证、真实历史读取、已有图片内容与历史补偿，不执行付费供应商图片调用。
