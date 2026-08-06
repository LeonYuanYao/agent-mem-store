# 长期记忆自动注入预算横向调研

检索日期：2026-08-04（Asia/Singapore）
状态：Research Note，不构成 ADR，也不授权实现
问题：长期记忆产品在 SessionStart、每轮 Prompt 和显式深度检索中如何限制自动注入规模；MemStore 应采用什么默认预算。

## 结论

公开实现没有形成统一的 token 预算标准。当前方案主要分为四类：

1. SessionStart 注入紧凑索引，详情按需读取，例如 claude-mem。
2. 每轮自动召回，并设置单次 token 或字符硬上限，例如 Hindsight 和 Zep。
3. 每轮自动召回只限制 Top-K 和单条字符数，不设置整包 token 上限，例如 Mem0 Coding Agent plugin。
4. 把较大的 Memory index 或 Core Memory 始终放进上下文，依赖整个模型 Context Window 和 compaction，而不是 Memory 专用预算，例如 Claude Code auto memory 和 Letta。

与 Coding Agent 最接近且公开了 token 硬上限的当前基准是 Hindsight：Codex 和 Claude Code 集成都默认每轮 auto-recall，单次最多 1,024 tokens。Zep 的自动图检索默认返回最多 2,500 characters；Mem0 的每轮 Top-5 每条最多 200 characters；claude-mem 则默认关闭每轮语义注入。

因此，MemStore 不应采用“每轮固定注入 900 tokens”，也不应只靠 Top-N。建议保留已经接受的 1,200-token SessionStart 上限，把每轮自动注入常态压到 0–400 tokens、硬上限设为 768 tokens，并增加竞品普遍缺少的 4,096-token context-epoch 累计上限。

> 人工评审结果（2026-08-04）：以上是竞品横向研究得出的初始折中，并非最终产品默认值。在结合用户的 Codex Pro 20x 工作负载和当前 token-based credit 模型后，已接受的质量优先设计采用每轮 300–600-token 目标、1,024-token 单轮硬上限、8,192-token context-epoch 软目标和 12,288-token 自动注入硬上限。参见 [ADR-0024](../adr/0024-adopt-quality-first-memory-injection-budgets.md)。

## 横向对照

| 产品或集成 | 自动注入时机 | 当前默认预算 | 预算性质 | Session 累计预算 |
| --- | --- | --- | --- | --- |
| claude-mem 13.13.1 | SessionStart；每轮语义注入默认关闭 | SessionStart 最多 50 条紧凑 observation index、10 条 summary、0 条正文；官方示例约 800–1,000 tokens | 条目上限和说明性 token 估算，没有整包硬 token cap | 未发现 |
| Mem0 Coding Agent plugin | SessionStart 和每个至少 20 字符的 Prompt | SessionStart 最多 10 条、每条 120 characters；每轮 Top-5、threshold 0.3、每条 200 characters | 条目数 + 单条字符截断；没有整包 token cap | 未发现 |
| Hindsight Coding Agent SDK | 默认每轮 auto-recall | 1,024 tokens；默认只用最新一个 Turn 构建查询，查询最多 800 characters | 单次 recall token 硬上限 | 未发现 |
| Zep Graph auto search | 集成方通常在当前对话调用 | 默认 2,500 characters，允许 1–50,000 | 单次 context block 字符硬上限 | 未发现 |
| Graphiti | 集成方决定 | 默认 Top-10 | 条目上限，没有 token 或字符 pack cap | 不提供 |
| Basic Memory Codex plugin | SessionStart brief；详情按需 | 最终 context 最多 10,000 characters | SessionStart 字符硬上限 | 不适用 |
| Claude Code auto memory | 每个 SessionStart | `MEMORY.md` 前 200 行或 25 KB，先到者为准；topic files 按需读取 | 行数/字节上限，不是 token cap | 不适用 |
| Letta 0.16.7 | Core Memory 始终在上下文，archival memory 按需 | 当前已取消 block limit 强制执行；self-hosted 全局 context 默认 128k | 依赖整体 Context Window 和 compaction | 未提供 Memory 专用累计 cap |
| Cursor Memories | 作为自动生成的 rules 进入模型上下文 | 官方没有公开数字化的 memory token/字符预算 | 未公开 | 未公开 |

字符数不能稳定换算为 token 数。英文常用的 `characters / 4` 只能作为粗略估算；中文、代码、路径、UUID 和 Markdown 的 token 密度可能显著更高。因此 MemStore 可以参考 Zep 和 Mem0 的规模，但执行限制应使用实际 tokenizer，不能用字符数替代 token hard cap。

## 主要证据

### claude-mem

当前运行时默认值为 50 个 observation、10 个 session summary、0 个完整 observation；每轮 semantic injection 默认关闭。官方 progressive-disclosure 文档用约 800–1,000 tokens 描述 50 条紧凑索引，但源码没有执行这个 token 上限。[运行时默认值](https://github.com/thedotmack/claude-mem/blob/f85bb28c4788ed6372e3406b3fc92cfbecf6df08/src/shared/SettingsDefaultsManager.ts#L116-L161) [Progressive Disclosure](https://github.com/thedotmack/claude-mem/blob/f85bb28c4788ed6372e3406b3fc92cfbecf6df08/docs/public/progressive-disclosure.mdx#L45-L69)

这说明 SessionStart 使用约 1,000 tokens 的紧凑索引是经过实际产品采用的量级，但不能从中推出每轮也适合注入同样多的内容。

### Mem0 Coding Agent plugin

核验快照为 [`45208feebb9599a5e4a445f2cdf4611dae2ac248`](https://github.com/mem0ai/mem0/tree/45208feebb9599a5e4a445f2cdf4611dae2ac248)。SessionStart timeline 最多读取 10 条最近 Memory，每条正文截到 120 characters。[SessionStart constants and formatting](https://github.com/mem0ai/mem0/blob/45208feebb9599a5e4a445f2cdf4611dae2ac248/integrations/mem0-plugin/scripts/session_timeline.py#L24-L27) [timeline truncation](https://github.com/mem0ai/mem0/blob/45208feebb9599a5e4a445f2cdf4611dae2ac248/integrations/mem0-plugin/scripts/session_timeline.py#L61-L80)

UserPromptSubmit 对少于 20 characters 的 Prompt 直接跳过；普通 Prompt 默认进行 Top-5 prefetch。搜索 helper 默认 threshold 为 0.3，每个返回 Memory 截到 200 characters 后注入，没有整包 token 截断。[Prompt eligibility and Top-5](https://github.com/mem0ai/mem0/blob/45208feebb9599a5e4a445f2cdf4611dae2ac248/integrations/mem0-plugin/scripts/on_user_prompt.sh#L21-L27) [prefetch](https://github.com/mem0ai/mem0/blob/45208feebb9599a5e4a445f2cdf4611dae2ac248/integrations/mem0-plugin/scripts/on_user_prompt.sh#L156-L174) [search and formatting](https://github.com/mem0ai/mem0/blob/45208feebb9599a5e4a445f2cdf4611dae2ac248/integrations/mem0-plugin/scripts/_search.py#L48-L103)

Mem0 证明“每轮快速相关注入”可以成为默认能力，但它通过短 Prompt 跳过、阈值、Top-5 和单条截断把常见结果压得较短。它没有解决多轮累计上下文增长。

### Hindsight

核验快照为 [`cac55fedad9d0161e9e0e6f482c476ecc6a0a0cb`](https://github.com/vectorize-io/hindsight/tree/cac55fedad9d0161e9e0e6f482c476ecc6a0a0cb)。Coding Agent SDK 的 `DEFAULT_RECALL_MAX_TOKENS` 是 1,024。[SDK constant](https://github.com/vectorize-io/hindsight/blob/cac55fedad9d0161e9e0e6f482c476ecc6a0a0cb/hindsight-tools/hindsight-agent-sdk/src/index.ts#L93-L100)

Codex 集成默认启用 auto-recall，单次 recalled memory block 最多 1,024 tokens，只取最新一个 Turn 组成查询，查询最多 800 characters。[Codex integration defaults](https://github.com/vectorize-io/hindsight/blob/cac55fedad9d0161e9e0e6f482c476ecc6a0a0cb/skills/hindsight-docs/references/sdks/integrations/codex.md#L117-L128) Claude Code 集成同样每个 Prompt 自动召回并使用 1,024-token 默认值。[Claude Code integration](https://github.com/vectorize-io/hindsight/blob/cac55fedad9d0161e9e0e6f482c476ecc6a0a0cb/skills/hindsight-docs/references/sdks/integrations/claude-code.md#L172-L185)

这是本次样本中与 MemStore 最接近的 token-based per-prompt hard cap，但 1,024 是上限，不代表每轮结果一定填满。

### Zep 与 Graphiti

Zep Python SDK 3.25.0 的 `graph.search(scope="auto")` 默认 `max_characters=2500`，合法范围为 1–50,000。服务端跨 facts、entities、episodes、observations 和 thread summaries 排序后，把结果装入这个字符预算。[Zep SDK](https://github.com/getzep/zep-python/blob/36ef7a1c35b8b6f4614d1095dae12b8328832a89/src/zep_cloud/graph/client.py#L880-L933) 官方使用说明也把 Context Block 定位为可以直接放进 Prompt 的相关上下文。[Zep context retrieval](https://help.getzep.com/retrieving-context) [Zep graph search](https://help.getzep.com/searching-the-graph)

开源 Graphiti 只为搜索提供默认 Top-10，没有自动注入时机或 token pack budget；上下文组装会串联所有已选结果。[Graphiti search default](https://github.com/getzep/graphiti/blob/aab852df94413fd0d55cbea2b7886173020281d5/graphiti_core/search/search_config.py#L23-L29) [context formatting](https://github.com/getzep/graphiti/blob/aab852df94413fd0d55cbea2b7886173020281d5/graphiti_core/search/search_helpers.py#L27-L72)

Zep 值得借鉴的是“相关性排序后按单次 pack budget 装包”；Graphiti 则说明 Top-N 本身不能提供稳定的 token 成本。

### Basic Memory、Claude Code auto memory、Letta 和 Cursor

Basic Memory 的 Codex SessionStart 会并行查询 active tasks、open decisions 和 recent checkpoints，最终 context 限制为 10,000 characters，详情通过 Skill/MCP 按需读取。[Basic Memory brief limits](https://github.com/basicmachines-co/basic-memory/blob/d1d6f273ba4d9fba2b4cd0fecb0516e755c951b2/src/basic_memory/cli/commands/hook.py#L70-L76) [bounded queries](https://github.com/basicmachines-co/basic-memory/blob/d1d6f273ba4d9fba2b4cd0fecb0516e755c951b2/src/basic_memory/cli/commands/hook.py#L453-L528)

Claude Code auto memory 在每个 SessionStart 加载 `MEMORY.md` 的前 200 行或 25 KB，topic files 不自动加载而是按需读取。这是较宽的启动索引上限，官方同时建议保持内容简洁。[Claude Code memory documentation](https://code.claude.com/docs/en/memory)

Letta 0.16.7 已移除 memory block limit 强制执行，并把 self-hosted 默认全局 Context Window 从 32k 提到 128k；如果依赖旧 block limit 控制每轮成本，需要改用其他手段。[Letta releases](https://github.com/letta-ai/letta/releases)

Cursor 官方说明 Memories 是自动生成、按项目保存的 rules，但没有公开每轮或每 Session 的数值预算，因此不能把它用于默认值校准。[Cursor Rules and Memories](https://docs.cursor.com/context/rules)

## MemStore 的折中方案

### 1. SessionStart

保留已接受的默认值：

- Core Memory Pack hard cap：1,200 tokens。
- `startup: always` hard cap：600 tokens。
- 全部结构、标签、引用和 warning 计入预算。
- 最终条目数通常为 8–12，但 Top-N 从属于 token hard cap。

理由：1,200 与 claude-mem 的约 800–1,000-token 索引和 Hindsight 的 1,024-token recall 处于同一量级，同时显著低于 Basic Memory 的 10,000-character brief 和 Claude Code 的 25-KB auto-memory index。为了追求数值整齐而改成 1,024 的收益不足以抵消刚完成的设计变更。

### 2. UserPromptSubmit 自动相关注入

建议默认值：

| 参数 | 建议默认值 |
| --- | ---: |
| 非相关、短确认、延续型 Prompt | 0 tokens |
| 普通非空包目标 | 200–400 tokens |
| 单轮 hard cap | 768 tokens |
| 单轮最大条目数 | 4 |
| 单条 Injection Snippet hard cap | 160 tokens |
| 相关度不足或全部已注入 | 空包 |

768 位于 Zep 默认 2,500-character pack 与 Hindsight 1,024-token hard cap 之间，同时比 Mem0 的 Top-5 × 200-character 结果留出足够的中英文、来源和 warning 空间。它是异常复杂查询的 ceiling，不是填充目标。

### 3. 累计自动注入

建议引入 4,096-token context-epoch hard cap，并把 SessionStart 的实际 token 数计入其中。一个 context epoch 从新的 SessionStart 开始，到宿主创建新的上下文 epoch 或完成 compaction 为止；如果宿主不能可靠识别新 epoch，则不得猜测重置。

预算示例：SessionStart 使用 1,200 tokens 后，还剩 2,896 tokens，可容纳约 7–12 个普通 200–400-token 非空包。多数短确认和连续执行轮次返回空，因此不会按总 Turn 数线性增长。

每条 Memory identity 和 revision 在同一 epoch 内只计算和注入一次；重复命中返回空或只使用已经存在的上下文。达到累计上限后，自动注入停止，但显式 MCP/Skill 深度检索仍可用。

竞品样本普遍没有 Session 累计预算。该限制不是“行业默认”，而是 MemStore 为长 Coding Session、输入成本和上下文稀释增加的额外保护。

### 4. 显式深度检索

显式检索由用户或 Agent 在确有需要时调用，建议默认返回最多 2,048 tokens，调用方可显式提高，但 hard cap 为 4,096 tokens。它不计入自动注入的单轮 768-token cap，但计入宿主正常上下文和用量；工具必须支持分页或按 Memory identity 继续读取，不能通过一次超大结果绕过预算。

### 5. 计数和配置

- 使用目标模型的实际 tokenizer 计算最终 rendered pack；没有 tokenizer 时使用保守高估并记录估算模式。
- 预算作用于最终注入文本，不只计算 Memory 正文。
- 所有数值可配置，但首版只提供一套 `balanced` 默认值，避免未经数据支持的 profile 组合。
- Shadow Mode 至少记录候选 token、实际 token、非空率、被预算截断率、重复抑制率、检索延迟和后续显式深挖率。
- Controlled Cutover 前必须根据真实分布人工 review；不能因为竞品使用某个数值就跳过本机验证。

## 建议结论

MemStore 的合理折中不是复制某一个产品，而是组合三种已经验证的约束：

- 采用 claude-mem 的紧凑 SessionStart 和渐进披露；
- 采用 Hindsight/Zep 的单次 recall pack hard cap；
- 采用 Mem0 的短 Prompt 跳过、相关度阈值、Top-K 和单条截断；
- 额外增加竞品普遍缺少的跨 Turn 累计预算。

本次竞品横向研究最初推荐：`SessionStart 1200 / always 600 / per-prompt target 200–400 / per-prompt hard 768 / max 4 items / context epoch total 4096 / explicit retrieval 2048 default and 4096 hard`。该初始折中已在后续 Pro 20x 用量研究和人工评审后由 [ADR-0024](../adr/0024-adopt-quality-first-memory-injection-budgets.md) 取代；当前接受值以 Spec 和 ADR-0024 为准。
