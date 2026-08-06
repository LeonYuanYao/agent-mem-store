# Coding Agent 长期记忆方案的 Hook 与模型处理实现调研

检索日期：2026-08-04<br>
状态：Research Note，不构成 ADR，也不授权实现<br>
研究问题：主流 Coding Agent 长期记忆方案是否会在 Hook 中直接运行小模型；如果不会，它们如何隔离捕获、提炼、存储和检索注入？

## 结论先行

有“Hook 触发后很快让小模型提炼”的成熟实现，而且技术上存在两种路线：主流高可见度方案把模型放在 Worker/云端任务中；代表性较弱但实现直接的 ClawMem，则在同步 `Stop` command Hook 路径中等待本地 GGUF observer 完成。后者证明“Hook 内跑小模型”可行，但也明确付出了最高 30 秒同步预算、模型冷启动和本地资源占用的代价。

最接近该需求的实现是 `claude-mem`：Claude Code 的 `PostToolUse` 和 `Stop` Hook 被声明为异步，Codex 因宿主不支持异步 command hook 而同步等待 Hook 命令退出；两端的 Hook 都只把事件提交给常驻服务并等到 `queued`，实际观察提取和会话总结由独立 Worker 使用默认 Haiku 档模型完成。换言之，它实现的是“Hook 触发小模型后台总结”，不是“在 Hook 内同步跑小模型”。[`claude-mem` Claude Code hooks](https://github.com/thedotmack/claude-mem/blob/f85bb28c4788ed6372e3406b3fc92cfbecf6df08/plugin/hooks/hooks.json#L17-L85) [`claude-mem` Codex hooks](https://github.com/thedotmack/claude-mem/blob/f85bb28c4788ed6372e3406b3fc92cfbecf6df08/plugin/hooks/codex-hooks.json#L1-L68) [`claude-mem` Worker routes](https://github.com/thedotmack/claude-mem/blob/f85bb28c4788ed6372e3406b3fc92cfbecf6df08/src/services/worker/http/routes/SessionRoutes.ts#L262-L383)

Mem0 当前官方 Coding Agent 插件采用更彻底的异步链路：Hook 启动后台 Python 后立即退出；Python 把会话片段提交到 Mem0 Cloud V3 `add`，云 API 返回 `PENDING + event_id`，模型在云端异步任务中运行。Mem0 OSS 的 `Memory.add(infer=True)` 则不同：它会在调用者进程中同步调用 LLM；历史 OpenMemory MCP 服务也直接走这条同步路径。后两者如果被直接塞进同步 Hook，确实会把模型延迟带进前台，但它们本身并不是这种 Hook 集成。[Mem0 `on_stop.sh`](https://github.com/mem0ai/mem0/blob/6e6f5b8d59e9d59c2223ce7d0f0d28caa8218b31/integrations/mem0-plugin/scripts/on_stop.sh#L44-L55) [Mem0 V3 Add API](https://docs.mem0.ai/api-reference/memory/add-memories) [Mem0 OSS `Memory.add`](https://github.com/mem0ai/mem0/blob/6e6f5b8d59e9d59c2223ce7d0f0d28caa8218b31/mem0/memory/main.py#L736-L940)

ClawMem 当前 `decision-extractor` 会从 transcript 读消息，直接 `await extractObservations(...)`；后者调用默认 llama.cpp/GGUF backend 并等待结构化观察结果。它与 `handoff-generator`、无模型的 `feedback-loop` 一起作为同步 `Stop` command Hook 安装，当前各自 timeout 为 30 秒，没有 `async: true`。[ClawMem Hook 配置](https://github.com/yoloshii/ClawMem/blob/b166a50c9a93ef89240b9a4802bc771a6a608708/docs/guides/setup-hooks.md#L1-L75) [Decision extractor](https://github.com/yoloshii/ClawMem/blob/b166a50c9a93ef89240b9a4802bc771a6a608708/src/hooks/decision-extractor.ts#L1080-L1130) [Observer LLM call](https://github.com/yoloshii/ClawMem/blob/b166a50c9a93ef89240b9a4802bc771a6a608708/src/observer.ts#L395-L430)

本次样本共同支持 MemStore 当前方向：生命周期 Hook 只做有界、可恢复的捕获或本地检索；Luna 在独立 Worker 中提炼；SessionStart/UserPromptSubmit 只读取已经生成的 Durable Memory，不在注入路径临时调用 Luna。

## 调研边界与判定标准

公开仓库无法证明真实活跃安装数或每日 Session 数，GitHub star 也不是使用量或质量证明。因此本报告不做“市场份额排名”，而是选择六个同时满足“公开可见度较高”或“对 Coding Agent 生命周期接入有直接实现价值”的方案：`claude-mem`、Mem0/OpenMemory、Basic Memory、Hindsight、ByteRover（原 Cipher）和 ClawMem。ClawMem 不属于高用量样本，只作为“同步 Hook 内跑本地小模型”的实现反例。所有实现结论均追到官方仓库源码或官方 API 文档；README 只用于发现入口，不单独作为实现证据。

源码快照：

| 方案 | 检查的官方源码快照 |
| --- | --- |
| claude-mem | [`f85bb28c4788ed6372e3406b3fc92cfbecf6df08`](https://github.com/thedotmack/claude-mem/tree/f85bb28c4788ed6372e3406b3fc92cfbecf6df08) |
| Mem0 Coding Agent plugin / Mem0 OSS | [`6e6f5b8d59e9d59c2223ce7d0f0d28caa8218b31`](https://github.com/mem0ai/mem0/tree/6e6f5b8d59e9d59c2223ce7d0f0d28caa8218b31) |
| 历史 OpenMemory | [`v0.1.106` 对应 `4dec9ace88d8290cdf8147853244b3c9eb6408da`](https://github.com/mem0ai/mem0/tree/4dec9ace88d8290cdf8147853244b3c9eb6408da/openmemory)；当前 main 已不含该目录 |
| Basic Memory | [`d1d6f273ba4d9fba2b4cd0fecb0516e755c951b2`](https://github.com/basicmachines-co/basic-memory/tree/d1d6f273ba4d9fba2b4cd0fecb0516e755c951b2) |
| Hindsight | [`5c15f28afe6c11ee945f35f31922cd25d2b930da`](https://github.com/vectorize-io/hindsight/tree/5c15f28afe6c11ee945f35f31922cd25d2b930da) |
| ByteRover | [`1052ac1a5dd0fde4da8693d4712064f7876c269c`](https://github.com/campfirein/byterover-cli/tree/1052ac1a5dd0fde4da8693d4712064f7876c269c) |
| ClawMem | [`b166a50c9a93ef89240b9a4802bc771a6a608708`](https://github.com/yoloshii/ClawMem/tree/b166a50c9a93ef89240b9a4802bc771a6a608708)（v0.30.0） |

本报告使用以下四种不同的执行关系，避免把“同步 Hook”和“同步模型”混为一谈：

- **Hook 内同步 LLM**：Hook 进程或其子进程发起 LLM 请求，并在退出前等待模型结果。
- **同步等入队**：宿主等待 Hook 退出，Hook 等待本地 HTTP/IPC 的接受确认，但不等待模型。
- **宿主异步 Hook**：宿主不等待 Hook 完成；Hook 自身仍可能运行一段时间。
- **宿主原生模型 Hook**：宿主直接替 Hook 调用一个模型；Claude Code 的 prompt/agent Hook 属于此类，但输出契约是允许/阻断决策，不是通用知识提炼结果。
- **宿主 Agent 提炼**：Hook 只注入指令，真正的整理由当前 Codex/Claude 模型在正常 Agent Turn 中完成；没有额外的“记忆模型进程”。

## 横向对照

| 方案 | 生命周期触发面 | Hook 是否等待 LLM | 提炼模型的位置 | 捕获方式 | 检索与注入 |
| --- | --- | --- | --- | --- | --- |
| claude-mem | SessionStart、UserPromptSubmit、Post/PreToolUse、Stop | 否。Claude 的观察/总结 Hook 为宿主异步；Codex 同步等入队确认 | 本地常驻 Worker 或 Server BullMQ Worker；默认轻量档为 Haiku，可换 provider | Hook HTTP 提交事件，Worker 队列返回 `queued` | SessionStart timeline；可选每轮 semantic injection；MCP/搜索深挖 |
| Mem0 plugin | SessionStart、UserPromptSubmit、Stop、PreCompact | 否。shell 后台启动 Python；云 API 只返回异步 event | Mem0 Cloud 后台；平台实际模型未公开 | 后台 Python POST V3 `add(infer=true)` | UserPromptSubmit top-5 搜索后注入；SessionStart 注入 timeline/使用提示 |
| Basic Memory | SessionStart、PreCompact | 否；Hook 内无 LLM | Claude 侧可做无模型抽取式 checkpoint；Codex 由恢复后的宿主 Agent 写 checkpoint | 本地 lifecycle envelope WAL；显式技能写 Markdown/graph note | SessionStart 并行查询任务、决策和近期 checkpoint 后注入；按需 MCP/Skill |
| Hindsight | 官方核心提供 API/MCP，不替 Coding Agent 注册生命周期 Hook | API 同时提供同步和异步 retain；MCP `retain` 默认异步 | 独立 `hindsight-worker` 执行事实抽取、embedding、关系构建 | `async=true` 写 `async_operations`，Worker poll/claim | MCP/API recall；由集成方决定何时注入 |
| ClawMem | UserPromptSubmit、SessionStart、PreCompact、Stop | **是**。同步 Stop Hook 直接等待本地 GGUF observer，当前上限 30 秒 | `llama-server`，不可达时可在 Hook 进程内回退到 `node-llama-cpp` | Hook 读 transcript 后直接提取并写本地 SQLite/Markdown | UserPromptSubmit 本地混合检索；SessionStart/compact 注入；MCP 深挖 |
| ByteRover | 当前 Hook connector 仅为 Claude Code UserPromptSubmit；其他 Agent 主要走 Skill/MCP | Hook 内无 LLM | 由当前 Coding Agent 模型决定是否 query/curate；ByteRover 工具本身不调用 provider | Hook 注入工作流，Agent 调 deterministic `brv-curate` | Agent 调 deterministic BM25 `brv-query`；结果回到当前 Turn |

## 宿主自身是否支持“模型 Hook”

Claude Code 当前原生支持 `type: "prompt"` 和实验性的 `type: "agent"` Hook。Prompt Hook 会把 Hook 输入和自定义 prompt 发给 Claude，默认使用 Haiku；但结果契约是 `{ "ok": true/false, "reason": "..." }`，用于允许或阻断动作，而且 prompt/agent Hook 不能设为异步。通用 command Hook 才支持 `async: true`。[Claude Code prompt Hook](https://code.claude.com/docs/en/hooks#prompt-based-hooks) [Claude Code async Hook](https://code.claude.com/docs/en/hooks#run-hooks-in-the-background)

本机当前 Codex CLI 0.146.0 的官方手册边界不同：只有 `type: "command"` 会真正执行；prompt/agent handler 虽可解析但会跳过；`async` 字段也会解析，但 asynchronous command Hook 尚不支持。因此 Codex Hook 可以通过任意命令间接调用 Luna/API/CLI，却会同步等待该命令退出。这个差异是 MemStore 必须使用宿主 Adapter、而不能依赖某一家原生模型 Hook 的直接原因。[Codex Hooks 官方指南](https://learn.chatgpt.com/docs/hooks)

Codex 的 `SessionEnd` 约束尤其严格：默认 timeout 为 1 秒，允许配置的最大值只有 3 秒；其他多数 command Hook 的默认值为 600 秒。因而 `SessionEnd` 只能作为“原子落盘、flush 或唤醒 Worker”的最后兜底，不能等待 Luna。逐轮捕获更适合放在 `Stop`，会话结束时再检查是否还有未提交的事件。[Codex Hooks 官方指南](https://learn.chatgpt.com/docs/hooks)

## 1. claude-mem

### Hook 事件与同步边界

Claude Code 插件注册 SessionStart、UserPromptSubmit、PostToolUse、PreToolUse 和 Stop。其中 PostToolUse observation 与 Stop summarize 标记为 `async: true`，各自宿主超时上限为 120 秒；SessionStart 和 UserPromptSubmit 是同步 Hook，配置上限为 60 秒。Codex 使用独立 manifest：SessionStart 60 秒、UserPromptSubmit 60 秒、PreToolUse 30 秒、PostToolUse 120 秒、Stop 60 秒，但没有 `async: true`，所以 Codex 会等 Hook 命令退出。[Claude Code manifest](https://github.com/thedotmack/claude-mem/blob/f85bb28c4788ed6372e3406b3fc92cfbecf6df08/plugin/hooks/hooks.json#L17-L85) [Codex manifest](https://github.com/thedotmack/claude-mem/blob/f85bb28c4788ed6372e3406b3fc92cfbecf6df08/plugin/hooks/codex-hooks.json#L1-L68)

“Codex 同步等待”并不等于“Codex 等模型”。PostToolUse handler 只把 tool event POST 到 `/api/sessions/observations`；Stop handler走 `/api/sessions/summarize`。Worker 路由完成校验、隐私检查、队列写入和 generator 确保启动后即回 `status: queued`；模型结果稍后产生。[PostToolUse handler](https://github.com/thedotmack/claude-mem/blob/f85bb28c4788ed6372e3406b3fc92cfbecf6df08/src/cli/handlers/observation.ts#L14-L103) [Worker enqueue routes](https://github.com/thedotmack/claude-mem/blob/f85bb28c4788ed6372e3406b3fc92cfbecf6df08/src/services/worker/http/routes/SessionRoutes.ts#L308-L383)

### 模型运行位置

官方架构把 Worker 定义为长期运行的 HTTP 服务，明确说明观察处理通过 Claude Agent SDK 在 Hook 之外执行，以避免 Hook timeout；默认模型为 `claude-haiku-4-5-20251001`，也可配置 Gemini 或 OpenRouter 等 provider。[Worker architecture](https://github.com/thedotmack/claude-mem/blob/f85bb28c4788ed6372e3406b3fc92cfbecf6df08/docs/public/architecture/worker-service.mdx#L6-L19) [Claude provider execution](https://github.com/thedotmack/claude-mem/blob/f85bb28c4788ed6372e3406b3fc92cfbecf6df08/src/services/worker/ClaudeProvider.ts#L175-L267) [Model defaults](https://github.com/thedotmack/claude-mem/blob/f85bb28c4788ed6372e3406b3fc92cfbecf6df08/src/shared/SettingsDefaultsManager.ts#L118-L166)

其 Server 模式更进一步：Hook 记录 event 后形成 generation job，BullMQ Worker 重新读取权威 event/outbox、调用 provider、解析并持久化结果；模型不在 HTTP Hook handler 中。[Server generation worker](https://github.com/thedotmack/claude-mem/blob/f85bb28c4788ed6372e3406b3fc92cfbecf6df08/src/server/generation/ProviderObservationGenerator.ts#L38-L71) [Provider call and persistence](https://github.com/thedotmack/claude-mem/blob/f85bb28c4788ed6372e3406b3fc92cfbecf6df08/src/server/generation/ProviderObservationGenerator.ts#L210-L278)

### 延迟、超时与失败隔离

内部超时常量把健康检查限制为 3 秒、普通 Hook API 请求限制为 30 秒、已在启动中的 Worker readiness 等待限制为 10 秒、spawn 后等待限制为 15 秒。Transport timeout、连接拒绝、429 和 5xx 被视为可降级问题；Hook 总体倾向退出成功并跳过本次捕获，避免阻断主会话。[Hook timeout constants](https://github.com/thedotmack/claude-mem/blob/f85bb28c4788ed6372e3406b3fc92cfbecf6df08/src/shared/hook-constants.ts#L1-L20) [Hook error isolation](https://github.com/thedotmack/claude-mem/blob/f85bb28c4788ed6372e3406b3fc92cfbecf6df08/src/cli/hook-command.ts#L124-L171)

该方案证明“同步 command hook 也可以不承担模型时延”，但它仍允许一次 Hook 等待本地服务到 30 秒，manifest 上限甚至达到 60–120 秒；这些是故障上限，不应被 MemStore 当作正常延迟目标。

### Capture 与 Retrieval

Capture 以 tool event 和 Stop summary 信号进入队列；SessionStart 从既有 observations 生成项目 timeline 并以 `additionalContext` 注入。UserPromptSubmit 可额外进行 top-N semantic injection，但当前配置默认关闭；开启后它同步等待本地/服务端检索，不等待观察提炼模型。[Context injection handler](https://github.com/thedotmack/claude-mem/blob/f85bb28c4788ed6372e3406b3fc92cfbecf6df08/src/cli/handlers/context.ts#L56-L171) [Per-prompt semantic injection](https://github.com/thedotmack/claude-mem/blob/f85bb28c4788ed6372e3406b3fc92cfbecf6df08/src/cli/handlers/session-init.ts#L111-L177)

可复用点：用轻量模型后台处理每轮事件是可行的；但 Capture 入队和 Retrieval 注入必须是两个独立路径，后者不能等前者本轮生成完成。

## 2. Mem0 Coding Agent plugin、Mem0 OSS 与 OpenMemory

### 当前 Coding Agent plugin

官方插件为 Claude/Codex 注册 SessionStart、UserPromptSubmit、Stop、PreCompact。Stop Hook 的 shell 不直接请求模型，而是以后台进程运行 `capture_session_summary.py` 后退出；Python 从 transcript 中抽取末尾 assistant message 和文件信息，POST 到 `/v3/memories/add/`，参数为 `infer: true`，网络 timeout 为 15 秒。[Claude hooks](https://github.com/mem0ai/mem0/blob/6e6f5b8d59e9d59c2223ce7d0f0d28caa8218b31/integrations/mem0-plugin/hooks/hooks.json#L16-L124) [Codex hooks](https://github.com/mem0ai/mem0/blob/6e6f5b8d59e9d59c2223ce7d0f0d28caa8218b31/integrations/mem0-plugin/hooks/codex-hooks.json#L35-L102) [`on_stop.sh`](https://github.com/mem0ai/mem0/blob/6e6f5b8d59e9d59c2223ce7d0f0d28caa8218b31/integrations/mem0-plugin/scripts/on_stop.sh#L44-L55) [`capture_session_summary.py`](https://github.com/mem0ai/mem0/blob/6e6f5b8d59e9d59c2223ce7d0f0d28caa8218b31/integrations/mem0-plugin/scripts/capture_session_summary.py#L141-L203)

它不只在 Stop 捕获：UserPromptSubmit 会对 substantial prompt 计数，每第三条在后台执行一次 `auto_capture.py`，发送最近四轮对话，并同样使用 `infer: true` 与 15 秒客户端 timeout。[UserPrompt trigger](https://github.com/mem0ai/mem0/blob/6e6f5b8d59e9d59c2223ce7d0f0d28caa8218b31/integrations/mem0-plugin/scripts/on_user_prompt.sh#L198-L206) [`auto_capture.py`](https://github.com/mem0ai/mem0/blob/6e6f5b8d59e9d59c2223ce7d0f0d28caa8218b31/integrations/mem0-plugin/scripts/auto_capture.py#L110-L151)

Mem0 V3 Add API 本身返回 `PENDING` 和 `event_id`，实际 inference 位于 Mem0 Cloud 异步任务中。插件没有公开云端实际使用的模型，因此不能把 Mem0 OSS 默认模型推断为平台模型。[Official V3 Add API](https://docs.mem0.ai/api-reference/memory/add-memories)

失败隔离很强，但可靠性相对弱：shell 后台进程和 Python 都倾向不影响主会话；不过插件侧没有本地 durable queue，也不轮询 `event_id` 完成状态。HTTP 接受前的进程退出或网络失败没有持久重试依据；成功进入云队列后才由服务端负责后续处理。这一点适合“无感”，不适合直接复制成 MemStore 的可靠性边界。

消费路径位于 UserPromptSubmit：对至少 20 个字符的 prompt 同步搜索 top-5，底层 search timeout 为 5 秒，失败则返回空；结果作为额外上下文注入。SessionStart 只提供状态、timeline 和检索提示，不加载完整库。[Prompt prefetch and injection](https://github.com/mem0ai/mem0/blob/6e6f5b8d59e9d59c2223ce7d0f0d28caa8218b31/integrations/mem0-plugin/scripts/on_user_prompt.sh#L156-L228) [Search helper](https://github.com/mem0ai/mem0/blob/6e6f5b8d59e9d59c2223ce7d0f0d28caa8218b31/integrations/mem0-plugin/scripts/_search.py#L13-L87) [SessionStart](https://github.com/mem0ai/mem0/blob/6e6f5b8d59e9d59c2223ce7d0f0d28caa8218b31/integrations/mem0-plugin/scripts/on_session_start.sh#L124-L197)

### Mem0 OSS：同步 inference，不是 lifecycle hook

`Memory.add(infer=True)` 在调用者进程内进入 `_add_to_vector_store`，直接执行 `self.llm.generate_response()`，之后才解析新增、更新、删除动作并写入存储；异常向上传播。当前 OpenAI provider 默认模型是 `gpt-5-mini`，但可配置。[Synchronous OSS add path](https://github.com/mem0ai/mem0/blob/6e6f5b8d59e9d59c2223ce7d0f0d28caa8218b31/mem0/memory/main.py#L736-L940) [OSS OpenAI default](https://github.com/mem0ai/mem0/blob/6e6f5b8d59e9d59c2223ce7d0f0d28caa8218b31/mem0/llms/openai.py#L39-L40)

所以，Mem0 OSS 是一个“确实能在调用路径同步跑小模型”的库；但正确结论是调用方必须自己把它移到 Worker，而不是把 `Memory.add` 直接放进 Codex Stop Hook。

### 历史 OpenMemory：MCP 请求同步等 LLM

OpenMemory 已不在当前 Mem0 main tree；本报告只能检查其官方历史版本 `v0.1.106`。该版本没有 Coding Agent lifecycle hook。FastMCP 的 `add_memories` 虽然声明为 `async def`，函数体却直接调用同步 `memory_client.add(...)`；因此 MCP tool 请求会等待 Mem0 OSS 的 inference 完成。错误会被捕获并返回文本，但该路径没有自己的显式 model timeout。[Historical OpenMemory MCP add](https://github.com/mem0ai/mem0/blob/4dec9ace88d8290cdf8147853244b3c9eb6408da/openmemory/api/app/mcp_server.py#L61-L142) [Historical default config](https://github.com/mem0ai/mem0/blob/4dec9ace88d8290cdf8147853244b3c9eb6408da/openmemory/api/default_config.json#L1-L18)

OpenMemory 是一个有用的反例：Python 函数写成 `async` 不代表内部工作已经异步化；必须继续追踪它是否把 LLM dispatch 到独立队列。

## 3. Basic Memory

### Hook 事件与处理内容

Codex 插件注册 SessionStart（startup/resume/compact，30 秒）与 PreCompact（manual/auto，60 秒）。两个 launcher 都捕获所有错误并始终退出 0。[Hook manifest](https://github.com/basicmachines-co/basic-memory/blob/d1d6f273ba4d9fba2b4cd0fecb0516e755c951b2/plugins/codex/hooks/hooks.json#L1-L30) [SessionStart fail-open launcher](https://github.com/basicmachines-co/basic-memory/blob/d1d6f273ba4d9fba2b4cd0fecb0516e755c951b2/plugins/codex/hooks/session_start.py#L8-L37) [PreCompact fail-open launcher](https://github.com/basicmachines-co/basic-memory/blob/d1d6f273ba4d9fba2b4cd0fecb0516e755c951b2/plugins/codex/hooks/pre_compact.py#L8-L37)

Hook 命令会先把有界 lifecycle envelope 写入本地 inbox WAL。SessionStart 并行查询 active tasks、open decisions、recent checkpoints 和有限个 shared projects；单次查询内部 timeout 为 10 秒，失败按“无数据”处理，最终 context 限制为 10,000 字符。[Local envelope capture](https://github.com/basicmachines-co/basic-memory/blob/d1d6f273ba4d9fba2b4cd0fecb0516e755c951b2/src/basic_memory/cli/commands/hook.py#L406-L450) [Bounded parallel queries](https://github.com/basicmachines-co/basic-memory/blob/d1d6f273ba4d9fba2b4cd0fecb0516e755c951b2/src/basic_memory/cli/commands/hook.py#L453-L528) [Brief limits](https://github.com/basicmachines-co/basic-memory/blob/d1d6f273ba4d9fba2b4cd0fecb0516e755c951b2/src/basic_memory/cli/commands/hook.py#L70-L76)

### 是否在 Hook 内使用模型

不使用。源码中的自动 checkpoint 是“extractive cut”，明确注明 `no LLM call`：从 transcript 取 opening request 和最近几轮，补 Git/PR 元数据后写 note。[Extractive checkpoint](https://github.com/basicmachines-co/basic-memory/blob/d1d6f273ba4d9fba2b4cd0fecb0516e755c951b2/src/basic_memory/cli/commands/hook.py#L893-L905)

Codex 路径更特殊：PreCompact stdout 不会被宿主消费，所以该 Hook 只记录 compaction envelope 并返回；压缩完成后的 SessionStart 注入一条提示，要求恢复后的当前 Codex Agent 使用 `bm-checkpoint` Skill，从已经压缩的工作上下文撰写高质量 checkpoint。模型工作发生在正常 Agent Turn，而不是 Hook 或独立小模型中。[Codex post-compact handoff](https://github.com/basicmachines-co/basic-memory/blob/d1d6f273ba4d9fba2b4cd0fecb0516e755c951b2/src/basic_memory/cli/commands/hook.py#L1029-L1077) [`bm-checkpoint` workflow](https://github.com/basicmachines-co/basic-memory/blob/d1d6f273ba4d9fba2b4cd0fecb0516e755c951b2/plugins/codex/skills/bm-checkpoint/SKILL.md#L53-L81)

Basic Memory 证明了两条替代路线：低成本 checkpoint 可以完全不用模型；需要更高质量时，也可以让宿主 Agent 在压缩后显式撰写。但后者会占用正常 Agent Turn，不完全符合 MemStore 的“后台无感”目标。

### Retrieval

SessionStart 只注入任务、决策与近期 checkpoint 的短 brief；详细内容由 `bm-orient`、搜索和 MCP tools 按需读取。Lifecycle envelope 只是本地 operational trace，flush 后不会自动晋升为 graph note。[Codex plugin behavior](https://github.com/basicmachines-co/basic-memory/blob/d1d6f273ba4d9fba2b4cd0fecb0516e755c951b2/plugins/codex/README.md#L166-L225) [`bm-orient` recall boundary](https://github.com/basicmachines-co/basic-memory/blob/d1d6f273ba4d9fba2b4cd0fecb0516e755c951b2/plugins/codex/skills/bm-orient/SKILL.md#L58-L80)

可复用点：Hook 先写本地 WAL；注入只返回有界索引/摘要；历史数据明确标为 reference data 而非 instructions；失败不影响 Session。

## 4. Hindsight

### 触发面与同步/异步 retain

Hindsight 的官方核心触发面是 API/MCP，而不是替 Codex 或 Claude 注册生命周期 Hook。主 retain endpoint 支持 `async=false`（默认，等待全部处理完成）和 `async=true`（写入队列后立即返回 operation id）。源码甚至明确拒绝在启用 batch API 时使用同步模式，因为任务可能持续数分钟到数小时并导致请求超时。[Retain endpoint contract](https://github.com/vectorize-io/hindsight/blob/5c15f28afe6c11ee945f35f31922cd25d2b930da/hindsight-api-slim/hindsight_api/api/http.py#L7568-L7589) [Async vs sync implementation](https://github.com/vectorize-io/hindsight/blob/5c15f28afe6c11ee945f35f31922cd25d2b930da/hindsight-api-slim/hindsight_api/api/http.py#L7631-L7709)

MCP 的普通 `retain` tool 默认调用 `submit_async_retain` 并返回 `accepted + operation_id`；另有显式 `sync_retain` tool 等待 `retain_batch_async` 完成。[MCP async retain](https://github.com/vectorize-io/hindsight/blob/5c15f28afe6c11ee945f35f31922cd25d2b930da/hindsight-api-slim/hindsight_api/mcp_tools.py#L601-L713) [MCP sync retain](https://github.com/vectorize-io/hindsight/blob/5c15f28afe6c11ee945f35f31922cd25d2b930da/hindsight-api-slim/hindsight_api/mcp_tools.py#L716-L825)

### Worker、LLM 与失败隔离

异步 operation 存入 `async_operations`，Broker backend 只保存 payload，独立 `hindsight-worker` 的 poller 使用数据库 claim 执行任务。Worker 初始化自己的 `MemoryEngine`，实际事实提取调用 LLM，随后生成 embedding 并写事实及关系。[Task backend boundary](https://github.com/vectorize-io/hindsight/blob/5c15f28afe6c11ee945f35f31922cd25d2b930da/hindsight-api-slim/hindsight_api/engine/task_backend.py#L126-L161) [Worker process wiring](https://github.com/vectorize-io/hindsight/blob/5c15f28afe6c11ee945f35f31922cd25d2b930da/hindsight-api-slim/hindsight_api/worker/main.py#L232-L275) [LLM extraction in retain pipeline](https://github.com/vectorize-io/hindsight/blob/5c15f28afe6c11ee945f35f31922cd25d2b930da/hindsight-api-slim/hindsight_api/engine/retain/orchestrator.py#L579-L618)

它还提供两个值得复用的可靠性机制：客户端可提供 `operation_id`，重复提交相同 ID 不会重复入队；Worker 对完整 retain task 设置默认 1 小时 wall-clock backstop，防止单个 LLM/锁/队列问题永久占住 slot。这一小时是 wedge 防护，不是正常 latency 目标。[Idempotent operation id](https://github.com/vectorize-io/hindsight/blob/5c15f28afe6c11ee945f35f31922cd25d2b930da/hindsight-api-slim/hindsight_api/api/http.py#L724-L741) [Worker task timeout](https://github.com/vectorize-io/hindsight/blob/5c15f28afe6c11ee945f35f31922cd25d2b930da/hindsight-api-slim/hindsight_api/worker/poller.py#L41-L66) [Default retain wall timeout](https://github.com/vectorize-io/hindsight/blob/5c15f28afe6c11ee945f35f31922cd25d2b930da/hindsight-api-slim/hindsight_api/config.py#L1218-L1226)

Hindsight 并不能直接证明某个 Codex Hook 的时延，但它给出了一套适合 Hook adapter 调用的后台 API 形状：durable operation、idempotency、可查询状态、独立 Worker、同步模式与异步模式明确分开。

## 5. ClawMem：同步 Hook 内运行本地小模型的明确正例

ClawMem 不属于本报告的高用量样本，但它回答了“有没有人这样做”这个事实问题。v0.30.0 为 Claude Code 安装三个并行的同步 `Stop` command Hook：`decision-extractor`、`handoff-generator`、`feedback-loop`，当前各自 timeout 为 30 秒，配置中没有 `async: true`。[Hook setup](https://github.com/yoloshii/ClawMem/blob/b166a50c9a93ef89240b9a4802bc771a6a608708/docs/guides/setup-hooks.md#L1-L75)

`decision-extractor` 在 Hook 命令退出前读取 transcript、`await extractObservations(messages)`、持久化 observations，并可继续做因果关系推断。`extractObservations` 直接通过默认 llama.cpp backend 发起结构化生成；首选外部 `llama-server`，传输失败时默认可回退到 Hook 进程内的 `node-llama-cpp` GGUF inference。`handoff-generator` 同样等待 observer 生成交接摘要，模型不可用时才降级为正则抽取。[Decision extractor](https://github.com/yoloshii/ClawMem/blob/b166a50c9a93ef89240b9a4802bc771a6a608708/src/hooks/decision-extractor.ts#L1080-L1130) [Observer extraction](https://github.com/yoloshii/ClawMem/blob/b166a50c9a93ef89240b9a4802bc771a6a608708/src/observer.ts#L395-L430) [Local inference fallback](https://github.com/yoloshii/ClawMem/blob/b166a50c9a93ef89240b9a4802bc771a6a608708/src/llm.ts#L1120-L1240)

这条路线的优势是完全本地、结果在 Hook 返回时已经落库，且无需另建云端任务队列；代价则是前台 Stop 时延直接受 GPU/CPU、模型冷启动、SQLite 写锁和模型响应影响。ClawMem 自身通过 30 秒上限、远端失败冷却、正则 fallback、去重和 fail-open 来收敛风险，但这些机制只能限制最坏情况，不能让模型时延从用户路径中消失。

因此它是“可行性正例”，不是 MemStore 的默认架构推荐。特别是 Luna 并非本地常驻 GGUF 模型，把 ClawMem 的同步方式照搬到 Codex 只会把网络/排队/推理延迟直接加到每轮结束。

## 6. ByteRover（原 Cipher）

### Hook 做什么

当前 Hook connector 只为 Claude Code 写入一个 UserPromptSubmit command：`brv hook-prompt-submit`。该命令只加载 `brv-instructions` 模板并输出到 stdout，模板加载失败会静默返回；源码未在 connector 中设置显式 Hook timeout。[Hook connector config](https://github.com/campfirein/byterover-cli/blob/1052ac1a5dd0fde4da8693d4712064f7876c269c/src/server/infra/connectors/hook/hook-connector-config.ts#L1-L72) [Hook command](https://github.com/campfirein/byterover-cli/blob/1052ac1a5dd0fde4da8693d4712064f7876c269c/src/oclif/commands/hook-prompt-submit.ts#L8-L51)

注入内容要求 Coding Agent 在代码任务前执行 `brv query`、在产生价值知识后执行 `brv curate`。也就是说，Hook 只改变当前宿主 Agent 的工作流；它既不读取 transcript，也不自己提炼记忆。[Injected workflow](https://github.com/campfirein/byterover-cli/blob/1052ac1a5dd0fde4da8693d4712064f7876c269c/src/server/templates/sections/brv-instructions.md#L1-L78)

### 模型与工具边界

当前 MCP `brv-query` 路由到 BM25/cache 检索，明确不调用 LLM；`brv-curate` 要求调用它的 Coding Agent 自己生成 `<bv-topic>` HTML，ByteRover 只做确定性校验和写入，也不需要 provider。[Deterministic query](https://github.com/campfirein/byterover-cli/blob/1052ac1a5dd0fde4da8693d4712064f7876c269c/src/server/infra/mcp/tools/brv-query-tool.ts#L33-L59) [Deterministic curate](https://github.com/campfirein/byterover-cli/blob/1052ac1a5dd0fde4da8693d4712064f7876c269c/src/server/infra/mcp/tools/brv-curate-tool.ts#L35-L40) [Curate daemon path](https://github.com/campfirein/byterover-cli/blob/1052ac1a5dd0fde4da8693d4712064f7876c269c/src/server/infra/mcp/tools/brv-curate-tool.ts#L150-L167)

因此 ByteRover 不是“Hook 后台小模型总结”方案，而是“Hook 给宿主 Agent 注入记忆纪律，再让宿主模型在当前工作流中读写”。其优点是没有第二个模型和 provider 成本；缺点是 capture 依赖 Agent 是否遵循注入指令，而且 curate 可能占据当前 Turn。官方 Skill 为此建议把 substantive curate 交给后台 Agent，但那仍是宿主 Agent 任务，不是独立记忆 Worker。[Background curate guidance](https://github.com/campfirein/byterover-cli/blob/1052ac1a5dd0fde4da8693d4712064f7876c269c/src/server/templates/skill/SKILL.md#L36-L76)

## 对 MemStore 的可复用结论

### 1. 保留当前原则：Luna 不进入 Hook 同步路径

ClawMem 证明同步 Hook 内跑本地小模型确实可行，但它没有提供足够理由推翻当前 Spec：它依赖本地 GGUF、为 Stop 路径预留 30 秒，并接受冷启动与硬件资源风险。相比之下，`claude-mem` 即使使用默认 Haiku 做快速提炼，也把模型放在 Worker；Mem0 Cloud 同样先异步接受。历史 OpenMemory 和 Mem0 OSS 的同步 add 则进一步说明了把 LLM 调用留在前台路径的代价。

MemStore 的目标链路应是：

```text
Codex / Claude lifecycle hook
  -> 校验并标准化最小事件
  -> 原子追加本地 durable outbox / WAL
  -> 可选 best-effort 唤醒本地 Worker
  -> Hook 成功退出

Background Worker
  -> 合并同一 session/turn 的事件
  -> Luna 提炼 Memory Candidate
  -> 确定性安全、作用域、冲突和晋升规则
  -> 写入 Memory Vault / 更新本地索引
```

这里比 Mem0 plugin 多一个关键保证：只有 durable outbox 已落盘才算捕获成功。daemon 不可用时，Hook 仍能留下事件；Worker 恢复后继续消费。不能只把 HTTP POST 发给一个可能未启动的本地服务后就丢掉来源。

### 2. “快速总结”可以高优先级后台跑，不必同步跑

如果希望每轮结束几秒内生成记忆，可以为 Stop 事件建立高优先级队列，让 Luna Worker 立即消费；这与“Hook 不等模型”并不冲突。真正影响无感程度的是 Hook 等待时间，而不是模型任务何时开始。

Hook 内可做的压缩只应是确定性的：字段筛选、大小限制、内容指纹、来源 ID、最后 assistant message 或 transcript offset。不要在 Hook 内做模型摘要作为唯一权威输入；否则 timeout 会造成捕获缺口，而且模型失败后没有原始事件可重放。Basic Memory 的 extractive checkpoint 证明无模型 fallback 可行。

### 3. Capture 必须具备幂等、重试和可观测状态

建议从 Hindsight 借用 operation identity，从 claude-mem 借用队列/Worker 边界，但补足本地可靠性：

- 幂等键至少包含 Agent、Session、Turn、事件类型和内容 digest。
- 状态明确区分 `captured`、`processing`、`candidate_created`、`skipped`、`retry_wait`、`dead_letter`。
- Worker crash、Luna timeout、Vault 暂时不可写都可以重试；重复 Hook 不重复产生记忆。
- 设置整个任务 wall-clock backstop，同时给单次模型请求更短 timeout。
- 暴露 backlog、最老事件年龄、最近成功提炼、失败原因聚合；不把这些变成人工审批红点。

### 4. Retrieval Hook 只读已完成的 Durable Memory

消费侧应采用已经讨论的三层模型，并坚持“注入路径不调用 Luna”：

- SessionStart：本地读取很小的 Core Memory Pack；项目知识优先，全局知识补充。
- UserPromptSubmit：根据当前 prompt 查本地索引，返回受 token 数量约束的 Relevant Memory Pack；严格超时、失败即跳过。
- MCP/Skill：按需展开来源、关系、演化历史和更深搜索。

claude-mem、Mem0 和 Basic Memory 都没有在 SessionStart 把完整知识库塞入上下文；它们都注入 timeline、top-N 或短 brief。MemStore 应同样缓存/预计算检索表示，避免每次 Prompt 临时做生成式摘要。

### 5. 宿主差异要留在 Adapter，不污染核心治理模型

Claude Code 支持异步 Hook，而当前 Codex 不支持；`claude-mem` 的两个 manifest 已证明同一产品必须为两个宿主使用不同等待策略。MemStore 应让 Codex adapter 使用“同步写 WAL 后快速退出”，Claude adapter 可以选择宿主异步执行，但两者写入同一种 canonical event envelope。不能把 `async: true` 当成核心可靠性机制。

### 6. 本报告没有冻结的参数

以下仍应由后续 Spec interview 与人工 review 决定，而不是从竞品默认值直接抄入实现：

- Hook 正常 latency SLO、内部 timeout 与 payload 大小上限。
- 每轮都捕获、按事件采样，还是以 turn coalescing 为默认策略。
- Luna 的具体调用接口、模型可用性检查、重试与降级模型。
- Durable outbox 的文件格式、保留期与加密/敏感信息策略。
- Codex native Memories 与 MemStore 注入的去重/共存策略。
- SessionStart 与 UserPromptSubmit 的 token、条目数和相关性阈值。

## 最终回答

市面上确实存在“Hook 后快速调用小模型做总结”的做法，而且需要分清两类：`claude-mem` 用默认 Haiku 档模型在常驻 Worker 中后台提炼；ClawMem 则让同步 Stop Hook 直接等待本地 GGUF observer。后者证明“能做”，前者更能代表高可见度产品对无感体验的取舍。Mem0 当前插件采用云端异步边界；Hindsight 的异步 retain API 提供了更完整的 operation/worker 形状；Basic Memory 和 ByteRover 则证明，无模型抽取或复用宿主 Agent 也能工作。

因此，对 MemStore 的研究建议保持不变：**Hook 负责 durable capture 与快速注入，Luna 负责后台提炼；不要在 Codex 的同步 Hook 中直接等待 Luna。**
