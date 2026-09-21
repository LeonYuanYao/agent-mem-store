# Jev post-retrieval relevance experiment

Date: 2026-09-21. Model: `jev-1.13.0`. Status: completed offline experiment; no production activation.

Follow-up: the [sanitized historical replay](jev-historical-relevance-replay-2026-09-21.md) is now complete. It reports actual local-result-pack filtering separately from the synthetic metrics below.

## Conclusion

Jev is promising as a bounded relevance filter after local retrieval. In 40 synthetic query pools, a predeclared probability threshold of 0.5 retained 50 of 53 positive-labeled items and removed 118 of 122 negative-labeled items. All 38 queries containing a positive-labeled item retained at least one. Both deliberately empty-answer queries remained empty.

This supports proceeding to an approved, sanitized replay of actual retrieval results. It does not establish production precision, corpus recall, improved Top-N ranking, or compliance with the complete Hook deadline. No embedding search was executed in this experiment: the candidate pools were constructed to test the judgment stage in isolation.

## 1. Scope and method

- The assistant authored 40 synthetic query pools and all labels before calling Jev. There were 175 query-memory pairs: 53 positive and 122 negative. The queries included 28 Chinese/mixed-language requests and 12 English requests. Most candidate text in the primary set was English.
- Cases cover package registries, project identity, submodules, offline fallback, retention, capture, compact text, human authority, negation, context-dependent follow-ups, unrelated same-word matches, and two simple instruction-injection examples.
- The first 20 cases were designated development and the remaining 20 holdout before inference. The prompt and primary threshold were not tuned after examining either group. The same assistant authored both groups; they are not independent human evaluations.
- Positive means useful for the specified task, including some supporting checks and explanations. Negative means unrelated, merely topical, or inappropriate for the explicit environment or condition. Some contrastive explanations make this binary distinction debatable; labels remain unchanged in the reported metrics.
- Each request sends the user query and optional short context as shared state. Each candidate is attached to a separate Noul question with the same relevance criteria. Labels, production identities, and expected decisions are omitted from requests.
- The primary threshold was fixed at 0.5. Other thresholds are exploratory sensitivity checks, not selected production settings. The keep-all comparison retains the supplied synthetic pool; it is not the existing MemStore retrieval algorithm.
- Requests were sequential, used the documented HTTP endpoint, had a 10-second experiment timeout, and did not retry automatically. Results validate the resolved model, token usage, and each probability's type and range.
- Only synthetic content was sent. No Vault text, original session transcript, production receipt, or real project identifier was submitted. The credential was used only in the official endpoint's authorization header and was not printed or saved in artifacts.

The request format follows the [official API](https://docs.typesafe.ai/api). Noul returns a probability rather than an independent confidence field; see [primitives](https://docs.typesafe.ai/primitives).

## 2. Primary results

| Policy | Useful retained / 53 | Negative-labeled retained / 122 | Precision against frozen labels | Useful retention | Queries incorrectly made empty |
| --- | --- | --- | --- | --- | --- |
| Keep entire constructed pool | 53 | 122 | 30.3% | 100% | 0 |
| Noul >= 0.3 | 51 | 14 | 78.5% | 96.2% | 0 |
| Noul >= 0.5, primary | 50 | 4 | 92.6% | 94.3% | 0 |
| Noul >= 0.7 | 43 | 2 | 95.6% | 81.1% | 3 |
| Noul >= 0.8 | 37 | 2 | 94.9% | 69.8% | 5 |
| Noul >= 0.9 | 18 | 0 | 100% | 34.0% | 20 |

At 0.5, the development group retained 28/31 positive items and 1/60 negative items. The holdout group retained 22/22 positive items and 3/62 negative items. These samples are small and deliberately contain many obvious distractors. The keep-all precision must not be presented as MemStore's current precision.

Raising the threshold to 0.7 removes two more negative-labeled items but loses seven more positive-labeled items. The current evidence does not justify a high confidence cutoff as a default.

## 3. Disagreements worth investigating

The three positive-labeled items rejected at the primary threshold were supporting information:

| Request | Rejected supporting information | Probability |
| --- | --- | --- |
| Change the default npm registry | The command to inspect the configured registry | 0.36 |
| Determine the memory project for a submodule | Notify the user when inheriting the parent project | 0.15 |
| Explain whether a sensitivity summary is a knowledge-review queue | Quarantine metadata does not store suspected credential values | 0.09 |

The retained negative-labeled items were:

| Request | Retained item | Probability |
| --- | --- | --- |
| Explain identity for same-basename Git checkouts | Non-Git root identity rule | 0.84 |
| Change sensitivity metadata retention to fifteen days, given prior context | Archived memory body retention is three months | 0.60 |
| Use a registry for one installation without changing the default | The command that changes the persistent default | 0.89 |
| Explain whether private cross-project memories can be automatically injected | Explicit session migration to another project | 0.52 |

Some retained items could support a contrastive explanation rather than the requested action. A future real-data review should distinguish direct answers, useful supporting material, contrastive warnings, and unrelated material. These disagreements are not proof that every retained item would harm an agent's answer. Conversely, high scores such as 0.84 and 0.89 show that a score alone does not enforce applicability.

Two simple adversarial-memory cases did not cause their instruction-bearing distractors to be selected. This is a small sanity check, not a prompt-injection security assessment.

## 4. Chinese and repeated-call checks

After the primary run, ten selected pools were translated into Chinese without changing their labels. This supplementary set contains 44 pairs and intentionally includes boundary cases; it is not another independent holdout.

| Matching ten-pool subset at threshold 0.5 | Useful retained / 14 | Negative-labeled retained / 30 | Precision | Useful retention |
| --- | --- | --- | --- | --- |
| Original candidate wording | 11 | 3 | 78.6% | 78.6% |
| Chinese candidate wording | 12 | 3 | 80.0% | 85.7% |

The Chinese variant recovered the registry-inspection supporting item, while still rejecting the submodule-notification and quarantine-value explanations. It retained the same three kinds of inappropriate or contrastive material. This small paired result does not establish general Chinese/English parity.

Ten selected original pools, totaling 45 pairs, were also repeated with identical instructions. No decision crossed the 0.5 threshold. The largest probability change was 0.08. Repeat stability in this sample does not guarantee deterministic output.

## 5. Measured latency and cost

Measurements cover the HTTP call through response-body decoding from the experiment machine. They exclude local embedding, receipt persistence, Hook startup, IPC, and rendering. They were collected in one short sequential run, without offline or overload simulation.

| Phase | Requests | Median | p95 | Maximum |
| --- | --- | --- | --- | --- |
| Primary, 4–5 candidates/request | 40 | 305 ms | 351 ms | 750 ms |
| Repeated subset | 10 | 255 ms | 599 ms | 599 ms |
| Chinese translations | 10 | 252 ms | 612 ms | 612 ms |

An additional size check used one query with three requests per size. The same useful items were retained at each size:

| Candidates/request | Input tokens/request | Observed latency range |
| --- | --- | --- |
| 5 | 1,203 | 334–806 ms |
| 20 | 3,899 | 307–385 ms |
| 30 | 5,738 | 303–374 ms |

The size test ran 5-item requests first, followed by 20 and then 30. Initial requests in each independent process were slower. Warm connection effects, service behavior, and input size are therefore confounded; the test does not show that larger batches are faster. Three observations per size cannot characterize tail latency.

All 70 API calls succeeded: one smoke request, 40 primary requests, ten repeats, nine size checks, and ten Chinese checks. The responses reported **99,668 input tokens**. At the [published price](https://docs.typesafe.ai/models) of USD 0.042 per million input tokens and free output, the estimated total is **USD 0.004186056**. This is arithmetic from reported usage, not a billing-statement verification.

No API call exceeded one second in this sample. The maximum was 806 ms, leaving little margin inside MemStore's one-second total foreground request budget. A future automatic integration must reserve local processing time, abort remote work before the total deadline, and return the existing eligible local result when the judge is unavailable. Failure recovery and quota exhaustion were not exercised here.

## 6. Artifacts and next step

Temporary artifacts remain in the enclosing workspace's ignored `tmp/` directory:

- `memstore-jev-relevance-cases.mjs`: frozen primary cases and labels.
- `memstore-jev-relevance-chinese.mjs`: supplementary translations.
- `memstore-jev-relevance-run.mjs`: bounded HTTP experiment runner.
- `memstore-jev-relevance-{smoke,primary,repeat,scaling,chinese}.json`: scores, usage, and latency; no credential.
- `memstore-jev-relevance-analyze.mjs` and `memstore-jev-relevance-analysis.json`: metrics and disagreements.

Primary fixture SHA-256: `2a75722c4edfd656cb34f0a9e483a4a1fe81ad8d4c79917f5e581a80e5588a4d`.
Question-instruction SHA-256: `c53dfa22a14921c7266acccb57a0cb3e5b649c9ccf41326d44836a64b2a622ad`.

Recommended next step: evaluate safely submitted or sanitized actual query-candidate pairs with graded relevance labels and the same local candidate pool. Measure both useful supporting-information loss and noise removal. Keep the current local retrieval as the production behavior until that review and a separate end-to-end deadline/fallback test pass. No code, Hook configuration, knowledge content, or production lifecycle state changed during this experiment.
