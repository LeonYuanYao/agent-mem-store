---
status: accepted
---

# Pack compact breadth before standard detail

UserPromptSubmit uses deterministic two-phase packing. Phase one selects breadth using validated compact representations: eligible `high` candidates first and then at most the accepted two `probable` candidates, up to the six-item and hard-token limits. A standard representation cannot displace another high compact that would otherwise fit.

Phase two may upgrade selected high items to their validated standard representation in rank order. Probable items remain compact-only. Ordinary upgrades use only remaining space within the 600-token target and cannot enter the 600–1,024 range merely to add detail.

A high item is eligible for a deterministic standard upgrade only when the Retrieval Query directly names its Memory identity, exactly matches its file, symbol, error code, command, or entity metadata, or matches a structured query-relevant condition present only in standard form. Semantic-only high items remain compact and support later Explicit Deep Retrieval. Direct Memory identity reference may use remaining capacity up to the 1,024-token hard limit.

An upgrade that does not fit leaves the compact selected and neither truncates it nor evicts another selected item. The Injection Receipt records both packing phases, upgrade eligibility and choice, fit results, and prevented displacements. Foreground code does not call Luna to decide whether standard detail is useful.
