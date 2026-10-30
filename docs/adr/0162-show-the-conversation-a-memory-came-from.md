---
status: accepted
---

# Show the conversation a Memory came from

`recall provenance` lists identities (dream item, Session, evidence lines) but not
what was said. Judging whether a dreaming Memory still applies, or why it was
written, needed the conversation (claude-mem's `timeline`).

Decision:

- Extraction records, per candidate, the prompt events of the turns it cites
  (`turn_refs`), in `dream_candidates.source_event_ids_json` (migration 76).
- `memstore recall sources M:<id>` lists up to four source Sessions. With recorded
  turns it shows each turn's prompt (800 characters), the reply (800) and the tools
  used; older Memories show their Sessions' prompts as a timeline (12, 160
  characters). Sessions whose captured text passed its 30-day retention are named
  as expired; Human-authored Memory points to `recall provenance`. Text marked
  private (ADR-0161) never appears.
- The command reads the runtime database only and records no receipt; the
  `memstore-recall` skill documents it.
