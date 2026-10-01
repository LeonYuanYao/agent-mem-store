# Indexing, recall and automatic injection

[Source map](../../src/README.md) · [Agent guide](../../AGENTS.md)

## Responsibility

Builds derived search snapshots, selects relevant memories and serves both explicit recall and automatic hook injection.

## Start here

- [index.ts](index.ts)
- [snapshot.ts](snapshot.ts)
- [recall.ts](recall.ts)
- [packs.ts](packs.ts)
- [foreground-runtime.ts](foreground-runtime.ts)

## Flow and collaborators

index.ts builds indexes; snapshot.ts loads immutable search data; recall.ts serves explicit search/show/related/provenance; packs.ts ranks and budgets automatic candidates; foreground-* files own worker IPC and execution.

- [embeddings/README.md](embeddings/README.md)
- [health/README.md](../../src/health/README.md)
- [configuration/hook-display.ts](../../src/configuration/hook-display.ts)
- [operations/recall.ts](../../src/operations/recall.ts)

## State and side effects

Writes indexes, receipts, attempt records and irrelevant feedback. index-coordinator.ts handles publication; receipt-retention.ts handles historical receipts. judge.ts owns the explicit retrieval judge; do not move it into every hook call.

jev.ts provides a separate, opt-in UserPromptSubmit filter after the local pack
has been selected. foreground-ipc.ts owns its lifetime and short failure cooldown.
It is disabled by default and falls back to the unchanged local pack when
unconfigured or unavailable. A valid all-rejected result stays empty. packs.ts
filters before rendering and recording epoch tokens/deduplication, and records
provider telemetry under receipt `timings.jev`. SessionStart and explicit recall
do not invoke Jev. See [ADR-0135](../../docs/adr/0135-add-opt-in-jev-automatic-relevance-filter.md).

Jev receipt diagnostics distinguish local deadline pressure from its stage timeout.
`deadlineRemainingMs` is the nonnegative foreground time remaining at filter entry.
`budgetMs` is the latest total stage allowance, including time already spent: at
most 1,300 ms after reserving 200 ms for receipt/delivery, reduced by the configured
timeout when that setting is applied. Early skips may report only the initial
allowance; it is not time spent or proof that a request ran. `budgetSource` identifies
the limiting foreground deadline or stage timeout (ties use `stage_timeout`).
`httpStarted` means the fetch adapter was invoked, not that the provider received
the request. `stage` identifies the last stage reached, from admission and local
preparation through response headers, body decoding, validation and completion.
The fields are optional when reading historical receipts; absence is unknown,
not a negative observation. No provider payloads or credentials are recorded.
These diagnostics require a committed receipt and cannot explain an outer
foreground failure that ended before receipt creation. They do not change timeout,
cooldown, filtering or core health policy.

The default foreground client deadline is 1,500 ms, including local retrieval,
Jev, receipt persistence and delivery. Jev defaults to a 1,300 ms stage timeout;
local retrieval and the receipt reserve reduce its actual allowance below that
ceiling under the default foreground deadline. The host Hook
limit remains two seconds. See [ADR-0144](../../docs/adr/0144-extend-jev-and-foreground-timeouts.md).

## Invariants and change risks

Preserve project scope, lifecycle/working-set eligibility and relevance gates. Automatic hook retrieval has a deadline and cannot block on background extraction. Explicit recall and automatic injection have different budgets and model paths.

Automatic exact-term evidence trims trailing periods and colons before matching, preserving
internal API, filename, path and error-code structure. Common prose/configuration words cannot
become strong singleton anchors through capitalization or rarity alone. They remain eligible
for lexical and corroborated multi-term matching; this is not a stop-word filter or a change to
embedding inputs, semantic thresholds, term weights or contextual recall. See
[ADR-0134](../../docs/adr/0134-normalize-automatic-exact-term-boundaries.md).

## Verification

Run from the repository root:

```sh
pnpm exec vitest run tests/integration/retrieval tests/fault/automatic-retrieval.test.ts tests/fault/foreground-deadline-cancellation.test.ts tests/contract/progressive-recall.test.ts
pnpm exec vitest run tests/contract/jev-relevance.test.ts
```

Check these test scenarios before changing behavior.

## Design references

Use [CONTEXT.md](../../CONTEXT.md) for domain vocabulary, [SPEC.md](../../SPEC.md) for product contracts and the [ADR directory](../../docs/adr/) for decision history. Update this guide when responsibilities, state ownership or verification paths change.
