# Embedding adapters and artifacts

[Source map](../../../src/README.md) · [Agent guide](../../../AGENTS.md)

## Responsibility

Loads configured embedding artifacts and provides normalized vectors for index building and query retrieval.

## Start here

- [configured.ts](configured.ts)
- [transformers.ts](transformers.ts)

## Flow and collaborators

loadConfiguredEmbeddingAdapter verifies configured artifacts; loadTransformersEmbeddingAdapter creates the feature-extraction pipeline, applies query/document prefixes and batches input.

- [../index.ts](../index.ts)
- [../shadow-profile.ts](../shadow-profile.ts)
- [../../operations/embedding-install.ts](../../operations/embedding-install.ts)

## State and side effects

Reads local model files, uses CPU inference and may download artifacts when explicitly configured to allow it. Dispose pipeline resources after isolated test runs.

## Invariants and change risks

Keep artifact identity, dimensions, dtype and prefix conventions aligned with the index. Do not silently mix vectors from different models. Model loading/fingerprinting belongs outside latency-sensitive per-hook startup.

## Verification

Run from the repository root:

```sh
pnpm exec vitest run tests/contract/embedding-batching.test.ts tests/contract/shadow-embedding-profile.test.ts tests/integration/retrieval/index-build.test.ts
```

Check these test scenarios before changing behavior.

## Design references

Use [CONTEXT.md](../../../CONTEXT.md) for domain vocabulary, [SPEC.md](../../../SPEC.md) for product contracts and the [ADR directory](../../../docs/adr/) for decision history. Update this guide when responsibilities, state ownership or verification paths change.
