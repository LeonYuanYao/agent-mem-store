---
status: accepted
---

# Validate compact snippets against Semantic Contracts

Each Durable Memory revision derives a versioned Semantic Contract containing at least its reusable core claim, applicability conditions, meaning-changing facts that must be preserved, original certainty, and time-sensitivity or validity metadata. `must_preserve` facts include material negations, exceptions, prerequisites, prohibitions, numeric thresholds, versions, platforms, paths, commands, and state boundaries.

A `compact` Injection Snippet is a constrained projection of that contract, not a prefix, extractive truncation, or unconstrained summary. It must preserve the core claim and every applicable `must_preserve` fact, remain independently understandable, retain certainty, and add neither a broader scope nor a new claim. Background narrative, repeated examples, full provenance, secondary explanation, relationship detail, and revision history may be omitted because identity-based deep retrieval remains available.

The first-version configurable compact-body ceiling is 96 rendered tokens. Luna may generate a candidate asynchronously. Local deterministic validation checks its schema, configured token ceiling, required structured anchors, and sensitivity state. Cases whose semantic preservation cannot be established deterministically receive an asynchronous Luna assessment. Foreground hooks and SessionStart do not generate or validate snippets.

Only a successfully validated snippet bound to the current Canonical Memory content identity may enter a completed index revision. Editing Canonical Memory immediately invalidates the previous derived snippet; failure or Luna unavailability cannot keep stale wording eligible for the new revision.

A Human-authored compact override has authority over Luna wording but still must pass sensitivity, schema, Semantic Contract coverage, and token validation. Human authority does not make an unsafe or meaning-losing projection eligible.
