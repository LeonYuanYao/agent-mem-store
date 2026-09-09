# MemStore

[English](README.md) | [简体中文](README.zh-CN.md)

MemStore 是面向 coding agent 的长期记忆系统，采用程序与数据分离的设计：程序保存在本仓库，正式记忆（Canonical Memory）保存在用户指定的 Obsidian Vault，机器运行状态保存在单独指定的 Runtime 目录。

本仓库提供面向 Codex 的 macOS 安装器，先预览、再应用。安装器会构建程序和通知应用、发现 Obsidian Vault、准备本地 E5 模型、合并受管的 Hooks／MCP／Skills 配置、启动 Worker，并验证前台检索。正式记忆、机器运行数据和程序仓库始终分开保存。运行时可通过 `memstore status` 和 `memstore doctor --deep` 检查状态。

## 在 macOS 上安装

### 前置条件

- macOS 13 或更新版本。
- Node.js `>=22.17.0 <23`，pnpm `>=10.25.0 <11`。
- Xcode Command Line Tools，包含 Swift 6 和 `codesign`。
- 已安装并登录 Codex CLI，且账号有权使用配置中的 Luna 和 Terra 模型。
- 已在 Obsidian 中至少打开过一次准备使用的 Vault。
- Codex 已创建 `~/.codex/config.toml`。安装为 Active 模式时，还要求其 `[memories]` 段显式设置布尔值 `generate_memories` 和 `use_memories`，以便回滚时准确恢复原状态。

将 MemStore 克隆到长期保留的固定路径，然后预览安装：

```sh
git clone https://github.com/LeonYuanYao/AMemStore.git ~/Applications/MemStore
cd ~/Applications/MemStore
./install.sh
```

默认命令会构建仓库内的产物，并预览将对用户配置、Vault 和 Runtime 产生的影响；预览不会写入这三类目标。安装器会自动选择唯一打开的 Obsidian Vault，或唯一登记的 Vault。如果有多个同等符合条件的 Vault，请显式指定：

```sh
./install.sh --vault /path/to/Obsidian/Vault
```

确认预览后应用安装：

```sh
./install.sh --apply
```

首次应用会下载并校验约 295 MB 的 E5-base q8 模型。默认使用 Active 模式：创建可回滚的切换备份，关闭 Codex 原生记忆开关，并启用 MemStore 注入。此过程不会读取、移动、导入或删除原生记忆数据。如果希望只观察采集和检索、不注入记忆也不替换原生记忆功能，可选择 Shadow 模式：

```sh
./install.sh --mode shadow --apply
```

Worker 就绪后，安装器会申请 macOS 通知权限。拒绝通知不会关闭采集、治理、检索或 Obsidian Review Inbox；最终结果会明确报告通知权限状态。

安装后，可在任意目录验证：

```sh
~/.local/bin/memstore doctor --deep
~/.local/bin/memstore status
```

`setup` 最多等待 30 秒，让前台 Worker socket 就绪。如果提示文件已安装但 Worker 不可用，请运行深度检查，修正报告中的前置条件问题，然后重试相同的安装命令。部分完成的安装会保持 Shadow 状态，不改变 Codex 原生记忆配置；重试会继续完成安装。

成功安装为 Active 模式后，再次运行 setup 也是安全的：它会校验并保留已记录的切换，不会再次切换。对于已有的旧版 MemStore 安装，如果当前 Active MCP 和 Hook 配置仍准确符合约定，预览会提供 `adopt_legacy_active_installation` 操作。应用后会记录新的受管归属和回滚基线，不改写当前 Codex 配置、Hook 内容或知识数据。未知的受管 Hook 修改或其他目标文件偏离预期时，安装器会拒绝继续。

**安装后不要移动或删除 Git 仓库目录。** 受管 CLI、Hooks、MCP server、Skills 和 LaunchAgent 都引用这个已确认的程序位置。

自动化调用可添加 `--json`。构建进度写入 stderr，stdout 只输出最终 JSON 结果：

```sh
./install.sh --vault /path/to/vault --apply --json
```

## 开发

### Hook 注入内容的显示方式

在机器本地 `<runtime>/config.toml` 的 `[adapters]` 段中，将 `hook_display` 设置为 `"off"`、`"summary"`（默认）或 `"full"`：

- `summary`：显示事件、记忆条数、按顺序排列的引用和注入 token 数。
- `full`：额外显示实际传给模型的注入文本；不会展开为 Vault 中的完整笔记。
- `off`：隐藏成功注入的提示，保留采集失败警告。

空检索结果不显示提示。SessionStart 和 UserPromptSubmit 共用此设置，每次成功检索时读取，无须重启 Worker。该设置仅改变 `systemMessage` 的展示，不改变检索、模型上下文或 token 预算。显示配置缺失或不可读时回退到 summary，避免展示问题阻塞记忆传递；正常配置校验会拒绝无效值。此偏好不保存在可迁移的 Vault 中。

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm benchmark:retrieval
pnpm evidence:gate4
pnpm evidence:purge
pnpm evidence:gate5
```

默认测试套件可在干净克隆的仓库中独立运行。历史 Gate 和清除操作的证据契约测试单独运行，因为对应 JSON 产物只保留在本机；生成这些产物后，执行 `pnpm test:evidence`。

预览隔离环境的初始化，不写入数据：

```sh
pnpm exec tsx src/cli/main.ts init \
  --vault /path/to/test-vault \
  --runtime /path/to/test-runtime \
  --preview --json
```

以下为仅用于开发环境的显式记忆操作示例：

```sh
pnpm exec tsx src/cli/main.ts remember assert \
  --scope project --text "Use pnpm for this project." \
  --vault /path/to/test-vault --runtime /path/to/test-runtime \
  --preview --json

pnpm exec tsx src/cli/main.ts recall search "package manager" \
  --scope current \
  --vault /path/to/test-vault --runtime /path/to/test-runtime \
  --json
```

### 理解健康状态

`doctor --deep --json` 检查当前健康状态；`status --json` 同时提供相同的前台检索／索引健康判定和历史统计。

- `healthy`：当前检查通过，也已满足所需的恢复验证条件。
- `observing`：恢复仍待确认，或索引处于有明确时间边界的同步／重试期间。它既不表示已确认的故障，也不表示所有恢复工作已经完成。
- `degraded`：至少还有一项当前警告，需要查看对应的恢复条件。
- `error`：存在需要处理的完整性问题或检查错误。

前台检索恢复要求最后一次失败后，连续十分钟没有新失败，并完成五次成功的逻辑请求。仅等待、返回空结果或取消请求都不能证明恢复。因此，使用频率低时，详细状态可能保持为 `awaiting_verification`，直到实际完成足够的请求。系统不会为此调用 LLM 探测，也不需要重置历史计数。索引发布待同步版本后，相关警告会自动消失；预期等待有明确的时间边界。

### 将一个 Session 迁移到另一个项目

Session 路由仅对指定的完整 Codex thread ID 生效。绑定后，即使工作目录不变，该 Session 后续的 Hook 采集、自动召回和排队中／后台的知识提取也会使用目标项目。其他线程和 fork 仍按各自的规则解析项目；显式指定的 global 提取仍保持全局范围。

```sh
memstore project route-session --session-id THREAD_ID --project-id TARGET_PROJECT_ID \
  --vault /path/to/vault --runtime /path/to/runtime --preview --json
```

移除 `--preview` 即可绑定后续处理。这个命令**不会迁移已有知识**。已有 Session 的历史知识应使用下面的维护命令：

```sh
memstore project migrate-session --session-id THREAD_ID \
  --from SOURCE_PROJECT_ID --project-id TARGET_PROJECT_ID \
  --vault /path/to/vault --runtime /path/to/runtime --preview --json
```

应用前，先暂停并停止 Worker，再备份 Runtime 数据库和 Vault。应用要求 `worker_control.worker_paused = 1`。这是离线维护操作，不支持多个写入进程并发迁移。它会移动通过 Session 候选记录关联的当前项目记忆，以及仍有效的候选记录；已拒绝／已过期的候选记录保留为历史。多来源共享记忆和目标项目中的候选冲突需要单独 review。

记忆 ID、数字引用、作者属性、正文和来源追溯信息保持不变。每条迁移的记忆都会创建一个新修订；采集事件、证据、旧修订和注入回执保留原始历史。

迁移还会安装对应的 Session 路由。可重放的迁移计划保存在 `<runtime>/state/session-migrations/`，应保留到迁移验证完成。迁移中断后，可以在 Worker 保持停止的情况下，用相同参数重试。成功后重启并解除 Worker 暂停；旧检索快照会取消选用，必须重建索引后才能恢复召回。已经注入对话的文本无法追溯移除。

Session 绑定以原子写入的 JSON 文件保存在 `<runtime>/state/session-projects/`，避免每次 Hook 都额外竞争 SQLite 锁。它属于机器本地运行状态，不属于可迁移知识。显式 CLI 召回可以传入 `--session-id THREAD_ID`，`memstore_search` 接受 `session_id`。没有该身份时，显式工具沿用正常配置的工作区范围，不会从继承的进程环境变量猜测线程。

在仓库内执行运维命令的示例：

```sh
pnpm exec tsx src/cli/main.ts doctor --deep \
  --vault /path/to/test-vault --runtime /path/to/test-runtime --json

pnpm exec tsx src/cli/main.ts review generate \
  --vault /path/to/test-vault --runtime /path/to/test-runtime \
  --preview --json

pnpm exec tsx src/cli/main.ts runtime backup \
  --output /path/to/backup/memstore.sqlite \
  --vault /path/to/test-vault --runtime /path/to/test-runtime \
  --preview --json

pnpm exec tsx src/cli/main.ts portability readiness \
  --vault /path/to/test-vault --runtime /path/to/test-runtime --json

pnpm exec tsx src/cli/main.ts shadow verify \
  --file /path/to/human-reviewed-source-first-verification.json \
  --vault /path/to/test-vault --runtime /path/to/test-runtime \
  --preview --json
```

`shadow verify` 根据精确的采集事件和当前有效的记忆身份，校验一次 source-first review（基于原始来源的复核）。移除 `--preview` 后，会将已复核结果写入机器本地 Runtime 数据；它不会创建或修改正式长期记忆（Durable Memory）。

已有受管安装可以先预览小范围升级，再决定是否应用。当前升级仅补充缺失的受管 `memstore` CLI；对于已安装但偏离预期的目标，只报告而不改写：

```sh
pnpm exec tsx src/cli/main.ts integration upgrade \
  --home /path/to/home --repo /path/to/MemStore \
  --vault /path/to/vault --runtime /path/to/runtime \
  --notifier /path/to/MemStore\ Notifier.app \
  --preview --json
```

破坏性的归档清除操作始终要求一份经过单独验证的 Vault 备份。默认先通过预览进行 review：

```sh
pnpm exec tsx src/cli/main.ts purge preview \
  --backup /path/to/verified-vault-backup \
  --vault /path/to/test-vault --runtime /path/to/test-runtime --json

pnpm exec tsx src/cli/main.ts purge run --preview \
  --backup /path/to/verified-vault-backup \
  --vault /path/to/test-vault --runtime /path/to/test-runtime --json
```

`purge run` 会执行物理删除，因此这里不提供可直接复制执行删除的开发示例。Outcome 12 的证据验证只会在操作系统临时 Vault 中执行它。

单条记忆的生命周期操作也默认预览。归档在配置的保留期内可撤销；恢复会开始新的 Active 周期：

```sh
memstore archive M:123 --reason obsolete
memstore archive M:123 --reason obsolete --apply
memstore restore M:123 --apply
```

单条记忆的永久删除仅通过 CLI 提供，且只接受已归档（Archived）的记忆。它会拒绝删除受保护内容，要求经过验证的备份，并将实际应用绑定到预览时确定的目标和备份：

```sh
memstore purge-memory M:123 --backup /path/to/verified-vault-backup
memstore purge-memory M:123 --backup /path/to/verified-vault-backup \
  --gate <approvalDigest-from-preview> --apply
```

`memstore_archive` 和 `memstore_restore` 向 MCP 客户端提供相同的可逆操作。不传 `apply` 时只预览。MCP 不提供物理清除入口。

构建后的可执行入口为 `memstore` 和 `memstore-mcp`。MCP server 读取 `MEMSTORE_VAULT_ROOT` 和 `MEMSTORE_RUNTIME_ROOT`；stdout 专用于协议输出，诊断信息写入 stderr。

**不要将开发测试指向真实的记忆 Vault。** 测试会创建自己的操作系统临时目录。
