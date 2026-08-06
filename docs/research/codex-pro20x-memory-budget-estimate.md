# Codex Pro 20x 对 MemStore 注入预算的影响

检索日期：2026-08-04（Asia/Singapore）
状态：Research Note，不构成 ADR，也不授权实现
范围：只使用 OpenAI 官方文档，评估 ChatGPT Pro 20x 订阅下长期记忆注入的用量影响；不推导 OpenAI 未公开的套餐 token 总池。

## 结论

ChatGPT Pro 20x 没有公开、固定、可以换算为某个 token 数量的套餐池。OpenAI 当前公开的是：

- Pro 20x 提供 Plus 的 20 倍 Codex 使用额度；这是相对使用额度，不是“每周 N 个 token”的承诺。
- 当前 Codex 用量按 input、cached input 和 output token 折算为 credits；模型、上下文、推理、工具、检索和缓存都会改变实际消耗。
- Pro 20x 的当前官方页面给出每五小时可发送消息数的宽泛区间，但同一套餐、同一模型内仍可能相差十倍，不能反推出可靠的 raw-token pool。
- 记忆注入直接增加的是 input tokens。它对 output、reasoning、tool calls 和子 Agent 的间接影响只能用真实 Session A/B 或 Shadow Mode 测量。
- 因为 Pro 20x 的额度明显高于 Plus，MemStore 没必要为了节省少量输入而长期采用可能损害召回质量的过小预算；但也不能把 20x 当成无限用量。合理做法是用 4k、8k、12k 等候选 epoch 预算做质量曲线，再结合 Codex Settings > Usage、Usage Dashboard 或 usage telemetry 的真实 rate-limit 消耗选取质量平台点。

## 1. Pro 20x 到底表示什么

OpenAI 将个人 Pro 分为两个额度档位：$100/月的 Pro 5x 和 $200/月的 Pro 20x。官方定义是相对 Plus 分别拥有 5 倍和 20 倍的使用额度，并没有公布与 20x 对应的固定 token 或 credit 总额。[About ChatGPT Pro tiers](https://help.openai.com/en/articles/9793128-about-chatgpt-pro-plans) [Codex pricing](https://developers.openai.com/codex/pricing)

当前 Pro 20x 的官方近似本地消息区间如下：

| 模型 | Pro 20x 本地消息 / 5 小时 |
| --- | ---: |
| GPT-5.6 Sol | 200–2,000 |
| GPT-5.6 Terra | 500–4,000 |
| GPT-5.6 Luna | 5,000–40,000 |
| GPT-5.5 | 300–1,600 |
| GPT-5.4 | 400–2,000 |
| GPT-5.4 mini | 1,200–7,000 |

这些是估算区间，不是保证值。官方同时明确：本地消息和 cloud chats 共享五小时窗口，还可能有额外 weekly limits；同一条消息的用量取决于模型、任务大小和复杂度、上下文、reasoning、tool use、retrieval 与 caching。因此不能用区间中点乘以某个“平均 token 数”来推导套餐 token 池。[Codex pricing: usage limits](https://developers.openai.com/codex/pricing)

计划内额度先被消耗；到达计划限制后，符合条件的 Plus/Pro 用户可以购买 credits 继续使用。Codex、ChatGPT Work、ChatGPT for Excel 和 Workspace Agents 在可用时共享 agentic usage/credit pool，因此 Codex 之外的 agentic 功能也可能占用同一额度。[Using Credits for Flexible Usage](https://help.openai.com/en/articles/12642688) [Using Codex with your ChatGPT plan](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan)

### 未公开、不能假设的值

- Pro 20x 每五小时或每周对应的 raw input/output token 总量。
- Pro 20x 计划内额度对应多少 credits。
- weekly limit 的固定 credit/token 数值。
- 每个百分点 rate-limit usage 对应的固定 token 或 credits。
- “20x”是否对每一种模型、Fast、Ultra、Cloud 和子 Agent 都能换算成同一个 raw-token 倍率。

Codex Settings > Usage、Usage Dashboard 和 usage telemetry 是当前账号真实额度进度的来源；任何静态估算都不能代替它们。[Codex pricing: current usage](https://developers.openai.com/codex/pricing)

## 2. 当前 token-based credit rate card

2026-04-02 起，新的和现有的 Plus/Pro Codex 用量已切到 token-based rate card。当前 GPT-5.6 系列的标准模式 rate 如下：

| 模型 | Input / 1M | Cached input / 1M | Output / 1M |
| --- | ---: | ---: | ---: |
| GPT-5.6 Sol | 125 credits | 12.5 credits | 750 credits |
| GPT-5.6 Terra | 50 credits | 5 credits | 300 credits |
| GPT-5.6 Luna | 5 credits | 0.5 credits | 30 credits |

Codex 不对 cache writes 单独收费。Rate card 还给出 GPT-5.6 Sol 的典型任务约为 5–40 credits，但这只是当前官方经验区间，不适合替代本机统计。[Codex rate card](https://help.openai.com/en/articles/20001106-codex-rate-card)

直接 credit 估算公式为：

```text
credits ~= (
  uncached_input_tokens * input_rate
  + cached_input_tokens * cached_input_rate
  + output_tokens * output_rate
) / 1_000_000 * speed_multiplier
```

这里的 `input_tokens` 分类应以 Codex thread usage、Usage Dashboard 或实际 telemetry 为准；不要把 `cached_input_tokens` 同时重复计入普通 input。

### 每 1,000 个记忆输入 token 的直接边际消耗

| 模型 | Standard，全部 uncached | Standard，全部 cached | Fast，全部 uncached |
| --- | ---: | ---: | ---: |
| GPT-5.6 Sol | 0.125 credits | 0.0125 credits | 0.3125 credits |
| GPT-5.6 Terra | 0.050 credits | 0.0050 credits | 0.1250 credits |
| GPT-5.6 Luna | 0.005 credits | 0.0005 credits | 0.0125 credits |

Fast mode 在支持的 GPT-5.6/5.5 模型上把速度提高约 1.5 倍，同时按 Standard 的 2.5 倍消耗 credits；GPT-5.4 的 multiplier 是 2 倍。该 multiplier 适用于通过 ChatGPT 登录的 Codex；API key 使用 API token pricing，不使用 ChatGPT credit multiplier。[Codex Speed](https://developers.openai.com/codex/speed)

### 不同 epoch 注入量的上界估算

下面只计算“新增记忆文本本身”，并保守假设全部为 uncached input；没有计算记忆引发的额外输出、工具调用或子 Agent：

| 每个 context epoch 的自动记忆总量 | Sol Standard | Sol Fast | Terra Standard | Terra Fast | Luna Standard | Luna Fast |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 4,000 tokens | 0.50 | 1.25 | 0.20 | 0.50 | 0.02 | 0.05 |
| 8,000 tokens | 1.00 | 2.50 | 0.40 | 1.00 | 0.04 | 0.10 |
| 12,000 tokens | 1.50 | 3.75 | 0.60 | 1.50 | 0.06 | 0.15 |

以 Sol Standard 为例，8,000 个完全 uncached 的记忆输入约为 1 credit；相对官方给出的典型 Sol task 5–40 credits，大约相当于单个典型任务用量的 2.5%–20%。这只是 direct-input 上界对比，不代表整次任务的净增量。

## 3. 为什么不能只按“注入 token 数”判断实际损耗

### 3.1 对话历史会被再次提交

记忆一旦进入对话上下文，后续请求通常还会携带这段历史。若命中 cache，历史 input 的 rate 只有普通 input 的十分之一；若 cache miss，则可能再次按普通 input 计费。MemStore 的预算不能预设缓存必然命中。

OpenAI 的 API 文档说明 Prompt Caching 只对 exact prefix match 生效；GPT-5.6 的隐式 breakpoint 包含变化内容时，即使前面有数千个相同 token，`cached_tokens` 仍可能为 0。这个 API 机制不能直接证明 Codex 产品一定采用同一 breakpoint，但足以说明设计上应该实测 cache hit，不能把所有长期记忆按 cached rate 估算。[Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)

### 3.2 高质量记忆可能降低总用量

准确的约束、项目决策和既有诊断结论可能减少重复搜索、文件读取、错误尝试与输出。反过来，低相关或重复记忆会增加输入、干扰判断并诱发更多工作。因此：

```text
net usage delta
  = direct memory input
  + changed output/reasoning/tool/subagent usage
  - avoided exploration and repeated work
```

后两项无法从 rate card 推导，只能以相同任务集做无记忆、不同预算的对照。

### 3.3 Fast、Ultra 和子 Agent 会放大影响

Fast 对支持模型直接应用 credit multiplier。Ultra 不是独立 rate-card 模型，但官方说明它会使用 maximum reasoning，并可能为符合条件的用户运行额外 Agent，因此仍按模型和所有 Agent 实际产生的 tokens 计费。[Codex rate card](https://help.openai.com/en/articles/20001106-codex-rate-card)

如果 MemStore 将相同 Core Pack 注入主 Agent 和每个子 Agent，开销可能近似按上下文数量放大。首版预算与 telemetry 应至少区分主 Session、子 Agent 和 scheduled/background runs，不能只统计最外层 Session。

### 3.4 Local、Cloud 与 API key 不是同一种估算边界

官方说明任务在哪里执行也会影响 Codex 用量。对当前多数 Plus/Pro 用户，token-based rate card 不再为 Local 与 Cloud 设置两套独立 token 单价，而是按实际 input/cached/output mix 计 credits；但是 Cloud 工作通常可能拥有不同的上下文和工具行为，所以实际 token mix 仍可能不同。[Using Codex with your ChatGPT plan](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan)

API-key 模式不消耗 ChatGPT Pro 计划额度，按标准 API 价格计费。GPT-5.6 API 请求在 input 超过 272K 时，对整次请求使用 2 倍 input、1.5 倍 output 定价；Codex Pro rate card 没有公布相同的长上下文 surcharge，因此不能把 API 规则直接套到订阅内用量。[GPT-5.6 Sol model](https://developers.openai.com/api/docs/models/gpt-5.6-sol)

## 4. 面向 MemStore 的质量优先选择框架

不能因为 Pro 20x 就推导一个“可安全使用的最大 token 数”。建议让最终默认值由以下三道门共同决定：

### Gate A：先找到质量平台点

在同一组真实任务上 Shadow 计算多个预算档位，例如 `4k / 8k / 12k / 16k per context epoch`，同时保持检索器、知识库 revision 和候选集合不变。至少比较：

- 必要知识 recall；
- 不相关注入率；
- 被预算截断的高权威知识数；
- 后续显式深挖率；
- 重复探索或重复犯错率；
- 最终任务成功率。

选择第一个接近质量平台点的预算，而不是先选择最便宜的预算。若 8k 到 12k 仍显著改善必要知识 recall，就不应为了节省 0.5 Sol Standard credit 而停在 8k。

### Gate B：再用真实账号用量验证容量

至少采集一个完整 weekly window，记录：

- Codex Settings > Usage、Usage Dashboard 或 usage telemetry 的开始/结束 usage percent；
- 每个 context epoch 的 memory injected tokens；
- 模型、Standard/Fast、reasoning mode、主/子 Agent；
- input、cached input、output 与实际 credits；
- 到达五小时或 weekly limit 的次数。

优先比较“启用 MemStore 前后的 rate-limit 百分点变化”和官方 UI/thread credits，而不是用未公开的 plan credit pool做反推。

### Gate C：设置自适应上限，而不是单一永久数字

可考虑三层约束：

1. `target`：普通 epoch 的期望自动注入量。
2. `hard cap`：高价值知识可以使用，但任何自动路径都不能突破的上限。
3. `usage pressure fallback`：当五小时或 weekly 用量明显偏离本机基线时，减少低优先级注入，而不是删除关键 Human-authored/`startup: always` 知识。

推荐评审公式：

```text
choose the smallest budget B where
  quality(B) is within the accepted tolerance of the quality plateau
  and observed weekly MemStore overhead stays within the user-approved share
```

“user-approved share”应基于本机完整 weekly window 决定；OpenAI 没有公开 raw-token pool，不能预先伪造一个精确百分比。Pro 20x 只说明实验可以更偏向质量，不代表可以取消 hard cap、相关性阈值、去重和零注入。

## 5. 给后续人工评审的数据输出

在冻结个性化默认值之前，MemStore Shadow Mode 应提供一份可直接 review 的表：

| 指标 | 4k | 8k | 12k | 16k |
| --- | ---: | ---: | ---: | ---: |
| 必要知识 recall |  |  |  |  |
| 不相关注入率 |  |  |  |  |
| 高权威知识截断数 |  |  |  |  |
| 自动注入实际 P50/P95 |  |  |  |  |
| 新增 uncached/cached input |  |  |  |  |
| 估算/实际新增 credits |  |  |  |  |
| weekly rate-limit 百分点变化 |  |  |  |  |
| 最终任务成功率 |  |  |  |  |

在这份数据出现前，可以讨论候选档位，但不应声称已经知道 Pro 20x 的“最佳 token 预算”。

## 6. 后续人工评审结果

2026-08-04 的人工评审接受质量优先默认值：SessionStart hard cap 为 1,200 tokens，`startup: always` ceiling 为 600 tokens；UserPromptSubmit 普通非空包目标为 300–600 tokens、hard cap 为 1,024 tokens、最多六条且单条最多 192 tokens；每个 context epoch 的自动注入 soft target 为 8,192 tokens、hard limit 为 12,288 tokens；显式深度检索默认 4,096 tokens、单次 hard limit 为 8,192 tokens。

该结果是产品默认值，不是从 Pro 20x 推导出的套餐极限。用量窗口跨过 70% 或 85% 只产生有界提醒，不会静默降低上述预算；任何自动配额降级都需要新的显式人工决定。Controlled Cutover 前仍需通过 Shadow Mode 验证质量平台、缓存和真实账号用量。规范性定义以 [ADR-0024](../adr/0024-adopt-quality-first-memory-injection-budgets.md) 和项目 Spec 为准。

## 官方来源

- [Codex pricing and usage limits](https://developers.openai.com/codex/pricing)
- [Codex rate card](https://help.openai.com/en/articles/20001106-codex-rate-card)
- [Codex Speed](https://developers.openai.com/codex/speed)
- [About ChatGPT Pro tiers](https://help.openai.com/en/articles/9793128-about-chatgpt-pro-plans)
- [Using Credits for Flexible Usage in ChatGPT](https://help.openai.com/en/articles/12642688)
- [Using Codex with your ChatGPT plan](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan)
- [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- [GPT-5.6 Sol model](https://developers.openai.com/api/docs/models/gpt-5.6-sol)
