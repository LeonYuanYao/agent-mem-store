---
status: accepted
---

# Rank explicit recall with bigram BM25

Explicit recall ranked lexical matches with the FTS5 table, whose `unicode61`
tokenizer keeps a run of Chinese characters as one token. A query word such as
`安装包` matched only Memories where it stood alone, not inside `下载安装包后`, and a
lexical match also requires that FTS hit. Agents mostly search with short,
space-separated Chinese and English words (`tteh 安装包 多开`).

Decision:

- Explicit recall ranks lexical matches with Okapi BM25 (k1 1.2, b 0.75) over the
  automatic recall search terms (`countSearchTerms`: words, their Latin and CJK runs
  and CJK character bigrams), merged with the punctuation-free words FTS5 produced, so
  `memory.` and `long-term` still match `memory` and `term`. It is computed in process
  over the Memories in scope with the 64 rarest query terms present in scope.
  Admission and coverage rules are unchanged.
- The FTS5 table is still built; explicit recall no longer reads it.

Evaluation on 2026-11-15: the 135 distinct real `recall search` queries (receipts
from 2026-10-19 to 11-13, `show` and identity lookups excluded), current corpus,
top 8 of each version, union labeled by Codex gpt-6.1-terra (isolated):

| | Empty results | Queries with a relevant item in top 8 | Precision at 3 | Relevant in top 8 | Latency p50 |
| --- | ---: | ---: | ---: | ---: | ---: |
| FTS5 | 31 | 77 | 44.0% | 135 | 49 ms |
| Bigram BM25 | 28 | 79 | 44.7% | 143 | 49 ms |

Semantic recall already covered most Chinese queries, so the gain is small; no
measure regressed. Labels are one model's judgment.

Automatic recall still uses `countSearchTerms` alone, where a sentence-final word
keeps its period; changing that shifts local scores and needs its own evaluation.
