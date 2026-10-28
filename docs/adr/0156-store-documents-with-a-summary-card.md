---
status: accepted
---

# Store documents: an index card for recall, the full text in the Vault

The user wants to hand MemStore a document (a Markdown file or a Feishu/Lark doc)
so that recall shows a short description and an agent reads the full text when it
needs it. `remember assert --file` could already store a file as Human-authored
Memory and, since ADR-0155, gets a summary. Four things did not fit documents:
summary validation demanded every rule and condition a long document holds; the
full text matched countless prompts by shared words; importing the same document
again created a duplicate; and the sensitivity heuristic flagged identifiers such
as `human_authored_only_injection` near the word "auth", which blocked ordinary
documents (MemStore's own README among them).

Decision:

- `memstore remember doc --file PATH | --lark URL | --stdin --source S` stores one
  Human-authored Memory: body `# title`, a source line (source, import date, Lark
  revision), then the document unchanged. Category `durable_reference`, startup
  `never`, applicability summary = title, provenance `source:document:<source>` and
  `document-sha256:<content hash>`. `--lark` runs `lark-cli docs +fetch --doc-format
  markdown --as user` with the user's login and reads the title from the document
  metadata (`GET /open-apis/docx/v1/documents/<id>`), which the Markdown export lacks.
- The same source again revises that Memory (same M:id, new revision, summary
  regenerated) or reports `unchanged` when the content hash matches.
- Document Memories get an index card from the compact pipeline: the document's
  name, what it covers and when to read it. Validation accepts a card that
  identifies the document and its coverage without misstating it.
- A document's searchable and embedded text is its usable compact, title and
  headings, not the full text. A document short enough to inject whole keeps its
  full text as compact.
- Sensitivity: a secret still blocks. An uncertain match returns
  `needs_sensitivity_review` with the matched value; importing again with
  `--confirm-sensitive <value>` lets exactly that value through the write checks.
  The heuristic no longer treats letters joined by `_` or `-` without digits as a
  token.
- `memstore-remember` documents the command and is linked into `~/.claude/skills`
  and `~/.codex/skills`.

Rejected: chunking a document into many Memories (one source, one revision history,
one M:id to read); automatic background sync of Lark documents (needs the user's
login and a change feed; re-importing is explicit and cheap); full-text lexical
matching for documents (shared words, not topic, would decide recall).

Trial on 2026-10-28 with a 13,194-character Lark document and the production
generator and validator: the card named the document, its subject and when to read
it, with the main conclusion, and validated as `document_index_accurate`.
