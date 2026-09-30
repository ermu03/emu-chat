# Agent Note: 统一系统 Node 与生产发版流程

Status: implemented

## Problem

开发 shell 默认使用 Hermes 管理的 Node 26，生产使用部署目录的 Node 22。旧发版工具复制工作树，会带入开发密钥和数据库；切换与实际进程启动分离，文档承诺原子切换和无损回滚但工具没有保证。

## Decision

由 apt 管理系统 Node 24 LTS，开发、构建和生产明确使用同一系统二进制。保留 Hermes 自己的运行时。源码通过 git archive 固定提交导出，构建后裁剪开发依赖。部署由独立 systemd 用户任务执行，停服务后备份控制库、替换链接、启动并检查 HTTP 与实际进程。跨版本配置和数据库继续保存在部署根目录。

工具源码随项目维护，复制到部署 bin 后独立运行。回退先核对数据库迁移兼容性；不自动恢复旧数据库覆盖新数据。升级 Node 主版本后重新安装所有可运行版本的原生依赖。

## Alternatives considered

- 保留独立 Node 22：已有生产环境验证充分，但不符合统一系统运行时的目标。
- 系统 Node 26：与当前 shell 相近，但当前仍为 Current，选择已进入 LTS 的 24。
- 复制工作目录：方便包含未提交修改，但无法将发布内容严格对应到提交，且容易带入开发配置与数据。

## Consequences

开发、构建和生产共用 apt 安装的 Node 24.21.0 和 npm 11.19.0；Hermes 自己的运行时保持原样。部署不再维护独立 Node，固定提交的构建不带开发配置和数据，systemd 独立任务可跨 emu-chat 自身重启完成发版。生产和开发数据继续分开。

系统主版本升级需要重新构建原生依赖及可回退版本；自动回退只在原生 ABI 和迁移集合兼容时执行。Hermes 在发版备份期间仍运行，外部 SQLite 快照分别一致，跨系统恢复需暂停写入并核对会话及图片文件，不能承诺无损回滚。

代码与流程声明的修改按项目约定留在工作树，由用户提交。本次应用发布从既有提交 c27c10e 导出，不包含这些未提交流程文件；部署控制工具已独立同步到 bin。

## Verification

- 系统安装为 /usr/bin/node 24.21.0；生产 MainPID 的 exe 为同一文件，cwd 为 releases/v1.0.2。
- Node 24 下 typecheck、lint、format:check、现有测试和构建通过，better-sqlite3 能加载。
- 从 v1.0.1 tag 重建了 v1.0.1-node24 并实际上线检查，再发布 c27c10e 的 v1.0.2；新发布无 .env/data，依赖裁剪为生产集合。
- 生产副本及实际控制库都成功应用 0002_media.sql；原有 9 个会话、9 份草稿、53 条队列和 53 条 Run 数量保留，SQLite quick_check 为 ok。
- 前端 HTML、JS/CSS、API healthy、会话列表和图片能力接口正常；未执行付费模型验证。
- 升级前备份在 /home/emu/.emu-chat/backups/20260930T141642084584Z，旧版 Node 24 构建保留；新增迁移使默认回退旧代码被兼容性检查拦截。
- home 下四个 .sh 和一个 .py 过渡文件、部署 runtime 与安装临时脚本均已清理。

当前流程见 [部署说明](../../../../docs/deployment.md)，工具源码见 [release.py](../../../../scripts/release.py)。
