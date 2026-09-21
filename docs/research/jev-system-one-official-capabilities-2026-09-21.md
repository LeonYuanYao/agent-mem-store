# Jev / System One: official capabilities and MemStore feasibility

Research date: 2026-09-21. Status: research note, not an implementation decision or authorization. Sources are current first-party documentation and published vendor examples. No credentials, user memories, authenticated endpoints, paid inference, or production state were accessed. Documentation statements are verified as published; model quality and latency were not independently measured.

## Conclusion

Jev is technically suitable for an optional query-candidate relevance filter or reranker after local retrieval. TypeSafe publishes this exact pattern. Its public interface returns typed judgments; it exposes neither reusable embedding vectors nor ordinary text generation. Local embedding and lexical retrieval should continue to produce the shortlist and remain available when remote judgment is unavailable. [Introduction](https://docs.typesafe.ai/introduction), [reranking cookbook](https://docs.typesafe.ai/cookbooks/rerank_typesafe)

There is insufficient evidence to claim that Jev improves MemStore's Chinese/English coding-memory retrieval, meets the automatic-hook deadline, or can safely replace the existing local path. These require separately authorized evaluation and a decision about sending memory content to an external service.

## 1. Public interface

The HTTP endpoint is `POST https://api.typesafe.ai/v1/systemone`, authenticated with a bearer API key. Required fields are `model`, `state`, and a named `questions` map. State accepts text, objects, or arrays. Responses contain the resolved model, answers under matching question IDs, and input/output token usage. Question IDs do not participate in inference. Choice allows at most 255 options; Score accepts 2–10 ordered levels. [HTTP API](https://docs.typesafe.ai/api)

Illustrative request, not executed:

```json
{
  "model": "jev-1.13.0",
  "state": {
    "query": "How should a failed retrieval request degrade?",
    "candidate": "Preserve the local retrieval result when the remote judge fails."
  },
  "questions": {
    "relevant": {
      "type": "noul",
      "instructions": "Does candidate directly help answer query?",
      "criteria": {
        "true": "Provides applicable information for the specific question.",
        "false": "Unrelated or merely shares terminology."
      }
    }
  }
}
```

The three primitives have different meanings:

| Primitive | Output | Retrieval use |
| --- | --- | --- |
| Noul | Estimated probability of yes, between 0 and 1 | Independently score each candidate against the query |
| Choice | Selected option and probabilities | Select among a supplied closed set |
| Score | Probability-weighted score over descriptive levels | Evaluate a defined relevance rubric |

Choice and Score also provide confidence; Noul does not. Confidence is computed from the answer distribution and is not an independent verification of correctness. Thresholds need validation for the task and model version. [Confidence](https://docs.typesafe.ai/confidence), [Score](https://docs.typesafe.ai/primitives/score)

The JavaScript package is `@typesafe-ai/sdk`; Python support is also documented. An SDK is optional because the HTTP contract is public. [JavaScript SDK](https://docs.typesafe.ai/sdk/javascript), [client SDKs](https://docs.typesafe.ai/sdk)

## 2. Current model, limits, and cost

The following is the published model-specific snapshot, not an account entitlement check. [Models](https://docs.typesafe.ai/models)

| Property | Published value |
| --- | --- |
| Stable model | `jev-1.13.0` |
| Aliases | `jev-latest` and `jev-preview` currently resolve to the same version |
| Input price | USD 0.042 per million tokens, equivalent to USD 42 per billion |
| Output price | Free |
| Request budget | 64k tokens for state and all questions combined |
| Per-question budget | State plus the longest question must fit 32k tokens |
| Rate limits | 250,000 tokens/second and 1,200 requests/minute |
| Modalities | Text only; no image, audio, or video input |

The vendor explicitly says rate limits are changing dynamically and may change without notice. Higher custom/enterprise limits require arrangement. Aliases can change answers after a release; version pinning is appropriate for calibrated thresholds. No daily/monthly credit allowance, current account balance, or exhausted-credit error contract was established from these public pages. [Models](https://docs.typesafe.ai/models)

Illustrative arithmetic: 50 separately scored pairs at 1,000 billed input tokens each would cost approximately USD 0.0021 per retrieval. Actual billing depends on serialized input, instructions, repeated context, and retries. This is a cost calculation, not a measured MemStore request.

## 3. Reranking and batching evidence

The official reranking example first uses BM25 to select 30 passages, then submits one query-passage pair per request with a Noul question and sorts candidates by the returned value. Its historical `jev-1.12` example uses 40 legal queries over 3,565 passages: reported top-1 accuracy increases from 5% to 18%, and top-10 from 38% to 62%. The 1,200 calls report 1,536,002 input tokens and USD 0.0645. These are vendor-example results on a small legal dataset, not evidence for current Jev on MemStore. Reranking cannot recover candidates missing from the shortlist. [Reranking cookbook](https://docs.typesafe.ai/cookbooks/rerank_typesafe)

Multiple independent questions can share one state and run in parallel. The vendor says additional questions usually add little latency. This batches judgments over shared input; it does not establish an asynchronous bulk-job API or a batch discount. Putting candidate-specific content in structured questions is supported by the request format, but candidate packing still needs evaluation against context limits and distractor effects. A separate maximum question count was not established. [Fan-out pattern](https://docs.typesafe.ai/patterns/fan-out), [structured questions](https://docs.typesafe.ai/primitives/advanced)

## 4. Latency, failures, and fallback

The homepage advertises 193.6 times faster and 444.6 times cheaper on selected System One workflows and shows a 0.114-second example. These are vendor marketing/benchmark claims. They provide no MemStore latency guarantee or demonstrated p95/p99 under the user's network and concurrency. [TypeSafe homepage](https://typesafe.ai/)

The API documents `401` for authentication, `422` for invalid requests, `429` for rate limits, and `529` for temporary overload. It recommends exponential backoff for the latter two. A quota-exhaustion response cannot be assumed identical to temporary throttling without further evidence. [HTTP API errors](https://docs.typesafe.ai/api#errors)

The JavaScript SDK defaults to a 10,000 ms timeout per attempt with no total retry deadline. It retries twice after the initial attempt, including connection failures, timeouts, `408`, `429`, and `500–599`, with initial backoff of 500 ms. Per-call cancellation also stops pending retries. Default behavior therefore does not fit a roughly one-second foreground budget. A proposed integration needs an explicit total deadline, bounded or disabled retries, and immediate local fallback. [Client configuration](https://docs.typesafe.ai/sdk/javascript/api/interfaces/TypeSafeClientConfig), [retry policy](https://docs.typesafe.ai/sdk/javascript/api/interfaces/RetryPolicy), [request options](https://docs.typesafe.ai/sdk/javascript/api/interfaces/RequestOptions)

## 5. Quality and privacy constraints

English is the primary training language; the vendor says other languages, including CJK, perform less well and require workload-specific testing. [Language support](https://docs.typesafe.ai/models#language-support)

Documented weaknesses include literal interpretation, negation/indirection, numerical precision, dates, irrelevant large state, and adversarial input that can steer decisions. The vendor recommends retrieving/filtering first and sending only relevant fields. Separate question types and negated questions do not guarantee algebraically consistent probabilities. Generation is explicitly outside the model's intended capability. [Jev 1.13 limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13)

The privacy policy commits not to train or fine-tune on prompts/input. It permits processing by service providers, identifies U.S. hosting, and describes retention in terms of reasonable necessity rather than a fixed number of days. A no-training commitment does not establish zero retention. [Privacy policy](https://typesafe.ai/legal/privacy-policy)

Zero data retention is offered for enterprise customers and requires discussion with the vendor; it is not established as the default for a standard API account. [Legal documentation](https://docs.typesafe.ai/legal)

The JavaScript SDK's debug logging includes request/response bodies without body redaction, even though recognized credential headers are redacted. Avoid enabling that logging for memory contents. [Client configuration](https://docs.typesafe.ai/sdk/javascript/api/interfaces/TypeSafeClientConfig)

## 6. MemStore mapping and next decision

Current code inspection shows distinct integration surfaces:

- [Automatic pack retrieval](../../src/retrieval/packs.ts) combines local lexical and embedding evidence before selecting memories.
- [Foreground client](../../src/retrieval/foreground-client.ts) uses a bounded socket request deadline; the current default is 1,000 ms.
- [Explicit recall](../../src/retrieval/recall.ts) can call an optional judge after local selection. It validates retained identities and filters the original list, preserving local order. Supplying a differently ordered identity list does not implement reranking.

Research recommendation: retain the local shortlist and eligibility rules; evaluate Jev as an optional post-retrieval filter first. True reranking requires an explicit ordering contract. On timeout, throttling, service failure, invalid answers, or unresolved uncertainty, preserve the eligible local result rather than convert infrastructure failure into an empty retrieval. A healthy, validated relevance judgment may legitimately reject all candidates; that is distinct from an unavailable judge.

Before implementation, decide external-data authorization and evaluate synthetic or explicitly approved examples covering Chinese, English, code identifiers, negation, irrelevant candidates, prompt injection, and no-relevant-memory cases. Compare local-only retrieval with the same shortlist plus Jev, measuring quality and end-to-end p50/p95/p99. Confirm account-specific quota semantics and retention terms separately. No automatic-hook behavior, judge configuration, or implementation was changed by this research.
