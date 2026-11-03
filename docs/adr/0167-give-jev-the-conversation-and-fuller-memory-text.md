---
status: accepted
---

# Give Jev the conversation and the fuller Memory text; audit recall weekly

On the 11-02 labeled set (418 pairs, 73 relevant to the reference labels), Jev at
0.45 kept 42 of the 73 relevant pairs; 31 were dropped at Jev, not by the local gate.
21 of the 31 were prompts that only make sense with the conversation ("同意你的方案",
"push", "告诉群里的 codex 也这样做一遍授权"). Jev's request has a conversation
field, but since 10-26 only 12% of Jev calls carried the full exchange, 52% partial
and 35% none:

- Claude Code's hooks never sent the assistant's reply to the conversation cache;
  Codex's Stop hook does.
- The cache lives in Worker memory, so every Worker restart emptied it.
- Jev read only the compact (96 tokens); the reference labels saw the body. Six of
  the dropped relevant pairs, against one kept, were Memories over 200 characters.

Luna as the judge was less accurate than Jev on the same pairs (F1 0.585 against
0.651; κ 0.41 against the reference) and cannot run within the 1.5-second
foreground budget through Codex.

Decision:

- Claude Code's Stop hook sends the reply (from the hook or the transcript tail) to
  the conversation cache; a turn without a turn id takes the reply on its latest
  turn. A sensitive reply clears the Session's context; a private turn sends none.
- When the cache has no history for a Session, the Worker rebuilds the last three
  turns from captured UserPromptSubmit and Stop events (no task notifications, no
  private text, not the current prompt) before the prompt's turn begins.
- Jev reads a Memory's standard text when it has detail and fits 300 tokens. The
  request stays one call: while the fuller texts would leave the conversation less
  than 768 tokens of the 4,096-token request, the longest falls back to its compact.
  Two parallel requests were rejected: the second would miss the warm connection
  (ADR-0151).
- `scripts/audit-recall.ts` samples 40 prompts of the past week, labels with Codex
  (gpt-6.1-terra) the 12 nearest Memories that existed at the time plus what was
  injected, and traces each relevant Memory through its receipt: injected, already in
  context, rejected by Jev, cut by limits, judged weak locally, or never examined.
  A botmux task runs it every Monday and sends the report to the user's private chat.
- `scripts/lib/relevance-labels.ts` holds the labeling shared with
  `evaluate-injection.ts` (now `--model`), with short pair ids.

Jev's scores may shift with fuller inputs; the 0.45 threshold is rechecked by the
audit and the next `evaluate-injection` run.
