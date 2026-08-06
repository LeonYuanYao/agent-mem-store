# 长期记忆产品的验证与治理机制横向调研

检索日期：2026-08-05（Asia/Singapore）<br>
状态：Research Note，不构成 ADR，也不授权实现<br>
范围：只核验官方文档、官方仓库和项目论文；“未发现”表示在本次核验的公开一手材料中没有找到产品级承诺，不表示无法由使用方自行扩展。

## 结论

主流长期记忆库普遍采用 LLM 从对话或事件中提取知识，并由同一个模型或另一轮模型调用决定新增、更新、合并或删除。少数产品进一步提供来源追踪、时间有效性、历史版本、安全预处理或定时重算。

本次核验未发现某个产品完整实现以下闭环：

1. 本地确定性程序验证来源、仓库 revision、文件、测试或运行结果；
2. LLM 只判断证据在语义上是否支持知识陈述；
3. 独立的确定性门禁决定候选能否进入正常召回；
4. Human-authored 内容拥有不可被模型静默覆盖的更高权威；
5. 缺少证据时生成只读 Verification Request，而不是静默运行任意项目命令。

Graphiti 和 Hindsight 与这套方向最接近，但仍不等价：Graphiti 侧重 episode provenance、双时间模型和矛盾后的事实失效；Hindsight 侧重来源事实、带 evidence 的 observation、mental model 刷新以及写入前 Memory Defense。两者主要在已摄取的记忆内部进行重组或失效，不负责独立证明源输入本身真实，也没有 MemStore 设计中的候选晋升门禁。

## 横向对照

| 产品 | LLM 自动提取/整理 | 来源或历史 | 矛盾与时效 | 确定性安全/结构校验 | 候选晋升门禁 | 独立外部证据验证 |
| --- | --- | --- | --- | --- | --- | --- |
| Mem0 | 有 | 有操作历史和输入/实体 scope | LLM 决定 ADD/UPDATE/DELETE/NONE；支持 expiration | 有输入、schema、ID 和输出格式校验 | 未发现；提取结果直接写入可检索 store | 未发现 |
| Zep / Graphiti | 有 | 强：每条事实可回溯 episode | 强：validity window、旧事实失效且保留历史 | 有结构化输出、ontology 和数据库约束；不是事实真伪验证 | 未发现独立 candidate → active 门禁 | 未发现；episode 被视为摄取来源，而非被外部核验的 claim |
| Hindsight | 有 | world/experience/observation；observation 有 evidence tracking | observation consolidation、mental model staleness/refresh | 有 Memory Defense，可在写入前检测 Secret、prompt injection 和 tampering | 未发现与正常 recall 隔离的通用候选晋升层 | 未发现；refresh 是基于 bank 中最新记忆重新综合 |
| LangMem | 有 | 处理 conversation + existing memories，来源粒度由集成方决定 | LLM 可 insert/update/delete/consolidate | Pydantic schema 和结构化输出 | 未发现；store manager 自动持久化提取结果 | 未发现 |
| Letta | Agent 通过 memory tools 自主管理 | conversation 与 memory block 可检查 | Agent 或外部程序覆盖更新；共享 block 最后写入获胜 | block limit、read-only 和 API 校验 | 未发现 | 未发现 |
| claude-mem | 有，基于工具 observation 和 session summary | observation ID、session/tool 来源可回查 | 生成/压缩 observation 与 summary | Hook 层支持 `<private>` 排除；公开设计未提供事实验证门禁 | 未发现；生成的 observation 可进入后续检索 | 未发现 |
| Basic Memory | 主要由人或 Agent 显式写 Markdown | 强：原始 Markdown、Git/文件历史可由用户管理 | 通过编辑文件和关系维护 | Markdown 格式、索引和文件约束 | 不适用；它更接近可检查的知识库而非自动候选治理引擎 | 未内置；由人或调用它的 Agent负责 |

## 逐项证据与边界

### Mem0

Mem0 OSS 的 `Memory.add(..., infer=True)` 明确使用 LLM 提取关键事实，并决定对相关记忆执行新增、更新或删除；`infer=False` 则直接保存输入。当前实现还维护 history database、输入格式和 entity scope 校验，并将既有 UUID 映射成短整数，降低模型输出错误 ID 的风险。[Memory implementation](https://github.com/mem0ai/mem0/blob/main/mem0/memory/main.py)

其官方 prompt 要求模型输出 `ADD`、`UPDATE`、`DELETE` 或 `NONE`；更新判断来自模型对“新提取事实 + 已有记忆”的比较。V3 additive prompt 也强调 evidence-bound extraction 和 attribution，但这是模型指令，不是对文件、测试或外部来源的独立验证器。[Prompts](https://github.com/mem0ai/mem0/blob/main/mem0/configs/prompts.py) [Add Memories API](https://docs.mem0.ai/api-reference/memory/add-memories)

因此 Mem0 具有结构校验、历史和 LLM 更新机制，但公开默认路径并没有先隔离为不可召回 Candidate、再经过独立证据门禁晋升的阶段。

### Zep / Graphiti

Graphiti 把 episode 作为派生事实的 provenance；事实 edge 带有效时间范围，信息变化时旧事实失效而不是删除，可查询当前或历史状态。[Graphiti repository and architecture](https://github.com/getzep/graphiti)

这比普通向量记忆更接近 MemStore 的来源和 supersession 设计。但“自动 fact invalidation”解决的是新旧摄取内容的时间与矛盾关系，不证明 episode 中的断言真实，也不核验代码 revision、测试运行或权威外部来源。公开架构中也未发现独立的 candidate recall 隔离和确定性 promotion gate。

### Hindsight

Hindsight Retain 使用 AI 提取 world facts、experiences、entities、temporal data 和 relationships；后台把新事实综合成带 evidence tracking 的 observations。Recall 可以返回 observation 的 source facts，并允许 observation 替代其已综合的 raw facts以减少重复。[Retain](https://docs.hindsight.vectorize.io/retain/) [Recall API](https://docs.hindsight.vectorize.io/api-reference/recall-memories/)

Mental model 支持在新 memory、cron 或手动触发时刷新，并公开 staleness 状态；无变化时定时刷新可以跳过。这里的“刷新”是用 bank 中当前记忆重新运行 reflect，而不是重新访问事实发生的系统。[Mental model update](https://docs.hindsight.vectorize.io/api-reference/update-mental-model/) [What's New](https://docs.hindsight.vectorize.io/whats-new/)

Hindsight 的 Memory Defense 是本次调研中最接近 MemStore 本地预处理层的产品机制：retain 写入前可以检测 credential、prompt injection、tampering 和异常大小，选择 redact 或 block。但它是安全与完整性防御，不是业务事实验证。[Memory Defense announcement](https://docs.hindsight.vectorize.io/whats-new/)

### LangMem

LangMem 的 memory manager 接收 conversation 和 existing memories，调用 LLM 生成结构化 memory，并可启用 inserts、updates 和 deletes；store manager 会自动写入配置的 BaseStore。Pydantic schema 约束输出结构，但内容选择和新旧冲突处理仍由 LLM prompt完成。[Memory API](https://langchain-ai.github.io/langmem/reference/memory/) [Semantic memory guide](https://langchain-ai.github.io/langmem/guides/extract_semantic_memories/) [Core concepts](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)

官方背景处理模式支持延迟和 debounce，证明“前台捕获、后台模型整理”是成熟常见做法；公开默认实现未提供独立的事实证据验证或 Candidate promotion gate。[Background quickstart](https://langchain-ai.github.io/langmem/background_quickstart/)

### Letta

Letta memory block 是始终在上下文中的持久块，由 Agent 使用 memory tools 自主更新；可以设置 read-only，外部程序也能直接覆盖内容。官方明确提醒并发修改时采用 last-write-wins，集成方需要自己避免覆盖。[Memory blocks](https://docs.letta.com/guides/core-concepts/memory/memory-blocks)

read-only block 能保护人类或组织策略不被 Agent 修改，是一种写权限边界，但不是按来源权威、证据强度和候选状态自动晋升的治理系统。

### claude-mem

claude-mem 通过生命周期 Hook 捕获工具 observation，使用 AI 压缩并生成 session summary；observation 有 ID，可以从本地 API 或 viewer 回查。其 Hook 层支持 `<private>` 标签在内容到达 worker/database 前排除数据。[Repository](https://github.com/thedotmack/claude-mem) [Architecture notes](https://github.com/thedotmack/claude-mem/blob/main/CLAUDE.md)

其公开 observer 设计强调跳过 routine operation、记录 learned/built/fixed/decision 等高价值事件，但选择和总结主要由模型完成。未发现读取代码或测试结果进行独立核验、或把 observation 先隔离为 Candidate 再晋升的默认机制。

### Basic Memory

Basic Memory 把知识保存为普通 Markdown，并通过 observation/relation 语法形成可检索知识图谱；文件可以用文本编辑器、Git、Obsidian 和普通备份工具管理。[Knowledge format](https://docs.basicmemory.com/concepts/knowledge-format) [Observations and relations](https://docs.basicmemory.com/concepts/observations-and-relations)

它最接近 MemStore 的可读、可编辑和可迁移数据层，但本身不是 Coding Agent 会话的自动提炼与验证系统。知识正确性主要由写入它的人或 Agent负责。

## 对 MemStore 的启示

1. **保留行业已有的简单路径。** 普通用户偏好、明确人工指令和有强确定性证据的项目事实，不需要为追求形式完整而重复调用 Luna验证。
2. **采用分层而不是全量重验证。** Hindsight 的写入前安全防御、Graphiti 的 provenance/temporal invalidation、LangMem 的后台 debounce 都可以复用为设计思想。
3. **不要把 LLM 更新判断称为事实验证。** Mem0/LangMem 的 update/delete、Graphiti 的 invalidation、Hindsight 的 refresh 都是在新旧输入之间做语义整理；它们不能替代 repo/test/source integrity 检查。
4. **MemStore 的严格门禁只用于高影响或不确定内容。** Global 候选、冲突、跨 Batch 归并、Human-authored Review Suggestion 和证据不完整的高价值单一来源值得使用 Luna semantic verification；普通明确知识不应承担同等成本。
5. **Coding Agent 场景具有额外优势。** 文件、Git SHA、配置、测试 exit code 和工具 evidence 可以被本地确定性程序验证，这是通用聊天记忆产品通常没有利用的证据面。
6. **主动验证必须有权限边界。** 后台读取现有文件和已捕获证据可以自动进行；重新运行测试、构建、部署或访问高风险外部系统应生成 Verification Request，而不是静默执行。

总体判断：MemStore 的完整验证闭环比主流默认实现更严格，但各组成部分都有成熟产品先例。合理方向不是让每条记忆都走重型验证，而是用通用的 LLM 提取路径覆盖大多数内容，再对高影响、冲突或证据不足的知识启用确定性证据检查和晋升门禁。
