import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { captureEvent } from "../../../src/capture/index.js";
import { activeAgents, documentedReferences, loadingAgents, type GuidanceContext } from "../../../src/dreaming/coverage.js";
import { openRuntimeDatabase } from "../../../src/runtime/database.js";

const context: GuidanceContext = {
  claudeImports: new Set(["AGENT.md", "~/.claude/rules.md"]),
  skills: { claude: new Set(["shared", "claude-only"]), codex: new Set(["shared", "codex-only"]) }
};

test("guidance files belong to the agents that load them", () => {
  expect(loadingAgents("CLAUDE.md", context)).toEqual(["claude"]);
  expect(loadingAgents("tools/CLAUDE.md", context)).toEqual(["claude"]);
  expect(loadingAgents("AGENT.md", context)).toEqual(["claude"]);
  expect(loadingAgents("~/.claude/rules.md", context)).toEqual(["claude"]);
  expect(loadingAgents("codex-config/AGENTS.md", context)).toEqual(["codex"]);
  expect(loadingAgents("~/.codex/AGENTS.md", context)).toEqual(["codex"]);
  // A skill counts for the agents it is installed for, wherever the file was found.
  expect(loadingAgents("~/.claude/skills/shared/SKILL.md", context)).toEqual(["claude", "codex"]);
  expect(loadingAgents("codex-config/skills/codex-only/SKILL.md", context)).toEqual(["codex"]);
  expect(loadingAgents("repo/.claude/skills/unlisted/SKILL.md", context)).toEqual(["claude"]);
  // What cannot be told counts for every agent, as before.
  expect(loadingAgents("tools/ui/.ai/skills/ui-dsl/SKILL.md", context)).toBeUndefined();
  expect(loadingAgents(".ai/bootstrap.md", context)).toBeUndefined();
});

test("documented_at answers name one or more path:line references", () => {
  expect(documentedReferences("AGENT.md:28; docs/memstore-handoff.md:1-5")).toEqual([
    { path: "AGENT.md", from: 28, to: 28 }, { path: "docs/memstore-handoff.md", from: 1, to: 5 }]);
  expect(documentedReferences("docs/a.md:5,138-145")).toEqual([{ path: "docs/a.md", from: 5, to: 5 }]);
  expect(documentedReferences("~/.claude/skills/x/SKILL.md:12")).toEqual([{ path: "~/.claude/skills/x/SKILL.md", from: 12, to: 12 }]);
  expect(documentedReferences("")).toEqual([]);
});

test("an agent works in a Project with at least three Sessions and a tenth of them", async () => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "memstore-coverage-"));
  try {
    const session = async (agent: "claude" | "codex", sessionId: string) => captureEvent({ runtimeRoot, event: {
      schemaVersion: 1, eventId: `msevent_${sessionId}`, deduplicationKey: sessionId, agent, eventKind: "SessionEnd",
      occurredAt: new Date().toISOString(), projectId: "msproj_123e4567-e89b-42d3-a456-426614174000", sessionId, payload: { reason: "other" }
    } });
    const agents = async () => {
      const database = await openRuntimeDatabase(runtimeRoot);
      try {
        return activeAgents(database, "msproj_123e4567-e89b-42d3-a456-426614174000", new Date(Date.now() + 60_000).toISOString());
      } finally {
        database.close();
      }
    };
    expect(await agents()).toEqual(["claude", "codex"]);
    for (const index of [1, 2, 3, 4]) await session("codex", `codex-${String(index)}`);
    await session("claude", "claude-1");
    expect(await agents()).toEqual(["codex"]);
    for (const index of [2, 3]) await session("claude", `claude-${String(index)}`);
    expect(await agents()).toEqual(["claude", "codex"]);
  } finally {
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});
