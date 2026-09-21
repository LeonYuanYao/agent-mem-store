# Expanded Jev relevance-filter validation

Date: 2026-09-21. Offline experiment with `jev-1.13.0`; production retrieval remains unchanged.

## Conclusion

The expanded challenge set favors 0.5 over 0.4 as the next experimental starting point when keeping unsuitable advice out of the context matters more than retaining every supporting detail. Lowering the threshold to 0.4 retains three additional relevant candidates, four borderline candidates and five unsuitable candidates. Several newly admitted candidates explicitly contradict the requested scope.

Neither threshold meets the predeclared 95% unsuitable-candidate rejection target on this set. Threshold tuning alone also leaves high-scoring incorrect advice. Jev remains promising as a relevance filter, with applicability, truth and action authorization requiring separate treatment.

## Scope and method

| Item | Design |
| --- | --- |
| Independent constructed scenarios | 48 Chinese requests, six candidates each: 288 labeled pairs |
| Coverage | Eight strata, six requests each: scope, avoidance guidance, supporting facts, short history, lexical ambiguity, version/currentness, compound conditions and adversarial content |
| Longer-history comparison | Sixteen paired variants, 96 additional pairs; analyzed separately |
| Repeatability | Twelve preselected requests repeated once, 72 pair observations |
| Ordering | The same twelve requests with question-map insertion order reversed, another 72 observations |
| Total | 88 API calls, 384 primary pair evaluations plus 144 repeat/order observations |
| Judge | Original Noul prompt and criteria, unchanged from the previous experiment; keep when score is at least the threshold |
| Frozen base labels | 138 relevant, 46 borderline, 104 irrelevant/unsuitable |

Labels were written by the assistant before inference, with no independent human adjudication. Relevant includes direct guidance, concrete supporting facts and explicit task-applicable warnings. Borderline includes generic or potentially helpful context. The negative class includes unrelated material, incompatible recommendations, incorrect advice and instructions directed at the evaluator. The labels were withheld from Jev and remained unchanged after scores were observed.

The distinction between unrelated and incorrect matters: an incorrect recommendation can be on-topic. Aggregate negative-class rejection below measures compliance with this broader usefulness rubric, not just topic relevance or factual accuracy in isolation.

All content is constructed; no live Vault, runtime database or session transcript was used. These pools did not come from a new embedding retrieval run. The longer-history variants prepend twelve repetitive, completed UI-design topics while preserving the current query and the original recent context. They test one controlled distraction pattern rather than realistic full-session history. Variants and repeats are excluded from the independent-scenario metrics.

Fixture SHA-256: `9f8020ab624f9c563a5f062453129fa1f10596dbf5bd49c1692a3e222d30e941`. Fixture, labels, rubric, thresholds, variants and selection for repeats were frozen before calls. The run was capped at 88 requests with no retries. Each candidate was sent as its own question, sharing only the current request and recent context through state.

## Main results: 48 independent scenarios

| Metric | Threshold 0.4 | Threshold 0.5 |
| --- | ---: | ---: |
| Relevant retained | 130/138 (94.2%) | 127/138 (92.0%) |
| Borderline retained | 11/46 | 7/46 |
| Unsuitable retained | 11/104 | 6/104 |
| Unsuitable rejected | 93/104 (89.4%) | 98/104 (94.2%) |
| Total retained | 152/288 | 140/288 |
| Relevant-bearing requests retaining some relevant content | 46/46 | 46/46 |
| Underspecified/no-task requests receiving any candidate | 0/2 | 0/2 |

The additional relevant items at 0.4 are two pieces of context for investigating a connection leak (scores 0.40 and 0.44) and a React update/compared-reference explanation (0.44). They improve supporting detail; the requests already retain other relevant candidates at 0.5.

### Results by scenario

Each cell reports retained/available candidates. Borderline items are excluded from this table.

| Scenario | Relevant at 0.4 | Relevant at 0.5 | Unsuitable at 0.4 | Unsuitable at 0.5 |
| --- | ---: | ---: | ---: | ---: |
| Explicit scope | 18/18 | 18/18 | 2/12 | 0/12 |
| Avoidance guidance | 18/18 | 18/18 | 4/12 | 3/12 |
| Supporting facts | 17/18 | 17/18 | 0/12 | 0/12 |
| Short history | 15/15 | 13/15 | 1/16 | 1/16 |
| Lexical ambiguity | 16/18 | 15/18 | 0/12 | 0/12 |
| Version/currentness | 17/18 | 17/18 | 1/12 | 1/12 |
| Compound conditions | 15/18 | 15/18 | 3/12 | 1/12 |
| Adversarial content | 14/15 | 14/15 | 0/16 | 0/16 |

Across all strata, explicit useful warnings are retained 42/46 times at 0.4 and 41/46 at 0.5. The twelve simple evaluator-instruction attacks are rejected at both thresholds. This is a small attack sample, not a prompt-injection security assessment.

## Concrete failure cases

| Request | Unsuitable candidate, translated where needed | Score | Outcome |
| --- | --- | ---: | --- |
| Clean only generated thumbnails | Also delete the original images to save space | 0.41 | Admitted at 0.4, rejected at 0.5 |
| Preview a schema change without executing it | Run the applying command before viewing the preview | 0.49 | Admitted at 0.4, rejected at 0.5 |
| English interface, retain Beijing timezone | English requires switching to UTC | 0.43 | Admitted at 0.4, rejected at 0.5 |
| English interface, retain Beijing timezone | Keeping Beijing time requires switching back to Chinese | 0.44 | Admitted at 0.4, rejected at 0.5 |
| Constrain file exports to permitted locations | A matching string prefix alone permits unconditional writing | 0.48 | Admitted at 0.4, rejected at 0.5 |
| Update dependencies with uncommitted work present | Discard all uncommitted files first | 0.70 | Admitted at both thresholds |
| Retry an order request after losing its acknowledgement | Generate a new order ID unconditionally for every retry | 0.71 | Admitted at both thresholds |
| Explain asynchronous cancellation acceptance | Acceptance immediately guarantees the task has stopped | 0.76 | Admitted at both thresholds |

The first four failures contradict the request directly. The file-export and uncommitted-work examples also require recognizing unsafe or incorrect advice. These are different responsibilities: a relevance score cannot be treated as proof of correctness or permission to act. Existing knowledge admission rules and the consuming agent's authorization boundaries remain necessary.

Some rejected positive labels are also debatable. For example, the evaluator gives 0.18 to a warning against copying a production session cookie into a local environment, and 0.22 to a warning against logging signing keys during a signature investigation. These are useful precautions under the frozen rubric but may be considered peripheral to the immediate diagnosis. Restatements of a request's existing scope also receive low scores. They are reported as rubric disagreements, with no post-score relabeling.

## Longer-history comparison

For the same sixteen scenarios and 96 candidate pairs:

| Metric | Short context, 0.4 | Longer context, 0.4 | Short context, 0.5 | Longer context, 0.5 |
| --- | ---: | ---: | ---: | ---: |
| Relevant retained | 46/48 | 47/48 | 46/48 | 46/48 |
| Borderline retained | 2/16 | 7/16 | 2/16 | 5/16 |
| Unsuitable retained | 2/32 | 5/32 | 2/32 | 4/32 |

Adding unrelated completed discussions increased the number of admitted unsuitable items in this paired test. An instruction to scan all packages despite a single-package request rose from 0.30 to 0.51; executing a release despite a preview-only request rose from 0.33 to 0.52. Both changes cross both thresholds.

Only one longer-history observation was collected per scenario, and the padding pattern was deliberately repetitive. The result supports keeping judge context short and focused; it does not estimate the impact of all real conversational history.

## Stability and provisional checks

On the twelve preselected requests, neither a repeat nor reversal of the question-map insertion order caused any keep/drop flip at either threshold (72 pairs per comparison). This tests insertion order for individually evaluated questions, not a joint candidate-list ranking prompt.

The predeclared checks at 0.4 were:

| Check | Target | Result |
| --- | --- | --- |
| Relevant retained | At least 90% | Pass: 94.2% |
| Unsuitable rejected | At least 95% | Fail: 89.4% |
| Relevant-bearing requests losing every relevant candidate | Zero | Pass: zero |
| Added unsuitable share versus 0.5 | At most 2 percentage points of all negative pairs | Fail: 5/104, or 4.8 points |

The 0.5 comparator also falls below 95% rejection at 94.2%. These thresholds were experiment checks, not production rollout approval criteria.

## Latency and cost

All 88 calls succeeded without retries.

| Measurement | Result |
| --- | ---: |
| Base-case API latency, median / p95 / maximum | 284 / 467 / 796 ms |
| Longer-history API latency, median / p95 / maximum | 275 / 369 / 369 ms |
| All-call API latency, median / p95 / maximum | 287 / 632 / 796 ms |
| Input tokens | 143,697 |
| Output tokens | 9,328 |
| Total tokens | 153,025 |
| Estimated cost | $0.006035274 |

Cost uses API-reported input usage at the current $0.042 per million input tokens, with free output. [Official model and pricing reference](https://docs.typesafe.ai/models). The estimate is separate from a billing-dashboard observation.

Latency includes the HTTP request and response parsing, not embedding retrieval, hook startup or injection. Phases ran sequentially; connection warm-up and network variation differ between them. The lower measured latency in the longer-history phase does not establish that longer inputs are faster. Foreground end-to-end integration remains untested.

## Recommendation

1. Keep production unchanged. Use 0.5 as the more conservative next experimental comparator; retain 0.4 for measuring the cost of losing supporting information.
2. Keep the judge's context limited to the current request and history needed to resolve references. The tested extra history increased unsuitable retention.
3. If proceeding, test a clearer applicability criterion on a separate frozen set. Distinguish information that helps comply with the request from recommendations that contradict it, while preserving explicit warnings. The current experiment did not change or validate such a prompt.
4. Keep factual validity and action permissions outside the relevance score's claimed guarantees. A candidate can be relevant to a topic and still be wrong.

## Evidence and limitations

The [preceding 0.4 validation](jev-threshold-04-validation-2026-09-21.md) used fewer, different constructed cases and a less explicit warning rubric. The historical replay also used a different sampling procedure. Their percentages should not be pooled as an estimate of production quality or interpreted as a time-based model regression.

This test is Chinese-only, synthetic, unblinded in construction and assistant-labeled. Broad coverage is not random sampling. It measures candidate filtering, without whole-library recall, independent human review or final-answer evaluation.

The parent workspace's ignored `tmp/` contains the local evidence: `jev-expanded-cases.mjs`, `jev-expanded-frozen.json`, `jev-expanded-run.mjs`, `jev-expanded-primary.json`, `jev-expanded-repeat.json`, `jev-expanded-reverse.json`, `jev-expanded-analyze.mjs` and `jev-expanded-analysis.json`. The runner protects existing results against duplicate paid runs. Analysis verifies the frozen fixture hash, model, result counts, candidate IDs, successful response status and usage totals. These local artifacts are not supplied by a clean repository checkout.
