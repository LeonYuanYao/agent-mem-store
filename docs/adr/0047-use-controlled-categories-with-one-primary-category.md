---
status: accepted
---

# Use controlled categories with one primary category

The first-version controlled category taxonomy for SessionStart diversity is:

- `safety_data_integrity`;
- `preference_constraint`;
- `architecture_contract`;
- `failure_recovery_hazard`;
- `workflow_environment_toolchain`;
- `applicability_limitation`; and
- fallback `durable_reference`.

A Memory may retain multiple validated `category_tags` for search and governance but has exactly one `primary_category` for SessionStart rotation. It cannot consume the first-round slot of more than one category.

An explicit Human-authored `primary_category` is authoritative. Otherwise Luna may propose tags, the applicable validation path confirms them, and deterministic code selects the first matching category in this ambiguity precedence: `safety_data_integrity`, `applicability_limitation`, `preference_constraint`, `architecture_contract`, `failure_recovery_hazard`, `workflow_environment_toolchain`, then `durable_reference`.

This precedence resolves rotation ambiguity only. It cannot change priority tier, authority, evidence, applicability, lifecycle, or scope.
