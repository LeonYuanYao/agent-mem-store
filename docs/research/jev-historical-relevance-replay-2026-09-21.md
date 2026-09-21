# Jev historical relevance replay

Date: 2026-09-21. Model: `jev-1.13.0`. Status: offline evaluation completed; production retrieval unchanged.

## Conclusion

Jev substantially reduced irrelevant candidates in a sanitized replay of local retrieval results. At the predeclared threshold of 0.5, it retained 23 of 26 clearly relevant items and removed 56 of 58 irrelevant items. It retained 12 of 24 borderline items. All 15 queries with a clearly relevant candidate retained at least one.

The useful-item losses are material: supporting environment information can receive low scores even when it helps an agent complete the task. A threshold of 0.4 recovered one relevant item and four borderline items without adding irrelevant items in this sample. Treat 0.4 as a candidate for further validation, not an established production threshold.

The evidence supports a bounded integration prototype after local retrieval. Production activation still requires an end-to-end deadline/fallback test, a supported privacy policy for external requests, and evaluation on fresh cases. This study does not establish improved corpus recall, ranking quality, factual correctness, or current live-system precision.

## 1. Data and controls

- The source was a frozen local-retrieval replay generated on 2026-09-16. It used real E5 q8 queries and the Plan A ranking/packing algorithm against a fixed index, reconstructed up to three previous user prompts, empty structured signals, and a fresh context epoch without repeat suppression. This evaluation reused that output without accessing or changing the live Vault or database.
- Before inference, an allowlist selected 41 queries: 27 historical user requests and 14 regression controls. Their local result packs contained 108 candidates: 26 relevant, 24 borderline, and 58 irrelevant. Four historical queries had no local candidates and caused no Jev request.
- The historical-only subset contained 60 pairs: 17 relevant, 18 borderline, and 25 irrelevant. Controls were analyzed separately because they deliberately include difficult negatives and do not represent daily traffic.
- Labels came from an earlier assistant review, before this experiment's model scores existed. One newly present candidate was labeled before inference: a dependency-installation rule was irrelevant to changing the npm registry. Labels were not revised after observing Jev outputs. They are not independent human ground truth.
- URLs, private paths, addresses, email, opaque identities, long identifiers, and identifying names were removed or pseudonymized. The complete resulting payload set was inspected locally before submission. Only cleaned query text, short user context, compact candidate text, and numeric memory references were sent. Credential values and raw transcripts were not sent as model inputs.
- Some technical identifiers and context were generalized. This can change relevance judgments, especially for environment details. Sanitization is a limitation of this replay and does not establish a production-grade privacy filter.
- The same Noul question and criteria from the [synthetic experiment](jev-relevance-feasibility-experiment-2026-09-21.md) were used. Each candidate received an independent question within a shared query/context request. Labels and expected decisions were omitted. Original candidate order was retained after filtering.
- The primary threshold remained 0.5. Other thresholds are exploratory comparisons on the same scores. There is no new independent holdout validating a selected threshold.
- Each process sent sequential requests with a 10-second experimental timeout and no retries. The repeat and no-history processes overlapped in time. No production Hook, Worker, configuration, candidate lifecycle, or memory content changed.

The baseline is the frozen local result pack, not all embedding neighbors and not today's live retrieval. The index can contain memories written after a historical request, including knowledge learned from that request. Consequently, these results measure candidate usefulness for reconstructed requests; they do not reproduce what an agent could have known at the original timestamp.

## 2. Candidate retention

| Policy | Relevant retained / 26 | Borderline retained / 24 | Irrelevant retained / 58 | Total retained | Irrelevant share of retained items |
| --- | --- | --- | --- | --- | --- |
| Existing local replay pack | 26 | 24 | 58 | 108 | 53.7% |
| Jev >= 0.3 | 24 | 17 | 6 | 47 | 12.8% |
| Jev >= 0.4, exploratory | 24 | 16 | 2 | 42 | 4.8% |
| Jev >= 0.5, primary | 23 | 12 | 2 | 37 | 5.4% |
| Jev >= 0.6 | 22 | 9 | 1 | 32 | 3.1% |
| Jev >= 0.7 | 15 | 4 | 0 | 19 | 0% |

At 0.5, clearly relevant retention was 88.5% and irrelevant removal was 96.6%. The historical-only subset retained 15/17 relevant, 9/18 borderline, and 1/25 irrelevant items. Its irrelevant share fell from 41.7% to 4.0% within the selected replay sample.

At 0.4 and 0.5, none of the 15 queries with a clearly relevant candidate lost all such candidates. At 0.5, total empty results increased from 4 to 21; this includes queries with only irrelevant or borderline candidates, so it is not proof that every newly empty result is desirable. At 0.7, six queries lost all clearly relevant candidates; four became entirely empty and two retained only borderline material.

Borderline includes supporting, conditional, or merely adjacent information. Retaining all borderline items would overstate quality; rejecting all of them would overstate noise removal. They remain a separate category throughout the report.

## 3. Disagreements

| Request | Candidate judged differently from frozen label | Label | Score |
| --- | --- | --- | --- |
| Continue reviewing Skills | Delivery requirements for a specific unit-test auditing workflow | Irrelevant | 0.60 |
| Add or verify an agent installation guide in README | Repository rename and clone-address update | Relevant | 0.13 |
| Audit the main agent instructions and referenced Skills | Canonical directory for the installed Skills | Relevant | 0.48 |
| Configure npm's default registry | A registry override for a particular product build | Irrelevant | 0.51 |
| Set the user's registry to the corporate registry | Existing default-registry configuration | Relevant | 0.26 |

Two retained items confuse a nearby workflow with the requested task. The rejected items show weaker recognition of supporting environment and documentation facts. The repository rename may be optional background rather than essential installation guidance; that ambiguity is retained in the results instead of relabeling the case to improve metrics. Private-path and URL substitutions can also weaken the environment cases.

There is a separate candidate-coverage limit. One package-registry control received only unrelated build memories from local retrieval. Jev rejected both, but could not supply the missing registry instruction. Similarly, a platform follow-up lacked the direct platform preference in its local pool. A filter cannot recover a memory it never receives. Expanding the shortlist or testing reranking is a separate experiment.

## 4. Context and repeated requests

Twelve preselected pools, containing 48 pairs, were repeated unchanged. Two borderline items crossed the 0.5 decision boundary: 0.52 to 0.44 and 0.51 to 0.49. No clearly relevant or irrelevant item changed its binary decision. The model should still be treated as nondeterministic.

A paired comparison removed recent user context from 22 historical requests, keeping their 54 candidates unchanged:

| Same 22-query subset, threshold 0.5 | Relevant retained / 15 | Irrelevant retained / 25 | Queries losing all relevant candidates |
| --- | --- | --- | --- |
| With short user context | 14 | 1 | 0 |
| Current request only | 11 | 4 | 2 |

These observations support retaining bounded recent user context, especially for continuation requests. They do not justify sending a full session transcript. One observation per variant, plus measured repeat variability, is insufficient to assign every score difference solely to context.

## 5. Latency and cost

| Phase | API requests | Median | p95 | Maximum |
| --- | --- | --- | --- | --- |
| Primary replay | 37 | 275 ms | 595 ms | 658 ms |
| Repeated subset | 12 | 285 ms | 738 ms | 738 ms |
| Context omitted | 22 | 308 ms | 775 ms | 801 ms |
| Combined | 71 | 286 ms | 723 ms | 801 ms |

All 71 calls succeeded. They consumed 81,838 input tokens and 3,854 output tokens, or **85,692 total tokens**. Using the input-only price recorded in the [official capability review](jev-system-one-official-capabilities-2026-09-21.md), USD 0.042 per million input tokens, estimated cost was **USD 0.003437196**. This is response-usage arithmetic, not a billing-statement reconciliation.

These timings include HTTP response decoding but exclude local retrieval, IPC, receipt persistence, and Hook startup. Candidate packs contained one to six items. All calls completed within one second; two exceeded 750 ms. The sample is too small and short-lived to characterize service/network tail latency. Initial calls in each process were slower.

The [foreground client](../../src/retrieval/foreground-client.ts) currently gives the entire foreground request 1,000 ms. An API call approaching 800 ms does not establish end-to-end compliance. A future prototype must allocate remote time from the actual remaining deadline and preserve enough time to return a previously prepared local result. No offline, quota-exhaustion, cancellation, malformed-response, or retry behavior was tested in this replay.

## 6. Recommended next implementation boundary

1. Keep local scope, authority, lifecycle, sensitivity, retrieval, and token-budget controls. Run Jev only on an eligible bounded shortlist; do not send an entire Vault or session.
2. Initially filter while preserving local ranking. Test 0.4 as a provisional candidate on fresh cases before making it the active default. Measure supporting-information retention separately. This experiment does not validate score-based reranking.
3. Include bounded recent user context. Direct memory-ID requests should be resolved by identity and existing access rules, without giving a semantic filter authority to veto the explicitly requested item.
4. Prepare the existing eligible local result before remote work. Use a deadline bounded by the remaining foreground time. On network failure, rate limiting, unavailable quota, invalid output, or timeout, return that local result without synchronous retries. A successful judgment that rejects all candidates should remain an empty result.
5. Keep external submission opt-in and enforce an independently reviewed privacy boundary. The manual cleaning performed here is not ready to run unattended. Unsupported or uncertain payloads should stay local.
6. Before activation, test the integrated total deadline and fallback paths, then assess fresh requests without changing actual injection. Record reason codes, elapsed time, candidate decisions, and usage without storing credentials or unnecessary prompt bodies.

This is a recommendation for the next reviewed stage, not an activated configuration or completed production adapter.

## 7. Local evidence

Temporary artifacts are in the enclosing workspace's ignored `tmp/` directory. They are intentionally excluded from the public repository:

- `memstore-jev-real-prepare.mjs` and `memstore-jev-real-fixture.json`: allowlist, cleaning, frozen labels, and sanitized cases.
- `memstore-jev-real-run.mjs`: bounded HTTP runner.
- `memstore-jev-real-{primary,repeat,nohistory}.json`: probabilities, usage, and timing.
- `memstore-jev-real-analyze.mjs` and `memstore-jev-real-analysis.json`: reproducible metrics and disagreements.

Fixture SHA-256: `3caba0d44d7f68dae2488f9a9f7ddfa21728f35f01b05137c3600bbd8fcf707f`.

The experiment scripts passed syntax checks and aggregate assertions. Repository application tests were not rerun because no application code changed. Production remains on its existing local retrieval behavior.
