# MemStore

[English](README.md) | [简体中文](README.zh-CN.md)

MemStore 是面向 coding agent 的长期记忆系统，采用程序与数据分离的设计：程序保存在本仓库，正式记忆（Canonical Memory）保存在用户指定的 Obsidian Vault，机器运行状态保存在单独指定的 Runtime 目录。

本仓库提供面向 Codex 的 macOS 安装器，先预览、再应用。安装器会构建程序和通知应用、发现 Obsidian Vault、准备本地 E5 模型、合并受管的 Hooks／MCP／Skills 配置、启动 Worker，并验证前台检索。正式记忆、机器运行数据和程序仓库始终分开保存。运行时可通过 `memstore status` 和 `memstore doctor --deep` 检查状态。

## 在 macOS 上安装

### 前置条件

- macOS 13 或更新版本。
- Node.js `>=22.17.0 <23`，pnpm `>=10.25.0 <11`。
- Xcode Command Line Tools，包含 Swift 6 和 `codesign`。
- 已安装并登录 Codex CLI，且账号有权使用 `gpt-5.6-luna` 和 `gpt-5.6-terra`。当前适配器固定使用 Luna `medium` 思考深度和 Terra `low` 思考深度，两者均为 `service_tier="default"`，不使用 Fast 模式。
- 已在 Obsidian 中至少打开过一次准备使用的 Vault。
- Codex 已创建 `~/.codex/config.toml`。安装为 Active 模式时，还要求其 `[memories]` 段显式设置布尔值 `generate_memories` 和 `use_memories`，以便回滚时准确恢复原状态。

将 MemStore 克隆到长期保留的固定路径，然后预览安装：

```sh
git clone https://github.com/LeonYuanYao/agent-mem-store.git ~/Applications/MemStore
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

## 日常使用

### 记忆采集与检索

Codex 集成会采集会话事件，交由后台提取知识。Luna 生成 Agent-derived 候选，只有通过准入的正式长期记忆才参与正常召回。人工编写的断言保留其权威性，Project 知识不会自动升级为 Global 知识。

SessionStart 背景注入**默认关闭**。如需启用，在 `<runtime>/config.toml` 的 `[adapters]` 段设置 `session_start_injection = true`。配置缺失或不可读时保持关闭。Hook 在每次 SessionStart 读取开关；事件采集保留，UserPromptSubmit 检索不变。首次非空的 prompt 注入会按需附带记忆标识说明。关闭开关无法移除对话中已经存在的记忆文本。

启用后，SessionStart 选择项目／全局背景，最多 12 条、1,200 tokens，不针对第一条用户消息排序。UserPromptSubmit 根据当前任务检索，目标预算为 600 tokens，最多 1,024 tokens、6 条。这些数字是上限，不要求填满。检索结果可能不相关或互相重叠，Agent 使用前应结合当前任务和显式指令判断。`<memstore-candidates>` 表示可能相关的检索结果，不表示生命周期中尚未准入的 Candidate。

自动注入和显式检索使用不同预算。如果注入内容不足，可以使用受管的 `memstore-recall` Skill 搜索并阅读完整记忆；上述自动注入上限不适用于显式搜索。

### Skills 与 MCP 工具

安装器管理三个 Skill：

- `memstore-recall`：搜索记忆、按 ID 深读、查看来源和相关知识。
- `memstore-remember`：保存精确的人工断言，或让 Luna 从一轮对话、整个 Session 或文件中提取知识。默认使用 Project 范围，Global 需要显式请求。提取异步执行，仍需通过准入检查。
- `memstore-repair`：指导用户主动发起的不相关检索 Bad Case 排查，不授权后台静默修改代码。

MCP server 提供 `memstore_search`、`memstore_get`、`memstore_provenance`、`memstore_related`、`memstore_report_irrelevant`、`memstore_archive` 和 `memstore_restore`。记忆写入通过 Skill／CLI 完成，物理删除仅通过 CLI 提供。

### 存储、治理与保留策略

| 位置 | 用途 |
| --- | --- |
| `<vault>/Memories/` | 当前正式记忆文件，包括保留期内的归档记忆 |
| `<vault>/_MemStore/Revisions/` | 记忆历史修订 |
| `<vault>/_MemStore/policy.toml` | 可迁移的治理、保留和容量策略 |
| `<vault>/_MemStore/Review Inbox.md` | 自动生成的复核事项和运行提示 |
| `<runtime>/config.toml` | 机器本地路径与适配器设置 |
| `<runtime>/state/memstore.sqlite` | 队列、候选、回执及其他运行状态 |

Runtime 默认位于 `~/Library/Application Support/MemStore`。Embedding 模型和可重建索引也保存在 Runtime 中，与 Vault 分离。不要通过 Obsidian 同步正在使用的 SQLite 数据库或其 WAL 文件。

治理按固定的 `Asia/Shanghai` 时区执行：增量治理（内部类型 `weekly`）每 3 天 19:00 执行一次，以 2026-09-11 为日历起点；全量治理（内部类型 `monthly`）每周一 19:00 执行。计划不会跟随出差时机器时区的变化。离线错过的任务会合并补跑，重启不会重置日历周期。

`policy.toml` 中的默认保留设置：

- `retention.archive_months = 3`：符合条件的归档记忆到期后自动物理清除。受保护记忆和单条记忆显式指定的期限按生命周期规则处理。定时清除前，Worker 会准备并验证受管备份；下文的手动清除命令则要求另行提供经过验证的备份。
- `retention.sensitivity_metadata_days = 15`：清理过期的脱敏诊断记录。
- `retention.injection_receipt_days = 30`：清理符合条件的过期注入回执，保留受保护证据并记录每日汇总。
- `retention.candidate_tombstone_days = 180`：候选墓碑的保留期，不是正式 Memory 墓碑的保留期。

删除数据会释放 SQLite 内部可复用空间，但不一定立即缩小数据库文件。保留期清理与数据库压缩是两项不同的维护操作。

容量治理限制的是正常参与召回的 Working Set。Project 默认目标为 2,500 条、硬上限 3,500 条、回落目标 2,200 条；Global 分别为 300、500、270 条。移出 Working Set 会保留记忆，与归档、物理删除不同，因此完整保留的知识条数可以超过 Working Set 上限。

### 支持范围与安全边界

当前受管宿主集成面向 macOS 上的 Codex，尚未提供 Claude Code 适配器。模型调用使用 Codex 登录凭据并依赖网络；本地 Embedding 不代表后台提取可以完全离线运行。

Vault 以明文保存知识，MemStore 不提供应用层加密。不要把密码、token 或其他凭据存为记忆。当前设计不支持两个 MemStore 写入端同时使用同一个同步 Vault。迁移 Vault 保留的是可迁移知识，不包含待处理任务、Session 路由或机器运行状态；迁移前应检查 `portability readiness`。

详细约定见 [SPEC.md](SPEC.md)，设计决策见 [ADR 目录](docs/adr/)。历史 Gate 证据用于工程验证，不能代替实时健康检查或记忆质量评估；运行状态和实际检索效果需要分别检查。

## 开发与运维

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

已有受管安装可以先预览小范围升级，再决定是否应用。当前升级可以补充缺失的受管 `memstore` CLI，也可以更新未被改动的受管 CLI 包装脚本。其他目标偏离预期时，只报告而不改写；CLI 包装脚本与记录的身份不符时会拒绝升级：

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

## Agent 与模块文档

开发前先阅读 [AGENTS.md](AGENTS.md) 中的工作边界和验证命令，再通过[源码地图](src/README.md) 找到所修改模块的 README。模块说明涵盖关键入口、协作关系、数据归属、约束及专项测试；[CONTEXT.md](CONTEXT.md)、[SPEC.md](SPEC.md) 和 [ADR](docs/adr/) 分别提供领域术语、产品约定及设计决策背景。

## 许可证

MemStore 使用 [MIT License](LICENSE)，版权署名为 2026 Yuan Yao。
第三方依赖和模型文件保留各自的许可证；你私有 Vault 中的知识内容独立于本软件许可证。
