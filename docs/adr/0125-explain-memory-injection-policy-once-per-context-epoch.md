---
status: accepted
supersedes: ADR-0053 repeated-header requirement
---

# Explain Memory Injection policy once per Context Epoch

The first non-empty automatic Memory Pack in each Context Epoch renders the complete retrieval-role
policy and the compact `M/S/A/R` legend. SessionStart, high-relevance UserPromptSubmit, and
probable-only UserPromptSubmit retain their accepted first-pack wording. An empty pack does not
consume this one-time explanation. The version-2 legend also states that later
`<memstore-candidates>` blocks follow the same policy and that `M:<id>` supports deeper reading.

After a non-empty Receipt durably records that explanation, later non-empty packs in the same
Context Epoch render only the selected items inside `<memstore-candidates>` and
`</memstore-candidates>`. The self-describing boundary keeps retrieved content distinguishable
from host instructions without repeating the full false-positive, applicability, precedence, and
deep-read prose on every turn.

The existing Context Epoch `memory_legend_version` state owns both the policy explanation and the
legend version. A new SessionStart creates a new Epoch and restores the full explanation. Existing
active Epochs at version 1 receive the complete version-2 explanation once before switching to the
compact boundary; Epochs that already recorded the current version may use it immediately. No
additional table, transcript scan, or foreground model call is introduced.

Both the one-time explanation and compact boundary count toward rendered-token and Context Epoch
budgets. Receipt commit remains the state transition: a failed or empty injection cannot falsely
mark the explanation as delivered.
