# claude-mem 默认注入策略与预算

检索日期：2026-08-04（Asia/Singapore）<br>
上游：`thedotmack/claude-mem` `main`<br>
核验 commit：[`f85bb28c4788ed6372e3406b3fc92cfbecf6df08`](https://github.com/thedotmack/claude-mem/tree/f85bb28c4788ed6372e3406b3fc92cfbecf6df08)<br>
`package.json` version：`13.13.1`

## 结论

claude-mem 当前默认采用“SessionStart 注入较宽的紧凑索引、UserPromptSubmit 不做语义注入、需要时再通过 MCP/Skill 展开”的策略。它的默认约束主要是条目数量，不是严格 token 或字符预算。

| 路径 | 当前默认 | 数量约束 | 硬 token/字符上限 |
| --- | --- | --- | --- |
| SessionStart | 开启，注入近期 timeline/index | 50 observations、10 session summary rows；0 条 observation 展开正文 | 未发现 |
| UserPromptSubmit semantic injection | 关闭 | 开启后默认 top 5；服务端路由限制 1–20 | 未发现 |
| PreToolUse file context | manifest 中存在；当前实现状态存在文档漂移 | 每文件先取 40、按 session 去重后最多 15；一次最多 10 个 path；title 最多 160 字符 | 未发现整体上限 |
| MCP/Skill 深入读取 | 按需 | 调用方决定 | 工具自身有结果数限制，但不是自动注入总预算 |

因此，不能把 claude-mem 描述为“默认每轮注入 5 条、总共约 1,000 tokens”。准确说法是：**默认只在 SessionStart 自动注入最多 50 条紧凑 observation index，并且官方用约 800–1,000 tokens 作为设计示例；每轮 semantic injection 默认关闭；代码没有强制自动注入总 token 上限。**

## SessionStart 默认行为

运行时代码默认值为：

- `CLAUDE_MEM_CONTEXT_OBSERVATIONS = 50`
- `CLAUDE_MEM_CONTEXT_SESSION_COUNT = 10`
- `CLAUDE_MEM_CONTEXT_FULL_COUNT = 0`
- `CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY = true`
- `CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE = false`

来源：[SettingsDefaultsManager](https://github.com/thedotmack/claude-mem/blob/f85bb28c4788ed6372e3406b3fc92cfbecf6df08/src/shared/SettingsDefaultsManager.ts#L116-L161)、[ContextConfigLoader](https://github.com/thedotmack/claude-mem/blob/f85bb28c4788ed6372e3406b3fc92cfbecf6df08/src/services/context/ContextConfigLoader.ts#L10-L28)。

Observation 与 summary 分别按时间倒序查询：observation 最多 50 条，summary 最多 10 条（查询会多取一个 summary 用于 timeline positioning）。它们受 project、platform source 和 mode type/concept 过滤，而不是限定为“最近 10 个 Session 内的 50 条 observation”。来源：[ObservationCompiler](https://github.com/thedotmack/claude-mem/blob/f85bb28c4788ed6372e3406b3fc92cfbecf6df08/src/services/context/ObservationCompiler.ts#L25-L121)。

`FULL_COUNT = 0` 意味着默认 timeline 只显示 observation ID、时间、类型和 title，不展开 narrative/facts。10 个 summary 会以 session request row 进入 timeline；满足条件时，最近 summary 的 investigated/learned/completed/next steps 还会额外展开。来源：[ContextBuilder](https://github.com/thedotmack/claude-mem/blob/f85bb28c4788ed6372e3406b3fc92cfbecf6df08/src/services/context/ContextBuilder.ts#L73-L107)、[AgentFormatter](https://github.com/thedotmack/claude-mem/blob/f85bb28c4788ed6372e3406b3fc92cfbecf6df08/src/services/context/formatters/AgentFormatter.ts#L70-L144)、[SummaryRenderer](https://github.com/thedotmack/claude-mem/blob/f85bb28c4788ed6372e3406b3fc92cfbecf6df08/src/services/context/sections/SummaryRenderer.ts#L1-L48)。

没有发现 SessionStart 输出的硬 token、字符或累计 Session 预算。代码按条目数查询并直接拼接输出；`tokens_injected` telemetry 是从 observation 完整字段长度估算的统计量，不是执行截断的 limiter。来源：[ContextBuilder](https://github.com/thedotmack/claude-mem/blob/f85bb28c4788ed6372e3406b3fc92cfbecf6df08/src/services/context/ContextBuilder.ts#L145-L215)、[TokenCalculator](https://github.com/thedotmack/claude-mem/blob/f85bb28c4788ed6372e3406b3fc92cfbecf6df08/src/services/context/TokenCalculator.ts#L1-L43)。

官方 progressive-disclosure 文档把“50 条 observation index ≈ 800 tokens”和“从约 1,000 tokens 的 index 开始”作为说明性示例，但没有对应的运行时硬上限。来源：[Progressive Disclosure](https://github.com/thedotmack/claude-mem/blob/f85bb28c4788ed6372e3406b3fc92cfbecf6df08/docs/public/progressive-disclosure.mdx#L45-L69)、[attention budget example](https://github.com/thedotmack/claude-mem/blob/f85bb28c4788ed6372e3406b3fc92cfbecf6df08/docs/public/progressive-disclosure.mdx#L155-L167)。

## UserPromptSubmit 默认行为

`CLAUDE_MEM_SEMANTIC_INJECT` 当前默认是 `false`，所以 UserPromptSubmit 默认只初始化/更新 Session，不把相关历史 Memory 注入每一轮。`CLAUDE_MEM_SEMANTIC_INJECT_LIMIT` 的默认值 `5` 只有显式开启 semantic injection 后才生效。来源：[SettingsDefaultsManager](https://github.com/thedotmack/claude-mem/blob/f85bb28c4788ed6372e3406b3fc92cfbecf6df08/src/shared/SettingsDefaultsManager.ts#L157-L161)、[session-init handler](https://github.com/thedotmack/claude-mem/blob/f85bb28c4788ed6372e3406b3fc92cfbecf6df08/src/cli/handlers/session-init.ts#L75-L93)。

开启后只处理至少 20 字符的非媒体 prompt，请求 top-N observation；Worker 路由把 limit 限制在 1–20。返回内容包含每个结果的 title、日期和完整 narrative。没有发现 per-item 或整包 token/字符截断，也没有在这条路由中发现独立的相似度最低阈值；搜索层主要依赖 top-N、project/platform 过滤与默认 90 天 recency window。来源：[session-init handler](https://github.com/thedotmack/claude-mem/blob/f85bb28c4788ed6372e3406b3fc92cfbecf6df08/src/cli/handlers/session-init.ts#L147-L176)、[semantic context route](https://github.com/thedotmack/claude-mem/blob/f85bb28c4788ed6372e3406b3fc92cfbecf6df08/src/services/worker/http/routes/SearchRoutes.ts#L374-L419)、[SearchManager](https://github.com/thedotmack/claude-mem/blob/f85bb28c4788ed6372e3406b3fc92cfbecf6df08/src/services/worker/SearchManager.ts#L365-L468)。

当前 Server runtime 直接跳过这条 semantic-injection protocol；它只在 legacy/local Worker 路径可用。来源：[session-init server branch](https://github.com/thedotmack/claude-mem/blob/f85bb28c4788ed6372e3406b3fc92cfbecf6df08/src/cli/handlers/session-init.ts#L84-L108)。

## PreToolUse file context

当前源码还包含文件级 supplementary context：文件小于 1,500 bytes 时跳过；每个文件先查询 40 条，按 Session 去重和 specificity 排序后显示最多 15 条；一次输入最多处理 10 个路径；单个 title 截到 160 字符。若文件 modification time 不早于最新 observation，也跳过注入。没有发现整个 file-context pack 的字符或 token 上限。来源：[file-context constants and formatter](https://github.com/thedotmack/claude-mem/blob/f85bb28c4788ed6372e3406b3fc92cfbecf6df08/src/cli/handlers/file-context.ts#L14-L19)、[file-context handler](https://github.com/thedotmack/claude-mem/blob/f85bb28c4788ed6372e3406b3fc92cfbecf6df08/src/cli/handlers/file-context.ts#L90-L190)、[file-context lookup](https://github.com/thedotmack/claude-mem/blob/f85bb28c4788ed6372e3406b3fc92cfbecf6df08/src/cli/handlers/file-context.ts#L196-L272)。

这一部分存在明显上游漂移：官方 File Read Gate 文档仍描述“阻止 Read，让 Agent 选择下一步”，但当前 handler 返回 `permissionDecision: allow`，文本也说原 Read 结果仍会提供；Claude Code manifest 又把该 PreToolUse command 标成 `async: true`，Codex manifest 则是同步的 30 秒 Hook。因此本报告只把源码常量作为当前实现事实，不把旧文档的“典型约 370 tokens”当作稳定默认契约。来源：[File Read Gate docs](https://github.com/thedotmack/claude-mem/blob/f85bb28c4788ed6372e3406b3fc92cfbecf6df08/docs/public/file-read-gate.mdx#L10-L66)、[Claude manifest](https://github.com/thedotmack/claude-mem/blob/f85bb28c4788ed6372e3406b3fc92cfbecf6df08/plugin/hooks/hooks.json#L62-L72)、[Codex manifest](https://github.com/thedotmack/claude-mem/blob/f85bb28c4788ed6372e3406b3fc92cfbecf6df08/plugin/hooks/codex-hooks.json#L29-L38)。

## Claude Code 与 Codex

两者的核心 SessionStart context 使用相同 generator 和默认条目设置。Codex adapter 优先经 MCP 取 `session_start_context`，并避免把同一 timeline 同时重复为 terminal `systemMessage`；Claude Code 直接走 Worker HTTP，并可显示彩色 terminal preview。它们还按 `platformSource` 过滤各自来源的观察。来源：[context handler](https://github.com/thedotmack/claude-mem/blob/f85bb28c4788ed6372e3406b3fc92cfbecf6df08/src/cli/handlers/context.ts#L20-L171)。

Hook manifest 的 SessionStart 和 UserPromptSubmit 上限都是 60 秒；内部普通 Hook API request 上限是 30 秒，health check 是 3 秒。这些是故障和启动等待 ceiling，不是“正常注入应花多少时间”的前台 SLO，更不是 token budget。来源：[hook constants](https://github.com/thedotmack/claude-mem/blob/f85bb28c4788ed6372e3406b3fc92cfbecf6df08/src/shared/hook-constants.ts#L1-L20)、[Claude hooks](https://github.com/thedotmack/claude-mem/blob/f85bb28c4788ed6372e3406b3fc92cfbecf6df08/plugin/hooks/hooks.json#L17-L47)、[Codex hooks](https://github.com/thedotmack/claude-mem/blob/f85bb28c4788ed6372e3406b3fc92cfbecf6df08/plugin/hooks/codex-hooks.json#L1-L28)。

## 官方文档漂移

当前 `configuration.mdx` 的 Context Settings 表仍写 Full Observations 默认 5、Include last summary 默认 false；同 commit 的运行时代码和 UI defaults 则明确是 0 与 true。本报告以实际加载设置的 `SettingsDefaultsManager` 和 `ContextConfigLoader` 为准。来源：[configuration docs](https://github.com/thedotmack/claude-mem/blob/f85bb28c4788ed6372e3406b3fc92cfbecf6df08/docs/public/configuration.mdx#L220-L274)、[runtime defaults](https://github.com/thedotmack/claude-mem/blob/f85bb28c4788ed6372e3406b3fc92cfbecf6df08/src/shared/SettingsDefaultsManager.ts#L139-L161)、[UI defaults](https://github.com/thedotmack/claude-mem/blob/f85bb28c4788ed6372e3406b3fc92cfbecf6df08/src/ui/viewer/constants/settings.ts#L1-L27)。

## 对 MemStore 预算讨论的含义

claude-mem 能支持的结论不是“照抄 50 条或 5 条”，而是：

1. SessionStart 适合注入紧凑索引或 Core Pack，而不是完整正文。
2. 每轮 semantic injection 默认关闭，说明高频注入需要更严格的相关性、延迟和容量保护。
3. Top-N 不能代替 token hard cap；完整 narrative 长度可变，必须另设 pack、item 和 Session 累计预算。
4. Hook timeout 不能当正常 latency 目标；MemStore 的 250 ms hard deadline 会比 claude-mem 的故障 ceiling 更严格。
5. MemStore 已明确要求每轮相关注入，因此可以不同于 claude-mem 的默认关闭策略，但应允许结果为空，并设置最低相关性、去重和累计预算。

本报告不直接冻结 MemStore 数值；数值仍需用户 review，并在 Shadow Mode 用真实分布校准。
