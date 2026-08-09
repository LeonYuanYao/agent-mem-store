# Repair evidence reference

## Root-cause categories

- `extraction_prompt`: distilled knowledge is wrong or incomplete.
- `importance_classification`: importance or startup policy is wrong.
- `retrieval_ranking`: relevant candidates exist but ordering is wrong.
- `threshold`: a gate admits noise or rejects useful knowledge.
- `instrumentation_gap`: receipts or diagnostics cannot prove what happened.
- `source_data_quality`: captured evidence is incomplete or misleading.
- `incorrect_knowledge_content`: the stored claim itself is wrong; correct it only through a separate explicit Memory operation.
- `scope_boundary`, `authority_boundary`, or `sensitivity_boundary`: safety behavior; always Class C.

## Risk evidence

- Class A: pre-fix regression, post-fix affected suite, original-case replay, and no known regression.
- Class B: frozen reported/protected cases; all reported cases pass; aggregate target passes; irrelevant retrieval, critical recall, scope, authority, sensitivity, conflict behavior, labels, and thresholds do not regress.
- Class C: Gate 2 starts monitoring. Resolution requires at least seven consecutive calendar days, at least 30 decisions that traverse the affected safety gate, and zero violations. Unrelated sessions and duplicate replay do not count.

Applying a fix and resolving a Bad Case are separate decisions. A failed or incomplete replay remains unresolved.
