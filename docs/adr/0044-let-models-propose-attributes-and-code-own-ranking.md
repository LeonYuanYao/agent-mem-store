---
status: accepted
---

# Let models propose attributes and deterministic code own ranking

Luna may asynchronously propose bounded semantic attributes during extraction, validation, or governance. These include knowledge category, applicability conditions, time sensitivity, importance tags, and evidence references. A model proposal is not a foreground ranking decision and becomes usable only after the applicable validation path stores it as versioned structured Memory data.

Human-authored structured values and explicit corrections remain authoritative and cannot be silently overwritten by Luna. An ambiguous semantic classification defaults conservatively to `normal` or remains ineligible for SessionStart instead of being guessed into a higher tier.

SessionStart does not invoke Luna for classification, reranking, or pack selection. Local deterministic code owns the final decision. It derives lifecycle eligibility, authority, scope promotion, validation state, bounded utility signals, and stable tie-breaks from accepted structured data. The same accepted input and configuration therefore produce the same result without foreground model latency or model availability risk.

The Injection Receipt records the effective tier, scope promotion, material structured attributes, ranking components, and selection or omission reason. Replacing or upgrading Luna cannot silently alter active ranking; a change takes effect only through a governed operation that produces and validates a new structured Memory revision.
