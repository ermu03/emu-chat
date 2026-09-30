# 本机部署与发版

本机开发仓库为 `/home/emu/projects/emu-chat`，生产根目录为 `/home/emu/.emu-chat`。用户级 `emu-chat.service` 提供生产页面和 API，监听端口由生产 `.env` 决定，本机为 3100；开发后端为 3104。

## 系统 Node

开发、构建和生产共用 apt 管理的 `/usr/bin/node`、`/usr/bin/npm` 和 `/usr/bin/npx`，支持 Node 24 LTS。生产目录不再安装独立 Node。Hermes 的 `/home/emu/.hermes/node` 由 Hermes 自己维护。

Ubuntu 默认软件源的 Node 主版本可能较旧。本机使用 NodeSource 的 Node 24 软件源，由 apt 安装和升级。首次安装可下载并检查官方脚本，再执行：

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x -o /tmp/emu-chat-node24-source
sudo bash /tmp/emu-chat-node24-source
sudo apt-get install -y nodejs
rm /tmp/emu-chat-node24-source
/usr/bin/node --version
/usr/bin/npm --version
```

确认 `command -v node npm npx` 指向 `/usr/bin`。本机原先的 `~/.local/bin/node`、`npm`、`npx` 指向 Hermes 的运行时，迁移时移除了这三个软链接；不删除 Hermes 自己的二进制或调整 Hermes 服务的 PATH。已有终端可能缓存命令位置，执行 `hash -r` 或重开终端。

主版本变更后执行 `npm ci`，重新安装 `better-sqlite3` 原生依赖。所有需要运行或用于回退的发布版本也必须重新构建；仅改变启动路径无法让旧原生模块兼容。补丁升级后安排生产服务重启，使运行进程与系统安装一致；发布记录保留构建时和启动时的 Node 版本。

## 目录与工具

```text
/home/emu/.emu-chat/
├── current -> releases/<版本标识>
├── previous                  # 最近一次成功部署之前的版本标识
├── releases/<版本标识>/      # 固定提交的源码、dist、生产 node_modules、RELEASE_INFO
├── data/                     # 跨版本生产数据库
├── .env                      # 跨版本生产配置，权限 600
├── backups/                  # 发布前备份与旧工具配置备份
└── bin/
    ├── start                 # 使用 /usr/bin/node 启动当前版本
    └── release               # 独立 Python 发版工具
```

工具源码位于项目的 `scripts/release.py` 和 `scripts/start-production`。维护后同步到部署目录：

```bash
install -m 700 scripts/release.py /home/emu/.emu-chat/bin/release
install -m 700 scripts/start-production /home/emu/.emu-chat/bin/start
```

服务 `WorkingDirectory` 为 `/home/emu/.emu-chat/current`，`EnvironmentFile` 为根目录 `.env`，设置 `NODE_ENV=production` 和 `PATH=/usr/bin:/bin`。应用从工作目录读取静态文件与迁移，因此切换链接后必须重启。

## 构建固定提交

```bash
/home/emu/.emu-chat/bin/release list
/home/emu/.emu-chat/bin/release build v1.0.3
# 或明确选择已提交的源码；允许开发工作树有其它尚未提交的修改
/home/emu/.emu-chat/bin/release build v1.0.3 <commit-or-tag>
```

未指定 ref 时要求开发工作树干净，并使用 HEAD。明确指定 ref 时，只导出该提交，未提交改动不会包含在发布中。版本标识是部署目录名称；工具不自动创建 Git tag、提交或推送。维护者可在提交代码后自行创建 tag，再按 tag 构建。

构建使用 `git archive` 导出固定提交，执行 `npm ci --include=dev`、`npm run build`，最后 `npm prune --omit=dev`。不复制开发 `.env`、数据库、旧 dist 或 node_modules。记录源码提交、构建时间、Node/npm 版本、原生 ABI 和锁文件哈希，并检查构建物及 SQLite 原生模块能加载。失败时清理暂存目录，构建完成后才出现正式版本目录。版本名称不可覆盖。

项目流程和 Node 声明的改动遵循 AGENTS.md：默认留在开发工作树，由用户提交。如果需要发布这些修改，应先提交，然后从新提交构建。

## 部署与检查

发版前确认生产配置、Hermes API 与图片插件就绪。生产 `EMU_CHAT_DATA_DIR` 必须是 `/home/emu/.emu-chat/data`，`.env` 不放在 release 中。图片密钥需与 Hermes 插件一致，不能从开发环境变量隐式读取。

```bash
/home/emu/.emu-chat/bin/release deploy v1.0.3
```

工具提交独立的 `emu-chat-deploy-<时间戳>.service` 用户任务，随即返回任务名称。它可以在 emu-chat 自身重启后继续运行。命令返回只表示提交成功，必须查看任务日志确认出现 `Activated <版本>`：

```bash
journalctl --user -u <返回的任务名称> -f
systemctl --user status emu-chat.service
/home/emu/.emu-chat/bin/release list
curl -fsS http://127.0.0.1:3100/api/v1/status
```

任务获取发版锁后检查发布目录、原生 ABI、生产配置、已应用的迁移以及配置了密钥的图片插件协议，然后停服、备份、以同目录临时链接加 rename 原子替换 current、启动并检查。检查覆盖实际进程目录和系统 Node 路径、前端 HTML、API healthy 状态。通过后才更新 previous 和发布状态。`switch` 是 `deploy` 的别名，包含重启和检查。

这会造成短暂服务中断，不是零停机热更新。重启使用 `systemctl`，不使用 `pkill`。浏览器在发布成功后刷新；需要时强制刷新缓存。

应用启动自动执行尚未应用的增量迁移。图片版本增加 `0002_media.sql`；已经应用的迁移不可改写。图片插件维护与故障恢复见开发仓库的 `docs/11-image-workflows.md`。

## 备份与回退

自动备份保存生产配置、emu-chat 控制库及其它 data 文件，同时对 Hermes 的会话库、response_store、runs_idempotency 和图片插件索引使用 SQLite backup API，并复制 Hermes 配置与图片原文件。数据库备份会检查完整性，不直接复制运行中的主库而忽略 WAL。

emu-chat 在自动备份期间停止；Hermes 继续运行。各 SQLite 快照分别一致，外部文件与多个库不承诺同一时刻的跨服务事务快照。需要完整数据恢复时，应暂停相关写入，再核对 Hermes 会话、图片索引与文件；自动备份不替代这个恢复流程。

```bash
# 默认使用 previous，也可指定一个明确的旧版本
/home/emu/.emu-chat/bin/release rollback
/home/emu/.emu-chat/bin/release rollback <旧版本标识>
```

回退同样执行备份、切换、重启和检查。若数据库存在目标代码没有的迁移，工具默认拒绝。确认旧代码能使用新 schema、不会丢失图片引用与未完成外部任务后，才可以显式指定 `--allow-newer-schema`。该参数不会降低数据库 schema，也不会恢复旧数据。

新版启动失败时，只有旧版 Node ABI 与迁移集合兼容才自动回退代码；否则停止服务并在日志里给出备份位置，等待兼容性修复或人工恢复。不会自动用旧数据库覆盖发布后的数据。

旧代码可能无法管理新增图片状态；恢复备份也可能丢失备份之后的操作，因此不承诺无损回滚。保留旧 release 及备份，并按故障原因选择修复前进、兼容代码回退或协调数据恢复。

## 常见故障

- `System /usr/bin/node must be Node.js 24 LTS`：检查系统软件包和 Node 路径。
- `Native dependency ABI differs`：从对应提交重建 release，不复制旧 node_modules。
- `Working tree is dirty`：提交改动，或明确传入已提交 ref。
- 部署任务失败：先看该任务和 `emu-chat.service` 日志，再检查 current、实际运行目录与备份位置。
- 旧版存在开发 `.env`/`data` 或缺少 ABI 元信息：作为历史记录保留，从对应提交重新构建可部署版本。

生产目录 README 和 DEPLOYMENT.md 是本机运维入口；修改本流程时同步它们和部署工具。
