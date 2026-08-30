# MemStore

MemStore 是面向 Coding Agent 的长期记忆系统。它管理记忆的沉淀、读取与长期治理，但不拥有用户编辑知识的方式。

## Language

**MemStore Project（记忆系统项目）**:
位于 AgentScratchpad 仓库中的程序项目，包含 Spec、源码、测试、配置模板、调度和迁移工具，不包含权威的个人知识数据。
_Avoid_: Memory Vault、记忆库、知识数据

**Memory Vault（记忆库）**:
由 Obsidian 打开的、以 Markdown 文件为主体的权威长期记忆数据仓库；用户和 Agent 都可以使用它，但它独立于 MemStore Project 的 Git 生命周期。
_Avoid_: MemStore Project、代码仓库、程序目录

**Canonical Memory Data（权威记忆数据）**:
Memory Vault 中可供手动查看、编辑、备份和迁移的知识数据；同一条记忆不应由 MemStore Project 维护第二份权威副本。
_Avoid_: 缓存、索引、程序状态

**Machine-local Runtime Data（本机运行数据）**:
MemStore 为可靠捕获、调度、治理、检索索引、诊断和修复而保存的可恢复本机状态，默认根目录是 `~/Library/Application Support/MemStore`。它不属于 MemStore Project 或 Canonical Memory Data，不能被操作系统当作普通 Cache 清理，也不随 Memory Vault 的普通迁移自动携带。
_Avoid_: Memory Vault、程序源码、临时缓存目录

**Runtime State Export（运行状态导出）**:
未来由用户显式触发、在 Worker 静止或使用 SQLite 一致性 backup API 时生成的版本化运行状态快照。它用于选择性迁移未完成工作，不属于普通 Vault 同步；导入后必须重新验证本机路径和 Project Registry，且可重建索引不必携带。
_Avoid_: 复制运行中的 SQLite 主文件、Vault 自动同步、跨机共享活跃数据库

**Bad Case（错误案例）**:
由明确的 irrelevant 报告、持续分类异常或其他已定义失败信号产生的本机诊断对象。SQLite 保存其生命周期和索引，`badcases/bc_<id>.json` 保存脱敏、有界、可交接的诊断上下文；它不是 Durable Memory，不能由后台流程静默修复产品规则。
_Avoid_: 用户知识、完整 Session 副本、仅凭模型猜测的错误标签

**Bad Case Signature（错误案例签名）**:
用于把同一失败模式的多次 occurrence 聚合到一个 Bad Case 的无正文稳定标识。它由错误类型、受影响组件、Project/scope 和版本维度等规范化字段生成，不包含原始 Prompt 或 Secret；新的真实 occurrence 可以更新 `last_seen_at`，扫描、重试和重复处理不能。
_Avoid_: 原文 hash 即完整诊断、每次出现一个新案例、定时扫描续期

**Repair Bundle（修复包）**:
用户显式启动修复 Skill 后，针对一个或一组 Bad Case 按需生成的本机工作包，包含诊断、修改建议、复现材料和验证计划。它为 Codex + GPT-5.6 修复流程提供上下文，但不授权自动修改 Prompt、阈值、检索算法或知识数据。
_Avoid_: 自动修复结果、Canonical Memory Data、后台静默代码修改

**MemStore Repair Skill（MemStore 修复技能）**:
用户显式调用的 `$memstore-repair` 前台工作流。它要求使用 Codex + GPT-5.6，先只读诊断并在方案 Review 后执行获准修改，再以测试、离线回放和 Shadow 证据通过激活 Review；Skill 不能自行切换或伪称模型，也不能自动 commit、push、改 Vault 知识或全局 Agent 配置。
_Avoid_: 后台修复 Worker、Luna 自动调参、无 Review 激活

**Relevant Safety Opportunity（相关安全机会）**:
C 类安全边界修复在实际运行中真正经过受影响 authority、scope、Secret、Human-authored 或等价门禁的一次可观测判定机会。普通 Turn、未触发该门禁的请求和重复回放不计数；观察期内任何相关违规都会使当前验证周期失败并在新修复后重新开始。
_Avoid_: Session 数、日历天数替代覆盖、普通检索次数

**Source Session（来源会话）**:
可能产生可复用知识的 Coding Agent 对话。它由来源 Agent 的历史系统保存，是记忆的证据来源，但本身不是长期记忆。
_Avoid_: Durable Memory、完整会话记忆

**Memory Candidate（记忆候选）**:
从 Source Session 中提炼、尚未获准参与常规回忆的知识陈述。候选可以包含事实、经验、偏好或明确标注的未验证推测。
_Avoid_: Durable Memory、事实

**High-value Memory Candidate（高价值记忆候选）**:
可能显著影响未来工作、值得更长等待和更严格验证的 Memory Candidate。Luna 只能根据受控类别提出 `importance_tags`、原因和证据引用；Promotion Gate 依据确定性规则确认分类，用户显式 pin 可以强制保护。高价值只改变治理优先级和保留期，不证明内容正确，也不提高内容权威。
_Avoid_: 高置信度即高价值、自动晋升、人工知识权威

**Consolidation-protected Candidate（合并保护候选）**:
已经通过 Batch 准入、并由显式用户陈述或至少两个不同的证据关联重要性依据支撑的长期候选。Session Consolidation 必须保留其语义或明确记录处置，不能把缺少说明的遗漏当作成功；保护不提高权威，也不绕过 Promotion Gate。
_Avoid_: 所有高价值候选无条件保留、合并后自动晋升、重复候选永久保留

**Accounted Distillation Result（有处置的提炼结果）**:
对非空 Batch 至少产生一个长期候选，或记录至少一个模型明确考虑过的拒绝、会话级、未知或来源回声处置。既没有候选也没有处置的空结果不代表“没有知识”，而是可重试的不完整结果。
_Avoid_: 空 Candidate 列表即成功、未考虑输入即 no-memory、用处置统计证明完整召回

**High-value Inflation（高价值膨胀）**:
Luna 在有足够有效样本时，以显著高于项目历史基线的比例把候选标为高价值，或让单一 `importance_tag` 异常垄断分类的治理异常。它先进入 provisional，只有跨两个非重叠窗口或两次 Weekly Maintenance 持续存在才成为 persistent；异常本身不能删除、降级或否定候选。
_Avoid_: 高价值数量硬上限、单次特殊 Session 即模型故障、比例异常即内容错误

**Durable Memory（长期记忆）**:
经过验证或治理、获准供后续 Agent 常规检索和使用的可复用知识。
_Avoid_: Source Session、聊天记录、Memory Candidate

**Memory Provenance（记忆来源）**:
把 Memory Candidate 或 Durable Memory 追溯到其 Source Session 的来源信息，至少能够区分来源 Agent、会话、时间和项目。
_Avoid_: Memory、会话副本

**Human-authored Memory（人工知识）**:
由用户在 Memory Vault 中手动创建、确认或实质修改的 Durable Memory。在其适用范围内拥有最高内容权威，自动化流程不得静默覆盖。
_Avoid_: Memory Candidate、Agent 推断

**Direct Human Assertion（人工直接断言）**:
用户在 Manual Memory Directive 中明确给出要保存的知识正文，而不是要求 Agent 从 Turn、Session 或其他材料中自行提炼。该正文按 Human-authored Memory 处理；Luna 只能在保持原意、条件、scope 和确定性不变的前提下整理结构或措辞。
_Avoid_: 来源材料提炼、Agent 补充、仅由用户授权 scope 的模型结论

**Model-derived Extraction（模型提炼内容）**:
Luna 或其他 Agent 从 Turn、Session、选中材料或证据中归纳出的知识陈述。即使用户明确指定 Project 或 Global scope，其内容权威仍是 Agent-derived，必须进入 Memory Candidate 生命周期。
_Avoid_: Direct Human Assertion、Human-authored Memory、scope 授权即内容确认

**Human Conflict（人工知识冲突）**:
普通记忆操作提交的新 Direct Human Assertion 与既有 Human-authored Memory 实质冲突、且用户没有明确指定替换目标时的待决状态。新断言会被可靠保存但不参与正常回忆，直到用户选择保留旧版、采用新版或限定各自适用条件。
_Avoid_: 自动采用最新内容、Memory Candidate、后台审批队列

**Secret Content（机密内容）**:
密码、API token、私钥、session cookie、authorization header 等认证材料或等价高风险内容。其正文不得进入 Durable Outbox、Luna、Memory Vault、索引、注入、日志、归档或 tombstone。
_Avoid_: Private Memory、可回忆知识、原文日志

**Private Memory（私密记忆）**:
允许在明确项目范围内保存和治理、但默认不得自动晋升为 Global Memory 的敏感知识。显式全局化需要人工指令并继续保留 Private 分类。
_Avoid_: Secret Content、Normal Memory、自动 Global

**Normal Memory（普通记忆）**:
不属于 Secret 或 Private、可以按标准 Project/Global 规则处理的知识。
_Avoid_: 未完成敏感分类、Secret Content、Private Memory

**Sensitivity Quarantine（敏感隔离区）**:
保存无法安全确定分类、不会参与正常回忆且不会发送给 Luna 的本地隔离状态。它用于后续确定性处理或显式复核，不是 Durable Memory。
_Avoid_: Governance Queue、正常索引、模型分类输入

**Sensitivity Quarantine Aggregate（敏感隔离聚合）**:
按风险类别和 body-free 来源种类汇总精确 Sensitivity Finding 的人工复核视图。它保留总量、发生次数、时间范围和少量近期 Finding identity，但不是独立 Finding、误报裁决或安全规则豁免。
_Avoid_: 每条审计记录都是人工待办、Suspect 正文摘要、批量误报批准

**False-positive Secret Override（Secret 误报豁免）**:
用户显式确认某次 Secret 检测是误报的窄范围授权。它绑定非可逆内容 fingerprint、检测规则 identity/version 和当前内容 revision；正文或规则发生相关变化后必须重新检测。它不能全局关闭检测，也不能授权保存真实凭据。
_Avoid_: Secret allowlist、强制存储凭据、明文豁免记录

**Application-level Encryption（应用层加密）**:
由 MemStore 自身负责密钥和加解密的字段、Note 或 Vault 加密能力。第一版不提供此能力；文件权限、FileVault 或同步服务加密不能被表述为 MemStore 主动加密。
_Avoid_: Secret 不落盘、文件权限、外部磁盘或同步加密

**Project Memory（项目知识）**:
仅适用于一个明确项目边界的知识，不因该项目中的一次结论而自动影响其他项目。
_Avoid_: Global Memory、通用知识

**Project Identity（项目身份）**:
Project Memory 用于归属、检索和隔离的稳定标识。人类可见名称可以来自 basename，但内部 `project_id` 必须避免把无关的同名目录静默合并。
_Avoid_: 当前 cwd、仅凭同名即合并、Global scope

**Project Marker（项目标记）**:
用户显式维护的 UTF-8 JSON `.memstore-project` 文件。v1 必须包含 `schema_version: 1` 和 `msproj_` + UUID v4 格式的稳定 `project_id`，可以包含不参与身份判断的 `display_name`；多个目录使用同一 ID 表示主动共享 Project Memory。MemStore 默认不创建、修改或删除该文件。
_Avoid_: 自动生成文件、绝对路径引用、Memory Vault 数据

**Project Registry（项目登记表）**:
把本机路径 alias、Git common directory 和规范化 remote 映射到 Project Identity 的 machine-local resolver 状态。它可以重建或重新登记，不是 Canonical Memory Data。
_Avoid_: Memory Vault、跨机权威路径、Project Marker

**Global Memory（全局知识）**:
预期可以跨项目复用的稳定知识，其成立不能只依赖一个项目中的偶然情况。
_Avoid_: Project Memory、默认知识

**Memory Space（记忆空间）**:
共享一个 Active Memory 容量与治理范围的知识集合；每个 Project Identity 对应一个 Project Space，Global Memory 单独构成 Global Space。共享 Project Identity 的多个本地目录属于同一个 Space。
_Avoid_: 本地目录、Obsidian 文件夹、整个 Memory Vault

**Active Memory Capacity（活跃记忆容量）**:
一个 Memory Space 中可参与正常检索和注入的 Active Agent-derived Durable Memory 数量。Archived Memory、Candidate、Tombstone 和 Human-authored Memory 不占用该受管容量。
_Avoid_: Vault 文件总数、物理存储上限、删除配额

**Capacity Governance Obligation（容量治理义务）**:
Memory Space 超过活跃记忆软目标后产生的可恢复治理工作。它优先合并、取代或归档不再适用的 Agent-derived Memory，并且不能仅按年龄、召回次数或模型重要性分数处理知识。
_Avoid_: 按最旧顺序删除、Human-authored 自动归档、一次性清空

**Independent Project Evidence（独立项目证据）**:
来自不同 `project_id`、且各自不依赖同一上游结论或 MemStore 注入内容的可追溯支持证据。同一 Project 的多个 Session、共享 marker 的 worktree/clone，以及由已有 Memory 回声产生的再次提炼都不能增加独立项目计数。
_Avoid_: Session 数量、路径数量、Memory Echo

**Memory Echo（记忆回声）**:
某个 Session 因已注入的 MemStore Memory 得出相同结论，随后又被捕获为看似独立的新候选。它可以保留来源关系用于诊断，但不能作为跨项目佐证或提高结论权威。
_Avoid_: Independent Project Evidence、重复验证、独立来源

**Manual Memory Directive（人工记忆指令）**:
用户主动指定内容、来源范围和目标 scope 的记忆操作。它可以明确授权 Global scope，并让 Luna 在后台提炼指定内容；scope 权限来自用户指令，不来自 Luna 的自行推断。
_Avoid_: 普通 Hook 捕获、模型自动判断全局、绕过来源与冲突规则

**Memory Skill（记忆技能）**:
由用户显式调用、把自然语言记忆意图转换为 MemStore 核心操作的轻量 Agent Skill。它选择来源与 Project/Global scope，并返回 operation 或 memory identity；自身不实现 Luna 调用、落盘或治理逻辑。
_Avoid_: 第二套记忆引擎、独立知识副本、仅生成摘要却不调用核心操作

**MemStore Remember Skill（MemStore 记忆技能）**:
名为 `$memstore-remember` 的 Memory Skill。它把明确正文映射为 `remember assert`，把从 Turn、Session 或 selection 提炼知识的意图映射为 `remember extract`；默认 Project，只有用户明确表达才选择 Global，含糊时走较低权威的 extract 候选路径。
_Avoid_: 含糊内容自动成为 Human-authored、自动推断 Global、Skill 直接写 Vault

**Governance Queue（治理队列）**:
供后台治理流程处理、不会直接参与正常回忆的 Memory Candidate 集合。候选必须能够从队列走向晋升、合并、等待、冲突、拒绝或过期，而不是无限堆积。
_Avoid_: Durable Memory、人工审批队列

**Deterministic Evidence Check（确定性证据检查）**:
不依赖 LLM、对已有证据执行的可重复检查，例如来源是否存在、内容 identity 是否匹配、Git revision 是否一致、已捕获命令结果是否完整，以及 provenance、scope、schema 和敏感规则是否满足。它只能证明机器可检查的条件，不能自行判断一段证据在语义上是否充分支持复杂陈述。
_Avoid_: Luna 语义判断、静默重新运行测试、事实必然为真

**Semantic Evidence Assessment（语义证据评估）**:
由 Luna 在需要时判断候选陈述是否被指定证据完整支持，并输出带证据引用的有限状态，例如 supported、partially supported、contradicted 或 insufficient evidence。它不拥有最终晋升权，也不能把缺失的证据推断为已存在。
_Avoid_: Promotion Gate、来源完整性检查、模型自我批准

**Promotion Gate（晋升门禁）**:
根据 authority、scope、sensitivity、conflict、evidence 和验证结果确定候选生命周期状态的本地确定性状态机。Luna 可以提供结构化评估，但不能绕过或修改门禁规则。
_Avoid_: Luna Prompt、人工逐条审批、检索排名

**Verification Request（验证请求）**:
当现有证据不足且进一步确认需要运行测试、构建、部署、访问高风险外部系统或获得新权限时生成的待办请求。它说明缺口和建议动作，但不会在后台静默执行这些动作，也不允许候选在完成前冒充已验证事实。
_Avoid_: 后台任意命令执行、Memory Candidate 晋升、强制人工阻塞

**Candidate Retention（候选保留策略）**:
决定等待中 Memory Candidate 何时有资格过期的规则。期限从最近一次有效新证据的 `last_evidence_at` 计算；普通重试、重复提取和 Memory Echo 不刷新期限。到期只产生复核义务，候选必须在系统恢复并完成一次成功治理检查后才能进入 expired。
_Avoid_: 定时器直接删除、系统故障期间丢失候选、重复出现即无限续期

**Candidate Tombstone（候选墓碑）**:
Memory Candidate 正式过期并删除正文后保留的临时无正文记录。它只保存去重和审计所需的 fingerprint、scope/Project、来源 identity、过期原因和时间；新的独立证据可以创建新候选并链接该记录，而不会被永久压制。
_Avoid_: 候选正文归档、Durable Memory Tombstone、永久拒绝规则

**Governance Ledger（治理账本）**:
持久记录定时治理任务的上次成功 cursor、尝试、lease、checkpoint、下次重试和失败状态。系统调度器只负责唤醒，账本决定是否仍有未完成义务。
_Avoid_: 单次 cron 触发、Governance Queue、仅内存计时器

**Review Suggestion（复核建议）**:
Luna 针对疑似过时、冲突或需要澄清的 Human-authored Memory 生成的 Agent-derived 治理元数据，包含原因和证据引用。它不修改人工正文、不降低人工权威，也不自动归档或隐藏该 Memory；相关检索命中时可以附带有界提示。
_Avoid_: Human-authored Memory 修订、自动归档、静默降权

**Human Memory Review Digest（人工知识复核摘要）**:
按可配置周期聚合仍未解决的 Review Suggestion 和 Human Conflict 的低频提醒。默认每周且仅在非空时投递；它支持 snooze，但不要求用户响应，也不阻塞 MemStore 的正常运行。
_Avoid_: 每条即时通知、强制审批队列、Durable Memory

**MemStore macOS Notifier（MemStore macOS 通知组件）**:
由 MemStore 自己维护、通过 macOS Notification Center 投递聚合治理提醒的最小本地组件。它不依赖 Obsidian 运行，不读取或展示知识正文，不调用 Luna；用户点击后通过 `obsidian://open` 打开 Review Inbox，并把投递或 snooze 结果写回 Governance Ledger。
_Avoid_: Obsidian Plugin、Agent 对话注入、模型通知器

**Review Inbox（复核收件箱）**:
Memory Vault 中可由 Obsidian 打开的、可重建的治理视图，默认路径为 `_MemStore/Review Inbox.md`。它链接到原始 Memory、展示问题分类和证据引用，并把高容量安全账本呈现为有界聚合而非逐行镜像；它不复制知识正文，也不是第二份权威知识。
_Avoid_: Canonical Memory Data 副本、用户知识正文、不可重建状态

**Reminder Obligation（提醒义务）**:
Governance Ledger 中记录某次摘要尚待尝试、已投递、已确认、已 snooze 或需要兜底的运行状态。通知失败、权限被拒或机器离线不会把它误记为已完成。
_Avoid_: Durable Memory、仅内存通知、投递失败即丢弃

**Catch-up Run（补跑任务）**:
在关机、休眠、断网、模型不可用或 Worker 故障后，从上次成功 cursor 覆盖所有遗漏数据的一次合并治理执行。它不会机械重放每个错过的日历时间点。
_Avoid_: 重复执行每个 missed tick、忽略过期任务

**Archived Memory（归档记忆）**:
已退出正常回忆和关系扩展、但仍在可配置保留期内可恢复的 Durable Memory。普通重试或治理不会刷新其 `archived_at`。
_Avoid_: Active Durable Memory、Memory Candidate、已物理删除内容

**Successor Memory（后继记忆）**:
用户明确替换某条 Memory 后成为当前有效版本的新 Memory。旧版本被归档并记录 successor identity，以保留可追溯历史而不参与正常回忆。
_Avoid_: 静默覆盖、无身份的新副本、自动解决 Human Conflict

**Purge Policy（清除策略）**:
决定 Archived Memory 何时删除正文的配置规则。单条 `purge_after` 或 `retain_forever` 优先，其次是 authority/scope 策略，最后是系统默认。
_Avoid_: 写死期限、归档即删除、后台静默覆盖人工保护

**Memory Tombstone（记忆墓碑）**:
正文清除后保留的最小无正文记录，可以包含 identity 或 fingerprint、原因、归档与清除时间以及 successor，用于防止无效知识被盲目重复创建。
_Avoid_: Archived Memory 正文、第二份知识副本、正常回忆内容

**Memory Injection（记忆注入）**:
把与当前 Session 或用户问题相关的 Durable Memory 作为受限上下文提供给 Coding Agent。它是长期记忆的主要消费方式，不包含未获准参与回忆的候选。
_Avoid_: 完整 Vault 加载、候选回忆

**Capture Event（捕获事件）**:
由 Coding Agent lifecycle Hook 从一个 Turn 或 Session 中提取并标准化的有界事件。它是后台提炼的输入，不是 Memory Candidate 或 Durable Memory。
_Avoid_: 长期记忆、模型摘要

**Durable Outbox（可靠投递箱）**:
保存已从 Capture Inbox 导入、尚待后台处理的 Capture Event 的机器本地、可恢复处理账本。它拥有事件生命周期、重试和批处理状态，但不是 Hook 的文件入口、Canonical Memory Data 或 Memory Vault 的副本。
_Avoid_: Capture Inbox、Memory Vault、治理队列、第二份权威知识库

**Capture Inbox（捕获收件箱）**:
Coding Agent Hook 在报告捕获成功前写入的机器本地、有界可靠入口。每个文件保存一个已经完成校验、敏感性处置和大小限制的 Capture disposition，Worker 会将其幂等导入 Durable Outbox。
_Avoid_: Durable Outbox、Emergency Capture Spool、无限积压、Canonical Memory、Vault 同步数据

**Capture Disposition（捕获处置）**:
Hook 对一次捕获尝试持久记录的结果，取值至少包括可处理事件、无正文 Secret 阻止和无正文敏感隔离。只有某个处置已经进入 Capture Inbox 后，Hook 才能把该次捕获报告为成功。
_Avoid_: Memory Candidate、Capture Event 正文副本、仅内存结果

**Distillation Worker（提炼工作进程）**:
独立于前台 Hook 运行的后台处理器。它幂等消费 Capture Event、合并同一 Turn 或 Session 的输入、调用 Luna，并把结果送入 Memory Candidate 生命周期。
_Avoid_: Hook、Coding Agent 前台 Turn

**Model Health Incident（模型健康事件）**:
Luna 从 healthy 转为 degraded 或 unavailable 后持续到恢复的可观测运行状态。它记录原因类别、起止时间、最近成功、下次重试和 backlog，但不包含 Prompt、记忆正文或凭据。
_Avoid_: Durable Memory、每轮重复通知、清除待处理任务

**Degraded Memory Mode（记忆降级模式）**:
Luna 暂时不可用时的运行模式。安全捕获、已有 Durable Memory 的检索注入和可独立完成的本地工作继续运行，模型提炼任务留在队列等待重试。
_Avoid_: 全系统不可用、自动 fallback model、丢弃 Capture Event

**Core Memory Pack（核心记忆包）**:
在 SessionStart 注入的、小而稳定的 Durable Memory 上下文；项目知识优先，全局知识补充，并受明确的条目和 token 预算约束。
_Avoid_: 完整 Vault、Memory Candidate

**Startup Policy（启动注入策略）**:
Durable Memory 中由用户控制的 `startup: always | auto | never` 元数据。`always` 表示在通过普通资格过滤后优先参与 Core Memory Pack，最多使用其 1,200-token 总预算中的 600 tokens；其余至少一半保留给动态 Project/Global 知识。`auto` 表示交给排名与多样性规则，`never` 只排除 SessionStart 自动注入而不影响每轮相关召回或显式查询。缺省值是 `auto`；它不能绕过 Secret、scope、生命周期、冲突或 token 预算规则，也不能被 Luna 或使用统计静默修改。
_Avoid_: 无条件必注入、关闭 Memory 检索、模型自动改写用户策略

**Relevant Memory Pack（相关记忆包）**:
在 UserPromptSubmit 根据当前问题从 Durable Memory 及其派生索引中检索出的有限上下文。普通非空包目标是 300–600 rendered tokens，最多六条、单条最多 192 tokens，整包硬上限 1,024 tokens；无关、短确认、纯延续、重复或已有知识返回空包。检索严格限时，失败时跳过，不在注入路径调用 Luna。
_Avoid_: 生成式临时摘要、完整 Vault、Memory Candidate

**Foreground Retrieval Endpoint（前台检索端点）**:
Foreground Retrieval Lane 暴露给 active SessionStart 和 UserPromptSubmit Hook 的机器本地、owner-only Unix socket。端点只传输有界请求和 completed、empty、busy、deadline 或 unavailable 结果；它不是网络服务、第二套检索器或跨 Project fallback。
_Avoid_: Foreground Retrieval Lane、Hook 内冷启动 embedding、独立 retrieval daemon、跨 Project fallback

**Foreground Retrieval Lane（前台检索通道）**:
在一个客户端可见截止时间内独占执行自动 Memory Injection 的高优先级路径。它不在后台工作后排队过期请求，并统一拥有准入、取消、Retrieval Snapshot、确定性选择和最终 Receipt 结果。
_Avoid_: Foreground Retrieval Endpoint、Distillation Worker、Explicit Deep Retrieval、普通任务队列

**Retrieval Snapshot（检索快照）**:
绑定一个已完成 Retrieval Index revision、有效配置和 Memory content identity 集合的不可变派生状态。Foreground Retrieval Lane 在请求开始时固定使用一个快照，新快照只能原子替换，不能在一次检索中混用版本。
_Avoid_: Retrieval Index 构建过程、Memory Vault、Canonical Memory Data、运行中查询拼装

**Relevance Band（相关性档位）**:
自动检索在硬安全和 lifecycle 过滤后对候选划分的 `high`、`probable` 或 `weak`。high 正常竞争，probable 只能以更紧凑、可按 ID 深读的形式有界参与，weak 不自动注入但仍可主动搜索；档位由混合检索信号决定，不要求词法与语义同时命中。
_Avoid_: authority 等同 relevance、embedding-only 一律拒绝、weak 自动注入

**Context Epoch（上下文周期）**:
从新的 SessionStart 开始，到宿主明确在 compaction 或等价生命周期转换后建立新上下文为止的预算周期。Adapter 无法可靠识别边界时不得猜测重置。
_Avoid_: 每个 Turn、仅按时间推断的重置、Coding Agent Session 历史

**Automatic Injection Budget（自动注入预算）**:
每个 Context Epoch 内 SessionStart 与 UserPromptSubmit 自动注入的最终 rendered token 总额。默认软目标是 8,192 tokens、硬上限是 12,288 tokens；SessionStart 实际用量计入其中。达到软目标后只允许高相关且高权威的未注入知识继续竞争，任何自动路径都不能突破硬上限。
_Avoid_: 固定填满、订阅 token 总池、显式深度检索额度

**Explicit Deep Retrieval（显式深度检索）**:
由 Agent、MCP 或 Memory Skill 主动触发的渐进式深入读取。初始页默认目标不超过 4,096 rendered tokens；同一检索链累计每跨过 8,192 tokens 发出一次用量 warning，但 MemStore 不设产品级硬 token 上限。它支持分页或按 Memory identity 深读，不占自动注入预算，但会占用宿主上下文和账号用量。
_Avoid_: Hook 自动注入、一次返回完整 Vault、把 warning 当拒绝

**MemStore Recall Skill（MemStore 回忆技能）**:
名为 `$memstore-recall` 的显式查询 Skill。它通过 `memstore_search`、`memstore_get`、`memstore_provenance`、`memstore_related` 和 `memstore_report_irrelevant` MCP tools 编排紧凑搜索、按 ID 深读、来源和关系查看；自身不复制检索引擎或绕过 lifecycle、scope 与 sensitivity 过滤。
_Avoid_: 自动 Hook 注入、Skill 内部第二套检索器、Candidate 深读

**Cross-Project Explicit Recall（跨项目显式回忆）**:
Agent 主动通过明确 `project_id` 或 `all_projects` 发起的只读 Normal Memory 查询。它不属于自动注入或默认 fallback，结果必须标注来源和非当前项目适用性，并记录 Retrieval Receipt；Private、Secret、Candidate 和未解决冲突不能借此跨 scope 暴露。
_Avoid_: 自动全库搜索、跨项目知识变成当前规则、使用即 Global

**Retrieval Index（检索索引）**:
由 Durable Memory 后台派生的、机器本地且可重建的全文、语义、scope、authority 和关系索引。它以原子 revision 发布，不是 Canonical Memory Data。
_Avoid_: Memory Vault、第二份权威知识、不可重建状态

**Injection Snippet（注入片段）**:
随 Durable Memory 变更而提前准备的简短、可归因回忆文本。每轮检索直接选用它，不临时调用 Luna 重新摘要。
_Avoid_: 完整 Memory 正文、每轮生成式摘要

**Compact Quality Recovery（紧凑表示质量恢复）**:
Compact generation 与 fidelity validation 只让 Luna 回传 `m1`、`m2` 等短 alias，由本地恢复真实 Memory identity。确定性门禁只检查非空、token 上限、敏感性和 revision/content identity；条件、例外与否定在改写后是否仍被保留由独立 Luna fidelity 阶段判断，而不是要求逐字 substring。重复 schema-invalid 会逐步缩小 Batch，显式 `quality retry` 才开启新 retry epoch。
_Avoid_: 让模型抄写 UUID、逐字 anchor 等同语义保留、相同大 Batch 无限重试

**Retrieval Query（检索查询）**:
由当前用户 Prompt、项目身份以及有界结构化会话信号组成的本地查询。结构化信号可以包含最近文件、symbol、错误、命令和已注入 Memory identity，但不包含完整对话。
_Avoid_: Source Session 副本、每轮 Luna 会话摘要

**Injection Receipt（注入回执）**:
记录一次检索使用的 query identity、index revision、选中 Memory identity/revision、rendered token 数、Context Epoch 自动累计、预算层级、遗漏原因和耗时的轻量操作数据。它用于可观测性、后台排名优化和识别候选是否依赖已注入知识；使用或回声不证明知识正确，也不改变内容权威或配置预算。
_Avoid_: Memory Provenance、使用即正确、自动删除依据

**Shadow Mode（影子模式）**:
MemStore 在后台捕获、建索引和评估检索，但不向前台 Turn 注入，用于无干扰地建立切换证据。Codex 原生 Memories 的开关状态会被观察和展示，但不属于 MemStore Shadow 身份，也不影响窗口连续性；MCP、受管 Hook、MemStore 程序和已批准检索模型仍属于窗口门禁。
_Avoid_: 双重注入、最终共存状态

**Luna Retry Epoch（Luna 重试周期）**:
一次自动尝试序列最多包含首次调用和六次自动重试。人工 retry 会开启新的重试周期并重置该周期计数，但保留 lifetime attempt count 和既有安全诊断；成功后才清除当前错误诊断。
_Avoid_: 人工 retry 后立即再次 blocked、清零累计历史、无限自动重试

**Structural Batch Recovery（结构化 Batch 恢复）**:
Distillation 使用短 evidence aliases 与 Luna 交互，并在本地恢复为原始 Evidence identity。包含多个事件、保留内容至少 64 KiB 的 Batch 若返回 schema-invalid，后台按保留字节量二分为两个子 Batch；原 Batch 作为可审计的结构失败终止，子 Batch 完成后仍由同一个 Session Consolidation 统一合并。
_Avoid_: 把模型原始输出落库、对同一大 Batch 盲目重复、拆分后绕过 Session Consolidation

**Controlled Cutover（受控切换）**:
关闭 Codex 原生记忆注入并启用 MemStore 注入的人工 Review 阶段。原生生成可以暂时保留用于比较和回退，但其结果不进入 MemStore 正常回忆。
_Avoid_: Final Cutover、自动配置修改

**Final Cutover（最终切换）**:
在验收通过并得到用户明确批准后，关闭 Codex 原生记忆生成与注入，使 MemStore 成为唯一长期记忆链路。
_Avoid_: 长期双系统共存、删除旧数据
