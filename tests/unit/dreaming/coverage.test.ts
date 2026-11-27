import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";

import { captureEvent } from "../../../src/capture/index.js";
import { activeAgents, documentedFor, documentedReferences, guidanceContext, loadingAgents } from "../../../src/dreaming/coverage.js";
import { openRuntimeDatabase } from "../../../src/runtime/database.js";

test("guidance files belong to the agents that load them, and other files to none", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "memstore-guidance-")));
  try {
    const file = async (path: string) => {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), "# skill\n");
    };
    // Host skills: Claude links to the shared skill; one installed skill lives in a repository.
    await file("host/.agents/skills/shared/SKILL.md");
    await file("host/.agents/skills/codex-only/SKILL.md");
    await file("host/.claude/skills/claude-only/SKILL.md");
    await symlink(join(root, "host/.agents/skills/shared"), join(root, "host/.claude/skills/shared"));
    await file("repo/codex-config/skills/linked/SKILL.md");
    await symlink(join(root, "repo/codex-config/skills/linked"), join(root, "host/.agents/skills/linked"));
    // The repository's own Codex skill links into .ai/skills; the product ships skills nobody loads.
    await file("repo/.ai/skills/probe/SKILL.md");
    await mkdir(join(root, "repo/.agents/skills"), { recursive: true });
    await symlink("../../.ai/skills/probe", join(root, "repo/.agents/skills/probe"));
    await file("repo/src/product/resources/skills/camera/SKILL.md");
    await file("repo/codex-config/manual-skills/quota/SKILL.md");
    const context = await guidanceContext({
      repositories: () => [{ path: ".", directory: join(root, "repo") }],
      claudeImports: () => Promise.resolve(new Set(["AGENT.md", "~/.claude/rules.md"]))
    }, [join(root, "host/.agents/skills"), join(root, "host/.claude/skills"), join(root, "host/.claude/CLAUDE.md")]);

    expect(loadingAgents("CLAUDE.md", context)).toEqual(["claude"]);
    expect(loadingAgents("tools/CLAUDE.md", context)).toEqual(["claude"]);
    expect(loadingAgents("AGENT.md", context)).toEqual(["claude"]);
    expect(loadingAgents("~/.claude/rules.md", context)).toEqual(["claude"]);
    expect(loadingAgents("codex-config/AGENTS.md", context)).toEqual(["codex"]);
    expect(loadingAgents("~/.codex/AGENTS.md", context)).toEqual(["codex"]);
    // A skill counts for the agents whose skill directories hold it, through links either way.
    expect(loadingAgents(join(root, "host/.agents/skills/shared/SKILL.md"), context)).toEqual(["claude", "codex"]);
    expect(loadingAgents(join(root, "host/.agents/skills/codex-only/SKILL.md"), context)).toEqual(["codex"]);
    expect(loadingAgents(join(root, "host/.claude/skills/claude-only/SKILL.md"), context)).toEqual(["claude"]);
    expect(loadingAgents("codex-config/skills/linked/SKILL.md", context)).toEqual(["codex"]);
    expect(loadingAgents(".ai/skills/probe/SKILL.md", context)).toEqual(["codex"]);
    // A product's own skills, a skill nobody installed and a README reach no agent.
    expect(loadingAgents("src/product/resources/skills/camera/SKILL.md", context)).toEqual([]);
    expect(loadingAgents("codex-config/manual-skills/quota/SKILL.md", context)).toEqual([]);
    expect(loadingAgents("docs/README.md", context)).toEqual([]);
    // What instruction files point agents to cannot be told and counts for every agent.
    expect(loadingAgents(".ai/bootstrap.md", context)).toBeUndefined();
    // So a claim only a product's skill states is documented for no agent.
    expect(await documentedFor("src/product/resources/skills/camera/SKILL.md:1", undefined, context)).toEqual([]);
    expect(await documentedFor("CLAUDE.md:1; .ai/skills/probe/SKILL.md:1", undefined, context)).toEqual(["claude", "codex"]);
    expect(await documentedFor(".ai/bootstrap.md:3", undefined, context)).toEqual(["claude", "codex"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ADR-0192: Antigravity loads the AGENTS.md files Codex loads.
test("Antigravity Sessions count as Codex's when deciding which agents work in a Project", async () => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "memstore-coverage-"));
  const projectId = "msproj_123e4567-e89b-42d3-a456-426614174001";
  try {
    for (const [agent, count] of [["claude", 5], ["antigravity", 20]] as const) {
      for (let index = 0; index < count; index += 1) {
        const sessionId = `${agent}-${String(index)}`;
        await captureEvent({ runtimeRoot, event: {
          schemaVersion: 1, eventId: `msevent_${sessionId}`, deduplicationKey: sessionId, agent, eventKind: "SessionStart",
          occurredAt: new Date().toISOString(), projectId, sessionId, payload: { source: "startup" }
        } });
      }
    }
    const database = await openRuntimeDatabase(runtimeRoot);
    try {
      expect(activeAgents(database, projectId, new Date(Date.now() + 60_000).toISOString())).toEqual(["claude", "codex"]);
    } finally {
      database.close();
    }
  } finally {
    await rm(runtimeRoot, { recursive: true, force: true });
  }
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
