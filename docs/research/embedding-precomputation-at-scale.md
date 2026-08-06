# 大规模知识库的 Embedding 预计算与运行成本

检索日期：2026-08-05（Asia/Singapore）<br>
状态：Research Note，不构成 ADR，也不授权实现<br>
范围：只使用官方文档、官方代码仓库或模型作者发布的模型卡；时间与价格属于当前快照，实施前应再次核对。

## 结论

Embedding 预计算是适合 MemStore 的可靠路线，但需要准确理解它的边界：

1. **预计算的是知识条目的向量，不是每次定时任务都重算全库。**正常运行只处理内容哈希发生变化的新建、修改和删除条目；全量重建只发生在首次安装、切分规则变化、Embedding 模型变化或索引损坏时。
2. **每条新查询仍需要生成 query embedding。**如果自动 Hook 必须本地、离线且不调用远程模型，那么活动索引对应的 Embedding 模型也必须能在本机常驻并快速生成查询向量。只把文档向量预先存在本地、每轮查询再调用 OpenAI API，并不能满足离线和低故障面的要求。
3. **可靠性主要来自索引流水线，而不是模型本身。**应使用稳定的 chunk identity、内容哈希、幂等任务、断点续跑、逐条结果核对、旁路新索引和原子切换；任何未完成的新索引都不能污染当前活动索引。
4. **10k–100k 个短知识片段适合进入个人 Mac 的首轮 benchmark，但不能在不知道 Mac 型号、模型和片段长度时承诺耗时。**1M 个 embedding 单元的原始向量会占数 GiB，按不同吞吐假设首次本地构建可能需要数小时到数天，ANN 索引训练和维护会成为主要工程成本。这里的规模单位是“切分后的片段数”，不是 Markdown 文件数。
5. **远程 API 的直接费用很低，但不包含在 Codex Pro 20x 中。**按本文的 250 tokens/片段假设，1M 个片段使用当前 `text-embedding-3-small` 同步 API 约为 5 美元，Batch 约为 2.5 美元；API 需要单独付费，并会把待 Embedding 文本发送给远程服务。
6. **现在不应只凭公开榜单冻结模型。**本地轻量模型、本地较强多语言模型和 OpenAI API 应在 MemStore 自己的中文、英文、代码符号、否定条件、项目边界和 Bad Case 数据上评测。模型大小、维度和公开平均分不能替代目标检索质量。

因此，研究建议不是“全库每晚重新 embedding”，而是：

```text
Vault change scan
    -> canonical retrieval text
    -> content hash / dirty set
    -> background embedding batches
    -> completeness and quality validation
    -> shadow vector index
    -> atomic active-revision switch
```

活动检索始终读取一个完整、已校验的 revision；首次或全量重建期间继续使用旧向量索引和最新全文索引。

## 1. 实际要 Embedding 的对象

### 1.1 按 retrieval unit，而不是按文件

一个 Obsidian 文件可能是一条很短的 Memory，也可能包含多个相互独立的决策。Embedding 的计量单位应是稳定的 `retrieval unit`：

```text
embedding_key = hash(
  memory_id
  + memory_revision
  + chunk_id
  + canonical_retrieval_text
  + embedding_provider
  + embedding_model
  + dimensions
  + chunking_version
  + query_instruction_version
)
```

- 短的结构化 Memory 通常直接形成一个 unit。
- 超过模型或产品设定长度的正文按标题、段落和语义边界切分；不能只按固定字符数切断否定、条件和例外。
- frontmatter 中不影响语义的更新时间、格式化空格等不应触发重算。
- scope、authority、lifecycle、project、privacy 等门禁字段应进入结构化过滤索引；只有确实影响语义检索的字段才进入 Embedding 文本。
- Bad Case、Inbox、Trace 和 Repair Bundle 已被排除在正常记忆检索之外，因此不得进入这一 embedding 集合。

OpenAI 当前所有 Embedding 模型的单个 input 上限为 8,192 tokens；一个同步请求中的 inputs 合计上限为 300,000 tokens，input 数组最多 2,048 个元素。[OpenAI Embeddings API reference](https://developers.openai.com/api/reference/resources/embeddings/methods/create)

即使选择支持更长输入的本地模型，也不建议把整份长 Markdown 压成一个向量。长输入能力解决的是“可以输入”，不保证一个向量能同时精确代表其中多个不同决策。

### 1.2 预计算不消除 query embedding

向量检索需要文档和查询处于同一向量空间。因此：

- 文档向量：后台预计算，只在 dirty set 中更新。
- 查询向量：每次需要语义召回时在线计算一次。
- ANN 查询：使用 query vector 在本地活动索引中查候选。

对 MemStore 当前“自动 Hook 不联网、不调用 Luna”的边界，最自然的实现是让一个本地 Embedding runtime 常驻，避免每轮重新加载模型。Hook 只发送裁剪后的短查询，模型不可用或超过自动路径延迟上限时，确定性降级到精确匹配和 BM25，并显式记录 degraded 状态；不能阻塞主 Agent 等待远程服务。

OpenAI API 可以作为离线质量对照、显式深度检索的候选方案，或者未来在用户明确接受远程查询依赖后使用。它不能在保持上述离线 Hook 边界不变的同时，直接替换本地 query encoder。

## 2. 首次构建与日常增量如何运行

### 2.1 首次构建

首次构建建议分成可恢复的小批次：

1. 扫描 Vault，解析所有合格 Memory，生成稳定 retrieval units。
2. 写入 manifest，固定本次的模型、维度、切分版本和输入哈希。
3. 以 bounded batch 生成向量；每批落盘后记录成功、失败和未完成集合。
4. 对结果执行维度、数量、有限值、归一化约定、Memory revision 和 hash 一致性检查。
5. 建立旁路全文/向量索引，运行保护集和 Bad Case 回归。
6. 只有完整性与质量门禁通过后才把活动 manifest 指向新 revision。
7. 保留旧 revision 一段可配置时间，便于快速回滚；未完成的构建目录可继续或回收。

全量构建不需要暂停正常 Session。旧活动索引继续提供服务；新内容在等待向量期间仍可通过精确匹配和全文检索出现，但已修改条目的旧向量必须立即从候选资格中撤下，避免召回旧正文。

### 2.2 日常增量

每次文件变化或定时 catch-up 只做以下集合差：

```text
new_hashes      = current_hashes - indexed_hashes
changed_hashes  = same_identity with different content hash
deleted_ids     = indexed_ids - current_ids
```

- `new_hashes`：排队生成新向量。
- `changed_hashes`：先使旧 revision 的向量失效，再生成新向量。
- `deleted_ids`：写 tombstone；后续 compaction 再回收空间。
- 未变化项：直接复用已有向量，不产生模型开销。
- 断网、关机或任务错过：下次 scan 仍能由集合差发现，不依赖“恰好收到某个文件事件”。

如果每天只有 0.1% 的 1M-unit 库发生变化，则每天只需处理约 1,000 units；按 250 tokens/unit 即约 250k tokens，而不是重新处理 250M tokens。

### 2.3 模型升级

Embedding 模型、维度、切分或 instruction 变化会改变向量空间，不能把新旧向量混在一个 ANN 索引中。正确流程是：

```text
active revision A keeps serving
    + build complete revision B in background
    + evaluate A vs B on the same protected set
    + human review at the SDD gate
    + atomically switch to B
```

本地模型应固定精确模型文件/仓库 commit 和 tokenizer hash；远程 API 至少记录返回的 model ID、维度、输入 hash 和生成时间，并通过保护集监控行为漂移。不能把“相同模型别名”当成永久不变的质量保证。

## 3. 10k、100k、1M 规模估算

以下是便于量级判断的**规划假设**，不是对用户当前 Vault 的测量：

- 每个 embedding unit 平均 250 tokens。
- 每个 unit 生成一个 dense vector。
- 向量按 float32 保存，即每维 4 bytes。
- 本地吞吐使用 1k、5k、10k tokens/s 三个假设档位；它们不是某台 Mac 或某个模型的官方 benchmark。
- 不包含 tokenizer、数据库行、全文索引、ANN 图/分区、WAL、旧 revision 和临时构建副本。

### 3.1 总输入量

```text
total_tokens = unit_count * average_tokens_per_unit
```

| Embedding units | 按 250 tokens/unit 的总量 |
| ---: | ---: |
| 10,000 | 2.5M tokens |
| 100,000 | 25M tokens |
| 1,000,000 | 250M tokens |

### 3.2 本地首次计算时间

```text
local_build_seconds ~= total_tokens / measured_effective_tokens_per_second
```

| Units | 1k tokens/s | 5k tokens/s | 10k tokens/s |
| ---: | ---: | ---: | ---: |
| 10,000 | 41.7 分钟 | 8.3 分钟 | 4.2 分钟 |
| 100,000 | 6.9 小时 | 1.4 小时 | 41.7 分钟 |
| 1,000,000 | 69.4 小时 | 13.9 小时 | 6.9 小时 |

真实吞吐强烈依赖 Mac 型号、可用内存、模型大小、平均/最大序列长度、batch size、精度、runtime 和同时运行的前台负载。因此产品默认值不能从这张表选，应在目标机器上用 1k、10k、100k 真实 Memory 样本测量：

- cold start 与 warm query p50/p95/p99；
- effective tokens/s 和 units/s；
- 峰值 unified memory；
- CPU/GPU 使用率、温度与电池状态；
- 前台 Codex Session 是否出现资源竞争。

后台构建应限流、可暂停，并优先保证 query embedding 和 Agent 前台工作；不需要为了更快完成首建而持续占满机器。

### 3.3 原始向量磁盘

```text
raw_vector_bytes = unit_count * dimensions * bytes_per_component
```

| Units | 512-d float32 | 1024-d float32 | 1536-d float32 | 3072-d float32 |
| ---: | ---: | ---: | ---: | ---: |
| 10,000 | 19.5 MiB | 39.1 MiB | 58.6 MiB | 117.2 MiB |
| 100,000 | 195.3 MiB | 390.6 MiB | 585.9 MiB | 1.14 GiB |
| 1,000,000 | 1.91 GiB | 3.81 GiB | 5.72 GiB | 11.44 GiB |

这只是原始向量 payload。实际占用还包括 metadata、全文索引、ANN 结构、未压缩向量、旧 revision 和构建临时空间，必须用选定引擎实测。IVF-PQ 等量化索引可以用精度换取更小索引和更快查询；LanceDB 官方文档同时提醒，大型 IVF-FLAT/IVF-PQ 索引的训练较慢且可能消耗较多内存。[LanceDB vector index API](https://lancedb.github.io/lancedb/js/classes/Index/)

OpenAI 当前 `text-embedding-3-small` 默认 1,536 维，`text-embedding-3-large` 默认 3,072 维；v3 模型可用 `dimensions` 参数缩短向量。官方明确说明较大向量会增加计算、内存和存储成本，并建议通过目标任务评估维度折中。[OpenAI Embeddings guide](https://developers.openai.com/api/docs/guides/embeddings)

### 3.4 OpenAI API 当前费用

截至检索日，OpenAI 官方模型页列出的同步价格为：

- `text-embedding-3-small`：$0.02 / 1M input tokens。
- `text-embedding-3-large`：$0.13 / 1M input tokens。
- 旧 `text-embedding-ada-002`：$0.10 / 1M input tokens。

Batch API 对同步价格提供 50% 折扣，因此前两者的 Batch 推算价分别为 $0.01 和 $0.065 / 1M input tokens。[small model](https://developers.openai.com/api/docs/models/text-embedding-3-small) [large model](https://developers.openai.com/api/docs/models/text-embedding-3-large) [Batch guide](https://developers.openai.com/api/docs/guides/batch)

```text
api_cost_usd = total_tokens / 1_000_000 * price_per_million_tokens
```

| Units | small 同步 | small Batch | large 同步 | large Batch |
| ---: | ---: | ---: | ---: | ---: |
| 10,000 | $0.050 | $0.025 | $0.325 | $0.163 |
| 100,000 | $0.50 | $0.25 | $3.25 | $1.63 |
| 1,000,000 | $5.00 | $2.50 | $32.50 | $16.25 |

这些数字只覆盖 Embedding 输入费，不包含向量存储、网络、失败重试和本机索引构建。API 价格是易变事实，不能写死为长期产品假设。

Batch API 当前明确支持 `/v1/embeddings`，completion window 只有 `24h`，单个 Embedding Batch 最多 50,000 embedding inputs，输出顺序不保证与输入顺序一致，必须以稳定 `custom_id` 对应；批次失败或过期后要逐条核对已完成和未完成集合。[OpenAI Batch guide](https://developers.openai.com/api/docs/guides/batch)

因此上述三档至少分别需要 1、2、20 个 Batch（尚未考虑 JSONL 200 MB 和账户 batch queue token 限制）。Batch 适合首次大规模构建，不适合要求立刻可见的小增量；小增量可以同步请求或进入短周期小 Batch。

同步 API 的理论时间下界为：

```text
api_time_minutes >= total_tokens / effective_TPM
```

当前官方模型页对 Tier 1/2 展示 1M TPM；若仅作理想下界，2.5M、25M、250M tokens 分别至少约 2.5、25、250 分钟。真实账户 tier、请求大小、RPM、429、网络和重试都会使它更慢，实际限制必须读取 Platform Limits 和响应头，不能把公开表硬编码。[OpenAI small model rate limits](https://developers.openai.com/api/docs/models/text-embedding-3-small)

### 3.5 Codex Pro 20x 不抵扣 Embedding API

OpenAI 官方明确说明 ChatGPT 与 API 是分开管理和计费的产品。Codex Pro 20x 的 allowance 不包含 `/v1/embeddings` API 额度，也不会自动提高 API usage tier；使用 OpenAI Embedding API 需要独立 API key、billing 和费用告警。[OpenAI Help Center](https://help.openai.com/en/articles/8156019-is-api-usage-included-in-chatgpt-subscriptions-even-if-i-have-a-paid-chatgpt-account)

## 4. macOS 本地模型与 runtime 候选

这里列出可进入评测的候选，不等于已经决定第一版模型。

### 4.1 轻量中文基线：BGE small zh v1.5

`BAAI/bge-small-zh-v1.5` 是 BAAI 发布的中文 Embedding 模型，模型卡标注 24M parameters、512 维、MIT license，并提供 Transformers、Sentence-Transformers 和 FlagEmbedding 用法。它适合作为低资源、低查询延迟的本地基线，但其公开 benchmark 不能证明能处理 MemStore 的代码、路径、否定和跨项目边界。[BAAI model card](https://huggingface.co/BAAI/bge-small-zh-v1.5)

### 4.2 较强多语言候选：Qwen3 Embedding 0.6B 或 BGE-M3

`Qwen/Qwen3-Embedding-0.6B` 的官方模型卡标注 0.6B parameters、100+ languages、32K context、最高 1,024 维并支持 32–1,024 的自定义维度；当前模型文件约 1.21 GB。它覆盖中英文和代码评测的能力候选，但明显比 24M 的 BGE small 重，是否满足 Hook 延迟和本机资源约束必须实测。[Qwen model card](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B) [Qwen official blog](https://qwenlm.github.io/blog/qwen3-embedding/)

`BAAI/bge-m3` 的作者模型卡标注 1024 维、8,192-token sequence length、100+ languages，并同时支持 dense、sparse 和 multi-vector 表示。它也属于质量优先候选，但多种检索表示会显著扩大实现和存储复杂度，不应未经评测就全部启用。[BGE-M3 model card](https://huggingface.co/BAAI/bge-m3)

### 4.3 Apple Silicon runtime

有至少三条可验证路径：

- PyTorch 的 `mps` backend 可把模型和 tensor 移到 Metal GPU，官方文档说明其使用 Metal Performance Shaders Graph 和 tuned kernels。[PyTorch MPS docs](https://docs.pytorch.org/docs/stable/notes/mps.html)
- Hugging Face Text Embeddings Inference 当前提供 Apple Silicon Homebrew binary，并给出 Metal acceleration 的启动方式；其 Docker ARM64 路径反而只有 CPU，不应在 macOS 上套 Docker 后误以为仍有 Metal。[TEI official repository](https://github.com/huggingface/text-embeddings-inference)
- Apple MLX 是 Apple Machine Learning Research 提供的 Apple Silicon framework，但“MLX 可用”不等于上述任一模型已经有官方、等价且经过验证的 MLX 转换；如果选择 MLX，需要额外验证 tokenizer、pooling、normalization 和输出一致性。[Apple MLX repository](https://github.com/ml-explore/mlx)

第一版应先选择一个可长期维护的 runtime，而不是同时维护 PyTorch、TEI、Core ML 和 MLX 四套后端。研究上更值得先比较的是“轻量本地模型是否达到质量门槛”；只有失败后才用更大模型换质量。

## 5. 本地向量索引在大规模下如何维护

本机嵌入式索引仍能支持增量和大规模构建，不意味着要在 Hook 中扫描全部向量。

以 LanceDB 官方接口为一个可行性例证：

- 表写入会产生新 version，也支持查看历史 version；[LanceDB Table API](https://lancedb.github.io/lancedb/js/classes/Table/)
- IVF-PQ 会把向量分区并进行 product quantization，在索引大小、速度和准确率之间做取舍；大型训练可能较慢且占用较多内存；[LanceDB Index API](https://lancedb.github.io/lancedb/js/classes/Index/)
- 新增数据可能暂时处于 unindexed delta，查询会同时搜索旧索引和新增数据；`optimize_indices` 可把新增数据纳入索引，官方明确提示未索引数据持续增长会增加查询延迟；[Lance optimize API](https://lancedb.github.io/lance/api/py_modules.html)
- 可以读取 `numIndexedRows` 与 `numUnindexedRows`，适合作为维护和告警指标。[LanceDB IndexStatistics](https://lancedb.github.io/lancedb/js/interfaces/IndexStatistics/)

这证明“内嵌 + 增量 + 后台 optimize”在产品形态上可行，但不构成选择 LanceDB 的结论。具体引擎仍需要比较：

- exact search 与 ANN 在目标 N、维度和过滤条件下的 p95；
- Project/Global、privacy、lifecycle 等 pre-filter 是否高效且语义正确；
- 增量写入、删除、compaction 和崩溃恢复；
- 原始向量、量化索引和 metadata 的磁盘放大；
- ANN recall 与 Bad Case 的变化；
- Node/TypeScript 或本机 daemon 集成的维护成本。

不建议预先写死“超过 100k 就切 ANN”之类阈值。维度、过滤选择性、硬件和目标延迟不同，阈值应由目标机器 benchmark 得出。

## 6. 预计算可靠性的验收条件

预计算可以可靠，但必须满足以下可观察条件：

### 数据完整性

- 每个 eligible retrieval unit 恰好存在一个活动 embedding key。
- 向量维度与活动 manifest 一致，没有 NaN/Infinity/空向量。
- 输入 hash、Memory revision 和索引记录一致。
- 删除和修改后的旧 revision 不再参与候选召回。
- 每批成功、失败、重试和永久失败都有明确计数。

### 故障恢复

- 进程退出、关机、断网和 API 429 后可从 checkpoint 继续。
- 重试只处理缺失项，不能重复生成整库。
- quota/billing/模型不可达要显式提示，不能无限重试或静默长期陈旧。
- 当前活动索引始终可读；失败的新 revision 不切换。

### 质量门禁

- 在同一组正向保护用例和 `report irrelevant` 负向 Bad Cases 上比较旧/新 revision。
- 记录 recall、MRR/nDCG 等检索指标只是辅助；最终还要检查严格门禁后的自动注入是否相关。
- 验证中文、英文、混合语言、代码 symbol、路径、错误码、否定、例外、Project/Global 和 Private 边界。
- 不能用“更常返回空”伪装误召回下降。
- 任何模型或维度升级都走 Shadow Mode 和人工 Review，不自动切换。

### 运行指标

- dirty queue depth / oldest age；
- units/s、tokens/s、batch failure rate、retry rate；
- warm query embedding p50/p95/p99；
- ANN query p50/p95/p99；
- indexed/unindexed row count；
- 活动/候选/旧 revision 磁盘占用；
- degraded lexical-only 次数；
- 模型不可达和索引陈旧状态在界面上的显式提示。

## 7. 对当前架构 Review 的建议

可以继续接受“本机内嵌、全文与向量混合、具体引擎通过评测后选择”的总体边界，但应补上四个约束：

1. **自动 Hook 使用的 query encoder 必须本地可用并保持 warm；**否则远程依赖会破坏当前离线与延迟边界。
2. **Embedding 只做候选召回，不能单独越过严格相关性、scope、authority、freshness 和 lifecycle 门禁。**模型相似度不是知识事实，也不是自动注入的充分条件。
3. **首次/模型升级采用 revisioned shadow rebuild；日常采用 hash-driven incremental update。**不能把“预计算”实现成周期性全库重算。
4. **模型、维度、runtime、ANN 引擎和切换阈值都由目标数据集与目标 Mac benchmark 决定。**候选至少包括一个轻量本地基线、一个较强多语言本地模型和一个 OpenAI API 质量对照。

在实际数据远小于 1M units 时，预计算不应成为 MemStore 第一版的主要风险。更高风险的是：切分破坏条件语义、query encoder 冷启动、用向量相似度绕过严格门禁，以及模型升级时混用不兼容向量空间。

## 主要一手来源

- [OpenAI Vector embeddings guide](https://developers.openai.com/api/docs/guides/embeddings)
- [OpenAI Embeddings API reference](https://developers.openai.com/api/reference/resources/embeddings/methods/create)
- [OpenAI Batch API guide](https://developers.openai.com/api/docs/guides/batch)
- [OpenAI `text-embedding-3-small`](https://developers.openai.com/api/docs/models/text-embedding-3-small)
- [OpenAI `text-embedding-3-large`](https://developers.openai.com/api/docs/models/text-embedding-3-large)
- [OpenAI ChatGPT/API billing boundary](https://help.openai.com/en/articles/8156019-is-api-usage-included-in-chatgpt-subscriptions-even-if-i-have-a-paid-chatgpt-account)
- [BAAI `bge-small-zh-v1.5` model card](https://huggingface.co/BAAI/bge-small-zh-v1.5)
- [BAAI `bge-m3` model card](https://huggingface.co/BAAI/bge-m3)
- [Qwen3 Embedding official model card](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B)
- [Hugging Face Text Embeddings Inference](https://github.com/huggingface/text-embeddings-inference)
- [PyTorch MPS backend](https://docs.pytorch.org/docs/stable/notes/mps.html)
- [Apple MLX](https://github.com/ml-explore/mlx)
- [LanceDB index API](https://lancedb.github.io/lancedb/js/classes/Index/)
- [LanceDB table/version API](https://lancedb.github.io/lancedb/js/classes/Table/)
