---
status: accepted
---

# Use validated identity fallbacks instead of body truncation

The first version does not inject a mechanically truncated body prefix or body head-and-tail pair as a fallback. An ellipsis does not establish that omitted middle content contains no applicability condition, exception, negation, prohibition, or other meaning-changing fact. Extractive and abstractive compact wording remain allowed only when the complete rendered result passes the accepted Semantic Contract validation.

When no valid compact representation exists, an eligible `critical`, `strong`, or explicit `startup: always` Memory may use an `identity` representation of at most 48 rendered tokens. A `normal` Memory without a valid compact is omitted from automatic injection.

The identity representation contains only the Memory identity, scope, authority, primary category, a separately validated non-assertive topic label, and an explicit statement that the body is incomplete and must be read by identity before reliance. The label is a bounded derived field tied to the current content identity; foreground code never constructs it from Canonical Memory prefixes or suffixes. If no safe current label exists, the Memory is omitted.

Pack assembly tries the validated compact representation, then the eligible identity fallback, then records `budget_not_fit` or `representation_unavailable` and continues with later candidates. Foreground runtime never cuts an existing representation merely to make it fit.
