# `probable` Memory 条目数基准

检索日期：2026-08-05（Asia/Singapore）<br>
状态：Research Note，不构成 ADR，也不授权实现<br>
问题：MemStore 每轮最多注入 2 条 `probable` 是否有直接行业依据。

## 结论

**没有发现“每轮最多 2 条低置信或 probable Memory”这一规则的直接行业标准、公开实验结论或主流产品默认值。**

公开实现通常只暴露以下三类限制：

1. **检索 Top-K**：常见值为 2、3、5 或 10，但它限制候选或返回结果数，不等于最终自动注入数。
2. **最终 context block 预算**：例如 Hindsight 的 1,024 tokens、Zep 的 2,500 characters；这类限制比固定条目数更接近 MemStore 的最终注入保护。
3. **按需工具检索或常驻 Core Memory**：例如 LangMem/LangGraph、Letta；由集成方或 Agent 决定是否放入 Prompt，没有统一的自动注入条目数。

LlamaIndex 的通用向量检索默认 `similarity_top_k=2`，是样本中唯一明显相同的数字。但它代表“取 2 个文档 chunk”，不区分 `high/probable/weak`，也没有证明 2 条低置信长期记忆能取得最佳质量。因此，它最多只能说明“2 是一个被主流 RAG 采用过的紧凑检索起点”，不能成为 `probable=2` 的直接依据。[LlamaIndex basic strategies](https://docs.llamaindex.ai/en/v0.10.17/optimizing/basic_strategies/basic_strategies.html) [LlamaIndex AgentSearchRetrieverPack](https://docs.llamaindex.ai/en/stable/api_reference/packs/agent_search_retriever/)

## 一手证据对照

| 产品或框架 | 检索候选或 Top-K | 最终注入条目数 | 最终预算 | 对 `probable=2` 的含义 |
| --- | --- | --- | --- | --- |
| Mem0 Coding Agent plugin | 普通 Prompt Top-5；短于 20 characters 跳过 | 最多 5 条搜索结果 | 每条截到 200 characters；未发现整包 token cap | 支持“小规模自动召回”，但不支持 2 这个数 |
| claude-mem 13.13.1 | 每轮语义注入默认关闭；开启后默认 Top-5 | 开启后最多 5 条 | 未发现整包 token cap | 更支持“可能相关时保守或为空”，不提供 2 条基准 |
| Hindsight Codex | 内部多路检索并融合；Coding Agent 默认不以条目数为主要限制 | 未公开固定条目上限 | auto-recall 默认 1,024 tokens | 支持以 pack token budget 为主，而不是按 2 条切断 |
| Zep auto search | 跨 facts、entities、episodes、observations、summaries 排序；普通 scope 默认 limit 10 | 由字符预算装入若干结果 | auto context 默认 2,500 characters | 支持“排序后按预算装包”，不支持固定 2 条 |
| Graphiti | 搜索配置默认 Top-10 | 集成方决定 | 未提供通用注入 pack cap | Top-K 是检索 API 默认，不是自动注入质量证据 |
| LangMem / LangGraph | memory manager `query_limit=5`；官方 Agent 示例常用 limit 1、2 或 3；search tool 默认 limit 10 | 集成方拼接或由 Agent 调工具 | 未提供统一自动注入 token cap | 官方示例数字随任务变化，说明应配置和评测，而非认定 2 为标准 |
| Letta | Archival Memory 由 Agent 工具搜索；Core blocks 常驻上下文 | 没有统一自动检索条目数 | 建议单条 archival memory 不超过 300 tokens；Core block 建议小于 50k characters | 架构不同，不能提供 probable 条目数依据 |
| LlamaIndex | 常规 query engine 默认 `similarity_top_k=2` | 通常把 2 个 chunk 交给后续合成 | 取决于 chunk size 和上下文组装 | 只能作为紧凑 RAG 起点，不能外推为低置信 Memory 上限 |

主要来源：

- Mem0：Prompt prefetch 使用 `top_k=5`；搜索 formatter 对单条 Memory 截断 200 characters。[Prompt hook](https://github.com/mem0ai/mem0/blob/45208feebb9599a5e4a445f2cdf4611dae2ac248/integrations/mem0-plugin/scripts/on_user_prompt.sh#L156-L174) [search formatter](https://github.com/mem0ai/mem0/blob/45208feebb9599a5e4a445f2cdf4611dae2ac248/integrations/mem0-plugin/scripts/_search.py#L48-L103)
- claude-mem：`CLAUDE_MEM_SEMANTIC_INJECT=false`，开启后的 limit 默认 5；默认路径不是每轮注入 5 条。[runtime defaults](https://github.com/thedotmack/claude-mem/blob/f85bb28c4788ed6372e3406b3fc92cfbecf6df08/src/shared/SettingsDefaultsManager.ts#L157-L161) [semantic injection handler](https://github.com/thedotmack/claude-mem/blob/f85bb28c4788ed6372e3406b3fc92cfbecf6df08/src/cli/handlers/session-init.ts#L147-L176)
- Hindsight：Codex auto-recall 默认开启，`recallMaxTokens=1024`；文档把它定义为 recalled memory block 的最大 token 数。[Hindsight Codex integration](https://hindsight.vectorize.io/sdks/integrations/codex)
- Zep：auto search 对跨 scope 结果全局排序，再装入默认 2,500-character context block；普通 `limit` 默认 10。[Zep graph search](https://help.getzep.com/searching-the-graph)
- Graphiti：开源搜索配置默认 Top-10，但框架不决定何时或如何把结果注入 Agent。[Graphiti search config](https://github.com/getzep/graphiti/blob/aab852df94413fd0d55cbea2b7886173020281d5/graphiti_core/search/search_config.py#L23-L29)
- LangMem：`create_memory_store_manager` 的 `query_limit` 默认 5，描述为每次 conversation 检索的相关 Memory 上限；memory search tool 的默认 limit 为 10。[LangMem memory manager](https://langchain-ai.github.io/langmem/reference/memory/) [LangMem search tool](https://langchain-ai.github.io/langmem/reference/tools/)
- LangGraph：官方长期记忆示例在不同场景分别使用 limit 1、2 或 3，并由应用代码把结果拼进 system message；这些是示例配置，不是统一默认。[LangGraph memory guide](https://docs.langchain.com/oss/python/langgraph/add-memory) [LangGraph persistence guide](https://docs.langchain.com/oss/python/langgraph/persistence)
- Letta：Memory Blocks 始终在上下文；Archival Memory 不在上下文、由工具检索，官方建议每条 archival memory 不超过 300 tokens。[Letta context hierarchy](https://docs.letta.com/guides/core-concepts/memory/context-hierarchy) [Letta memory blocks](https://docs.letta.com/guides/core-concepts/memory/memory-blocks)

## 边界

- **检索 Top-K 不等于最终注入条目数。** 系统可能先取更多候选，再经过阈值、rerank、去重、多样性和 token packing 只注入一部分。
- **默认值不等于质量证明。** 上述公开默认值通常是工程起点；没有找到它们针对 MemStore 的 `probable` 语义做过独立消融实验。
- **条目长度差异很大。** 两条 96-token compact snippet 与两个 800-token RAG chunk 不是同一种上下文成本。
- **产品架构不可直接互换。** claude-mem 默认关闭每轮语义注入，Hindsight 用 token cap，Letta 依赖常驻 blocks 和工具调用；不能把任一数字机械复制到 MemStore。
- 本笔记复用并补充核验了仓库已有的 [自动注入预算横评](./memory-injection-budget-landscape.md) 和 [claude-mem 注入策略研究](./claude-mem-default-injection-strategy-and-budgets.md)。

## 对 MemStore 的建议

`probable ≤ 2` 可以作为**首版保守工程启发式**，但不应表述为“行业最佳实践”或“有公开 benchmark 证明”。它的合理性来自 MemStore 自身约束的组合，而不是某个竞品数字：

- `high` 必须优先，`probable` 只能补充不同知识维度；
- 每条 compact snippet 最多 96 tokens，总计最多 192 tokens；
- 现有 Relevant Memory Pack 最多 6 条、目标 300–600 tokens、hard cap 1,024 tokens；
- 无需凑满，0 或 1 条是正常结果；
- 同一结论去重，并允许 Agent 按 Memory ID 显式深读。

建议把首版规则写成：

> `max_probable_items = 2` 是可配置、待 Shadow Mode 校准的初始上限，不是行业标准。最终选择同时受 192-token probable 总预算约束；条目数和 token 数先到者为准。

Shadow Mode 至少比较 `0 / 1 / 2 / 3` 四档，并分别统计：

- probable 后续被 Agent 显式深读的比例；
- 被用户或 Agent 报告为 irrelevant 的比例；
- probable 是否挤掉 high；
- 任务成功率或必要知识召回率的增量；
- 实际 rendered tokens 和重复率。

如果缺少上线前数据，也可以先用 `2`，因为它比 Mem0/claude-mem/LangMem 常见的 Top-5 更保守，又不至于把单一 probable 误判变成唯一参考；但应在文档中明确这是**可审计的初始选择**，不是外部证据推出的常数。
