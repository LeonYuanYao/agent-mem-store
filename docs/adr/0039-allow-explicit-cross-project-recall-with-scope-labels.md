---
status: accepted
---

# Allow explicit Cross-Project recall with scope labels

Automatic SessionStart and UserPromptSubmit injection remains strictly limited to the resolved current Project plus Global Memory. It never searches or injects another Project as an automatic fallback.

Explicit recall also starts with the current Project plus Global Memory. If that scope is insufficient, an Agent may autonomously request another exact `project_id` or `scope: all_projects` through the canonical MCP or command surface without asking for per-query human confirmation. Expanded scope must be explicit in the request and recorded in its Retrieval Receipt; it cannot become a hidden default.

Cross-Project Explicit Recall returns only eligible Normal Memory. Private Project Memory does not cross Projects, and Secret Content, Memory Candidates, unresolved conflicts, expired content, and rejected content remain excluded. Results prominently label their source Project and that they are not current-Project rules. Project mismatch receives a strong ranking penalty, and only highly semantically relevant results survive.

Reading or using a Cross-Project result does not mutate its scope, raise its authority, make it current-Project knowledge, or count as independent evidence for Global promotion. If an Agent later proposes a reusable Global claim, it creates a new Global Candidate subject to independent-project provenance, Memory Echo exclusion, and ordinary promotion policy.

The Retrieval Receipt records why scope expanded, the requested Projects or all-projects mode, returned Project and Memory identities and revisions, ranking information, and rendered tokens. This preserves auditability and supports irrelevant-retrieval Bad Cases without creating an unnecessary hard knowledge wall for foreground research.
