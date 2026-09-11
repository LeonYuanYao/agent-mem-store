# Claude Dreaming 调研与 MemStore 技术可行性

检索日期：2026-09-10（Asia/Shanghai）<br>
状态：Research Note，不构成 ADR，也不授权实现、开启功能或调用模型。<br>
范围：区分 Claude Code 的 Auto Memory / Auto Dream、Claude Managed Agents Dreams，以及第三方同名实现。官方网页为检索日动态快照，链接不代表永久固定版本。

## 结论先行

“Claude dreaming”不是一个可以无差别引用的产品接口。**已公开且有明确 API 契约的是 Claude Managed Agents 的 Dreams 研究预览；不能据此认定 Claude Code 已公开支持 `/dream`、固定定时整理或某个隐藏配置。** 本次读取 Code 的 memory、settings 和官方 CHANGELOG，均未检出 `dream`。这只是这些公开资料的检索结果，不证明二进制中没有相关实现。[Code Memory](https://code.claude.com/docs/en/memory)、[Code Settings](https://code.claude.com/docs/en/settings)、[官方 CHANGELOG](https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md)

Managed Agents Dreams 体现的是“已有记忆 + 历史证据 → 再综合”的后台流程。默认生成新库，便于检查后采用；但当前 API reference 已出现 EAP 原位更新选项，不能把“输入永远不变”当作覆盖全部模式的保证。[Create a Dream](https://platform.claude.com/docs/en/api/beta/dreams/create)

## 1. 名称与证据等级

| 名称 | 本次可确认的范围 | 不应推导的结论 |
| --- | --- | --- |
| Claude Code Auto Memory | 官方记录的本地记忆功能 | 不等于 Dreaming，也不等于定时后台重整 |
| Claude Code Auto Dream / `/dream` | 社区报告与第三方提取文本存在；公开 Code 文档和 changelog 本次未命中 | 不能保证账户开放、版本兼容、稳定开关、计费或恢复语义 |
| Claude Managed Agents Dreams | Anthropic 官方研究预览 API | 不等于本地 Claude Code 功能，也不直接接受任意本地 SQLite 数据库 |
| 第三方 `/dream` 或 memory 插件 | 各自作者维护的实现 | 名称相同不代表 Anthropic 原生实现或支持承诺 |

证据口径：Anthropic 发布文档/API/schema 是产品公开证据；本机发行物若经静态核验，只能证明该具体版本包含相关内容；用户在官方仓库发 issue 仍是用户报告；第三方反编译、prompt 提取与社区教程不升级为官方契约。

## 2. Claude Code：公开 Auto Memory 与未确认的 Auto Dream

官方 Auto Memory 由 Claude 维护本地 Markdown，默认按 repository 隔离并跨 worktree 共享。`MEMORY.md` 的启动加载上限是前 200 行或 25KB（先到者）；主题文件按需读取。`/memory` 提供查看与管理入口。这些是持久文本与上下文加载机制，不是模型参数训练。[How Claude remembers your project](https://code.claude.com/docs/en/memory)

关于 Auto Dream，当前公开资料不足以确认以下为稳定契约：触发时机、最小 session 数、24 小时阈值、固定模型、token 预算、写权限边界、自动备份、冲突处理、失败回滚、是否受账户开关控制。尤其不能把社区流传的“24h + 5 sessions”写成官方 SLA。未命中 dream 的资料为上述三个 Code 页面；结论限定在这些资料，不作全网不存在证明。

社区线索仅用于识别概念，不支撑实现结论：用户在 Anthropic issue tracker 报告启用 `autoDreamEnabled` 后丢失文件，说明值得检查删除权限和恢复边界，但并未证明普遍行为或根因；第三方 Piebald-AI 仓库发布名为 Dream: Memory Consolidation 的提取 prompt，也不证明当前账户实际执行同一流程。[用户报告 #47959](https://github.com/anthropics/claude-code/issues/47959)、[第三方提取文本](https://github.com/Piebald-AI/claude-code-system-prompts/blob/main/system-prompts/agent-prompt-dream-memory-consolidation.md)

## 3. Managed Agents Dreams：已公开的工作机制

### 3.1 输入、触发与输出

官方指南将 Dream 定义为异步记忆整理任务：输入已有 memory store 和 1–100 个 session，合并重复、更新过时或矛盾信息、发现新洞见。调用者创建任务，不应推定它自动扫描本机或按固定时钟触发。可提供高层 `instructions` 控制关注点；这不是逐行编辑指令接口。[Dreams 指南](https://platform.claude.com/docs/en/managed-agents/dreams)

创建入口为 `POST /v1/dreams`，核心字段为 `inputs`、`model`、可选 `instructions` 和 `output_behavior`。模型配置作用于 pipeline 各阶段。默认 `create_new` 克隆输入库并整理到独立输出库；`update_existing` 在 EAP 中要求目标就是输入库，会原位修改。该 API 明确警告研究预览的请求/响应形状可能变化，不享有 GA 弃用期保证。[Create API](https://platform.claude.com/docs/en/api/beta/dreams/create)

官方 Python SDK 的参数定义包含 `output_behavior`，是公开 schema 的额外交叉证据，而不是另一个独立 Dreaming 产品。[SDK 参数源码](https://raw.githubusercontent.com/anthropics/anthropic-sdk-python/main/src/anthropic/types/beta/dream_create_params.py)

### 3.2 生命周期、权限与成本

任务有 `pending`、`running`、`completed`、`failed`、`canceled` 状态，结果资源暴露输出库、底层 `session_id`、错误与输入/输出/cache token 用量，便于异步跟踪。[Get a Dream](https://platform.claude.com/docs/en/api/beta/dreams/retrieve)

指南给出的运行量级为数分钟到数小时；失败或取消可保留部分输出，不能当作已完成库采用。按所选模型标准 API token 费率计费，`instructions` 上限 4,096 字符，session 上限 100；指南没有给出固定每次价格或成功质量保证。访问仍需申请研究预览，Dream 端点由 `dreaming-2026-04-21` 控制。[Dreams：生命周期、计费与限制](https://platform.claude.com/docs/en/managed-agents/dreams)

Managed Agents 需要 API key；会在服务端持有会话、状态和输出，当前不适用 Zero Data Retention 或 HIPAA BAA。它不是本地文件功能，也不能以“记忆保存在本机”为由豁免数据出境/敏感数据判断。[Managed Agents overview](https://platform.claude.com/docs/en/managed-agents/overview?ct=9564)

### 3.3 官方资料之间的差异

- **写入语义**：指南仍概括输入不修改，API reference 已公开 `update_existing`。本报告采用更精确的“默认新库不改输入；原位模式会改输入”，不掩盖差异。
- **beta header**：指南示例携带 `managed-agents-2026-04-01` 与 `dreaming-2026-04-21`；API 创建示例仅展示 dreaming header。应使用对应端点的官方 SDK/当前访问说明，不能推断普通 Managed Agents 权限自动授予 Dreams。[Dreams 指南](https://platform.claude.com/docs/en/managed-agents/dreams)、[Create API](https://platform.claude.com/docs/en/api/beta/dreams/create)
- **公布日期**：官方 release notes 将研究预览列于 2026-05-06，而当前博客页面日期显示 2026-05-19。此处以 release notes 的条目日期描述首次发布，不据博客日期重写历史。[Release notes](https://platform.claude.com/docs/en/release-notes/overview)、[产品博客](https://claude.com/blog/new-in-claude-managed-agents)

## 4. 调研不能证明什么

尚未通过官方公开实现确认 Code Auto Dream 的具体算法与模型；没有运行模型，因此也没有记忆质量、耗时或成本实测。Managed Agents 的内部去重算法、证据验证强度、精确运行时预算和输入库大小上限，不能从本次公开参数表推出。

因此目前能借鉴的是“异步再综合、明确输入集合、显式结果状态、可检查输出”的设计模式，而非把隐藏功能开关或第三方 prompt 当作可依赖的平台服务。MemStore 适配与本机发行物静态检查应另列为本仓库证据及工程判断，不与本节官方事实混写。

## 5. 本机 Claude Code 发行物：已核实的实现线索

本机 `claude --version` 返回 **2.1.263**。对安装包中的 `bin/claude.exe` 做只读字符串检查，找到了完整的 Dream: Memory Consolidation 提示词及相邻后台任务实现。没有启动 Dream、修改配置或发送模型请求。以下结论仅适用于这个发行物，不证明当前账户已启用该功能。

- 提示词分四步：浏览现有记忆和索引；寻找近期会话信号；合并或更新主题文件；清理并更新索引。
- 建议阅读近期 1–3 天活动日志，必要时定向搜索 JSONL；明确避免通读全部 transcript。
- 鼓励合并到既有主题，转换相对日期，处理已被证据推翻的事实。
- 相邻执行逻辑包含默认 `minHours:24`、`minSessions:5`，但支持运行时配置覆盖，并经过其他可用性判断。因此这是本版本默认值线索，不是固定产品承诺，也不代表关闭 CLI 后仍有独立定时服务。
- 通过后台 fork 执行模型任务，具有锁、运行状态、变更文件记录和 usage 记录。运行提示限制项目探索为只读，允许修改记忆目录；本次没有完整审计权限实现或验证失败恢复。

这些本机证据足以确认：Code 中确实包含后台记忆综合实现。公开文档不足主要影响稳定接口和启用条件的判断。MemStore 可以自行实现同类流程，无需依赖 Code 的内部函数、隐藏开关或账号开放情况。

## 6. MemStore 已有能力与实际缺口

检查基线：`main`，commit `dreaming-baseline-2026-09-10`。以下为代码检查，不是本轮线上质量测试。

| 能力 | 当前实现 | 对 Dreaming 的意义 |
| --- | --- | --- |
| 单 session 多 batch 汇总 | `consolidate_session` 读取该 session 指定范围的 batch 结果后调用模型 | 已解决一部分长任务碎片化；不等于跨 session 综合 |
| 周期治理选材 | weekly 取变更条目及已有关系邻居，monthly 取 active/archived；按 memory ID 排序分页 | 已有增量入口，但同主题可能分散在不同页 |
| 治理动作 | archive、supersede、mark_review_due、add_relationship | supersede 的后继必须已在冻结集合中，缺少创建综合后新知识的动作 |
| 重复评估 | equivalent、单边涵盖、conflicts 等成对判断 | 可提供合并候选；多条互补经验的综合仍需新流程 |
| 容量 working set | 排名和排除记录控制默认参与检索的集合 | 降低检索数量，未将碎片改写成更完整的知识 |
| 人工权威保护 | 治理拒绝直接修改 Human-authored，只为其生成建议 | 应原样保留 |

代码依据：[session 汇总](../../src/worker/distillation.ts)、[治理选材](../../src/governance/scheduling.ts)、[治理动作契约](../../src/governance/contracts.ts)、[校验及落地](../../src/governance/worker.ts)、[重复评估](../../src/quality/duplicates.ts)、[working set](../../src/capacity/index.ts)。

**可行性判断：值得做一个有限范围实验；工程基础充足，尚需验证综合质量是否优于现有记忆。** 最有价值的增量是跨 session、按主题的证据综合。仅给现有 weekly governance 换一个名称，无法补上这个缺口。

## 7. 推荐方案：扩展现有治理，不新增常驻服务

建议把 Dreaming 定义为治理中的“主题综合任务”，使用现有 worker、模型适配、canonical revision、索引及通知能力。首版暂不引入独立知识图谱、额外数据库或通用自主探索 agent。

1. **选择发生变化的主题。** 从新增/修订记忆出发，在相同 project/global 范围内，利用现有关系与本地检索找到邻近条目。相似度只用于组候选，模型仍须判断是否讨论同一事实。避免每轮全库重新聚类。
2. **准备有边界的证据包。** 包含原条目正文、适用条件、否定与例外、时间、权威级别、revision ID 和来源引用。原始记录仍在且确有必要时，定向补充脱敏片段；不自动重放所有长 session，不绕过敏感信息隔离。
3. **模型提出结构化结果。** 可选择不改、合并重复、综合互补经验、建立关系、报告冲突。新增综合知识必须说明每项结论的来源，以及哪些旧条目已被完整涵盖。首轮实验建议 Luna Medium、非 fast；其是否胜任需实测。
4. **程序校验并提交。** 程序负责 project/authority 边界、来源存在性、revision 未变化、幂等和写入；模型负责语义建议。新条目先走准入与派生表示校验，成功发布后才替换被完整涵盖的旧条目。跨 Markdown/SQLite 的中断恢复需要沿用并验证现有写入机制，不能只靠一个 SQL 事务假设整体原子性。
5. **重新建立受影响的检索表示。** 合并索引更新，避免每改一条就重建全库。只通过现有 UserPromptSubmit 检索与显式查询消费，不恢复 SessionStart 默认注入。

### 必须保留的质量边界

- 同一句话在多个派生记忆中重复，不算多个独立证据。综合结果保留原始来源身份，不能靠反复综合抬高可信度。
- “新一些”不自动等于“正确一些”。原始来源已清理、无法判断现状时，只允许证据支持的整理，不能声称已经重新验证当前事实。
- 合并不能丢掉分支、版本、环境、前提或否定条件；互相冲突的分支事实可以分开保留。
- 不自动修改 Human-authored，不自动从 project 提升为 global，不复活已拒绝或删除的知识。受保护条目沿用现有保护规则。
- 多条来源不意味着必须合成一篇长文。保留可独立检索的事实单位，避免条目数下降但相关性变差。
- 旧条目只有在信息被完整承接时才能被替代；沿用归档和三个月保留政策，不让 Dreaming 直接永久删除。可恢复仅限保留期内，不承诺永久回滚。
- 正式自动化前明确输出可应用范围：证据充分的 Agent-derived 整理可自动落地；涉及人工权威或事实冲突时才进入 Review Inbox，避免逐条审批。

## 8. 性能、成本与运行方式

Dreaming 在后台执行，不给每轮 prompt 增加一个模型调用。CPU、SQLite 写锁和 embedding 更新仍可能争用资源，所以需要限制每批规模、避免持锁等模型、优先保障前台，并复用离线退避与重试机制。不能承诺完全零影响。

成本主要取决于读取的记忆和证据长度、生成长度、校验与重试。建议设置每次运行 token/批次预算；超额任务延后，按条目 revision 与输入摘要跳过无变化的主题。保留现有的精简模型上下文，仅传主提示词、schema 和证据包，不加载业务技能。现有 Luna 调用已使用 `service_tier="default"` 与 `model_reasoning_effort="medium"`，见 [模型适配器](../../src/luna/index.ts)。

首版可以复用周一 19:00 治理入口，不新增时间规则。若实验表明需要更及时整理，再加入 worker 中合并触发的增量任务。最终应减少重复的旧治理调用，避免永久叠加两套对同一批材料的模型审查。本轮未测量 token，无法给出可信的每日费用或节省比例。

## 9. 推荐的下一步：小规模只读实验

在批准正式实现之前，建议先挑 **3–5 个主题，每组约 10–30 条真实记忆**，覆盖重复、互补、冲突、来源缺失和 Human-authored 混合等情况。数字为可调整的首轮规模建议，不是产品规则。

实验生成独立提案和前后对比，不改生产 Vault、Candidate 状态、索引或运行模式。用同一组真实查询及少量明确标记的测试查询，比较原库与模拟综合后的检索：

- 是否减少同义碎片，同时保留关键条件、例外和来源。
- 是否引入没有依据的结论，或错误扩大适用范围。
- 原先能回答的问题是否仍能回答；不能只看条目减少率。
- 原先误召回的问题是否改善；综合条目是否因覆盖太广而更容易误召回。
- 实际 input/output/reasoning token、耗时、重试和人工复核负担。

建议在实验中把候选新知识逐条对照来源 review；生产阶段再根据证据决定哪些动作自动化。若效果成立，再走 Architecture / Implementation Plan review，并实现有界的新增治理动作。若收益只来自普通去重，优先优化现有去重流程，避免增加长期维护负担。

本轮使用 `research` 技能核实一手资料并保存研究记录，使用 `doc-write-to-human` 技能区分事实、推断与建议。仅新增本研究文档；未改实现、线上数据或配置，未运行 Dreaming 模型实验，未提交或推送。
