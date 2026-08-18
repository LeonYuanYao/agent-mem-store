# Semantically validate generic tool evidence

Codex `PostToolUse` covers more than shell commands. MCP and future tools may
return useful evidence without a command string, working directory, exit code,
or command-result identity. Treating every such event as invalid discarded
otherwise intact provenance and left durable Candidates permanently waiting.

MemStore keeps two evidence paths. A command result with complete structured
fields continues through the deterministic local gate. An intact,
checksum-bound `PostToolUse` Capture Event without those fields is eligible only
for Luna semantic assessment. It cannot promote a Candidate unless the durable
assessment is `supported` and cites that exact evidence identity. Truncated,
echoed, ambiguous, missing, cross-Project, or source-identity-mismatched events
remain ineligible.

Historical `insufficient_evidence` Candidates are reopened for this path. A
durable background cursor scans them in bounded groups, so normal Hooks do not
perform historical analysis. Status reports the cursor separately from Capture,
distillation, Session consolidation, semantic assessment, and conflict lanes.
