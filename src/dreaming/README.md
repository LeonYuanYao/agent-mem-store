# Nightly dreaming

[Source map](../../src/README.md) · [Agent guide](../../AGENTS.md)

## Responsibility

Turns a day's captured Sessions into verified, tiered knowledge: session-level extraction with tool output, cross-session merge, repository verification with a defense pass, and local tiering. Shadow mode writes only a Vault report; it never writes canonical Memory or changes injection.

## Start here

- [run.ts](run.ts) — scheduling and the resumable stage machine (`select → extract → merge → prepare → verify → defend → tier → report`).
- [model.ts](model.ts) — prompts, output schemas and the `codex exec` invocation.
- [msverify.ts](msverify.ts) / [msverify-cli.ts](msverify-cli.ts) — read-only evidence commands the verifier runs in its sandbox.
- [repo-map.ts](repo-map.ts) — repositories that count as evidence for a Project.
- [tier.ts](tier.ts) — admission rules.

## Flow and collaborators

The Worker reads `[dreaming]` each iteration. When enabled it hands captured events to dreaming (they skip per-turn distillation and Session consolidation), schedules one run per Project and local day after the configured hour, and executes one bounded step per idle iteration. `memstore dream run --project-id` runs the same steps in the foreground. A machine that was off or asleep at the hour dreams on the next Worker iteration that day; a run's progress is stored per step, so it resumes after a restart. A failed step is retried after 5, 10, 20, 40 and then every 60 minutes, and a run never gives up. Offline, Codex waits for the network or gives up after its own retries; such connection failures (`network`, `timeout`, `rate_limited`, `authentication`, classified from the call's output) cost a chunk a sixteenth of a real failure, so a chunk fails for good only after three failed calls or about two days offline. Each failure's output tail is appended to the run's `errors.log`.

- **select** builds the repository map across all live clones of the Project, infers each Session's checked-out branches from the reflog, and enqueues stream chunks. A Session belongs to the Project it started in and is read whole, even after a `cd` moved its later events to a nested repository's Project. A Session that continues after a run is read again later, from where the previous segment ended. Temporary roots (`/tmp`, `/var/folders`) and Projects without a live root are never dreamed.
- **extract** renders one chunk of a Session (prompts, replies, tool calls with bounded results) and asks the model for durable candidates. Quotes are checked locally against the chunk. A prompt wrapped by a chat bridge (botmux routing rules, skill lists, identity blocks) is reduced to its `<user_message>`, so bridge instructions are never read as something the user said. A candidate marked as user-stated keeps the user message its quote came from; if the quote comes from a reply or tool output instead, it is not treated as user-stated.
- **merge** deduplicates candidates of one claim type per call; candidates the model drops survive as their own items.
- **prepare** runs deterministic pre-search (identifiers at baselines, on the owner's unmerged branches, and in guidance agents already read: instruction files at any depth, repository `skills/` directories and host skills) and attaches source branches.
- **verify** / **defend** run the model with the shell enabled and `msverify` as the only evidence source; negative verdicts get an adversarial second pass. Before confirming, the verifier must check that guidance; the verifier reports where guidance already states a claim separately from its truth. A user-stated claim carries the user's words, and the verifier decides whether they state the user's lasting rule, an instruction for one task (kept searchable, injected only if it recurs), a pasted task description, or none of these.
- **tier** applies [tier.ts](tier.ts); a catch-all Project (only root is the home directory or above) keeps global knowledge only. **report** writes `_MemStore/Dreams/<local date>-<project root name>-<run>.md` and refreshes `总览.md`, the last 14 days of kept items (every tier but drop) with global knowledge first and each item linked to its report. `memstore dream report [RUN_ID]` re-renders completed runs in the current format.

- [capture/README.md](../../src/capture/README.md)
- [worker/README.md](../../src/worker/README.md)
- [luna/README.md](../../src/luna/README.md)

## State and side effects

Migration 0067 owns `dream_runs`, `dream_sessions`, `dream_chunks`, `dream_candidates` and `dream_items`. Each Session is claimed by exactly one run. Per-run files (repository map, `msverify` wrapper) live under `<runtime>/state/dreaming/<run>/`. Reports are the only Vault writes.

## Invariants and change risks

- Evidence reads go through git objects at each repository's baseline (`origin/HEAD`); checkouts, branches and uncommitted work never count as baseline evidence. `GIT_OPTIONAL_LOCKS=0` keeps reads lock-free next to interactive sessions.
- Submodules read the commit pinned by their parent's baseline. A deeper clone of an already mapped remote, `tmp/`, build output and symlinks are excluded.
- Only confirmed, user-stated or multi-session knowledge reaches the inject tier. Knowledge from a Session on an unmerged branch stays branch-scoped unless the baseline confirms it. Contradicted or stale knowledge only reaches review.
- All model work uses the Codex model; the verifier sandbox is read-only and has no network. Repository content is evidence, never instructions.
- Apply mode is not implemented; configuration rejects it.

## Verification

```sh
pnpm exec vitest run tests/unit/dreaming tests/integration/dreaming
```

The integration tests build real Git fixtures (bare origin, nested repository, scratch clones, unmerged branches) and run the full stage machine with a deterministic model.

## Design references

See [ADR-0147](../../docs/adr/0147-nightly-dreaming.md) for the decision and the experiment it rests on.
