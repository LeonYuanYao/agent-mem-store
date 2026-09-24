import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { CodexLunaAdapter, type LunaProcessRequest } from "../../../src/luna/index.js";
import { makeCanonicalMemory } from "../../helpers/canonical-memory.js";

const roots: string[] = [];

test.each(["value", "unknown", "none"])("governance uses one fixed retention field per target (%s)", async (mode) => {
  const withTargets = mode !== "none";
  const assessment = { contentKind: "failure_mechanism", horizon: "durable", priority: "high",
    futureUse: "Bound background retries.", reason: "Avoid repeated failed work." };
  const root = await mkdtemp(join(tmpdir(), "memstore-governance-retention-schema-"));
  roots.push(root);
  let schema: unknown;
  const adapter = new CodexLunaAdapter({
    codexExecutable: "codex", codexHome: join(root, "codex-home"), temporaryRoot: root,
    runProcess: async request => {
      const path = request.arguments[request.arguments.indexOf("--output-schema") + 1];
      if (path === undefined) throw new Error("Missing schema path");
      schema = JSON.parse(await readFile(path, "utf8")) as unknown;
      return { exitCode: 0, stderr: "", stdout: JSON.stringify({
        schemaVersion: 1, kind: "governance_page_review", agentActions: [], reviewSuggestions: [],
        futurePurgeObligations: [], summaryItems: [], retentionAssessments: withTargets
          ? { [memory.memoryId]: mode === "value" ? assessment : null } : {}
      }) };
    }
  });
  const memory = { ...makeCanonicalMemory({
    memoryId: "msmem_123e4567-e89b-42d3-a456-426614174001", revisionId: "msrev_123e4567-e89b-42d3-a456-426614174002",
    body: "Keep retry budgets bounded.", authority: "agent_derived"
  }), category: "workflow" };
  const result = await adapter.reviewPage({
    schemaVersion: 1, runId: "run", runKind: "weekly", phase: "weekly",
    coverage: { from: "2026-08-01T00:00:00.000Z", through: "2026-08-10T00:00:00.000Z" },
    pageOrdinal: 0, memories: [memory], retentionTargets: withTargets ? [{ memoryId: memory.memoryId, subjectHash: "a".repeat(64) }] : []
  });
  expect(schema).toMatchObject({ properties: { retentionAssessments: {
    type: "object", additionalProperties: false, required: withTargets ? [memory.memoryId] : [],
    properties: withTargets ? { [memory.memoryId]: { anyOf: [{ $ref: "#/$defs/retentionValue" }, { type: "null" }] } } : {}
  } } });
  expect(result.retentionAssessments).toEqual(mode === "value" ? [{ ...assessment, memoryId: memory.memoryId }] : []);
});

test("governance rejects an unrequested retention target with a safe actionable diagnostic", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-governance-retention-diagnostic-"));
  roots.push(root);
  const adapter = new CodexLunaAdapter({
    codexExecutable: "codex", codexHome: join(root, "codex-home"), temporaryRoot: root,
    runProcess: () => Promise.resolve({ exitCode: 0, stderr: "", stdout: JSON.stringify({
      schemaVersion: 1, kind: "governance_page_review", agentActions: [], reviewSuggestions: [],
      futurePurgeObligations: [], summaryItems: [], retentionAssessments: { unrequested: {
        contentKind: "reference", horizon: "unknown", priority: "normal",
        futureUse: "Unknown", reason: "Unknown"
      } }
    }) })
  });
  await expect(adapter.reviewPage({
    schemaVersion: 1, runId: "run", runKind: "weekly", phase: "weekly",
    coverage: { from: "2026-08-01T00:00:00.000Z", through: "2026-08-10T00:00:00.000Z" },
    pageOrdinal: 0, memories: [], retentionTargets: []
  })).rejects.toMatchObject({ category: "schema_invalid", diagnostic: {
    stage: "retention_validation", code: "unrequested_retention_target", path: "retentionAssessments.0.memoryId"
  } });
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
test("the real Luna adapter exposes a versioned authority-safe governance task", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-governance-luna-adapter-"));
  roots.push(root);
  const requests: LunaProcessRequest[] = [];
  let outputSchema: unknown;
  const adapter = new CodexLunaAdapter({
    codexExecutable: "codex",
    codexHome: join(root, "codex-home"),
    temporaryRoot: root,
    runProcess: async (request) => {
      requests.push(request);
      const schemaIndex = request.arguments.indexOf("--output-schema") + 1;
      const schemaPath = request.arguments[schemaIndex];
      if (schemaPath === undefined) throw new Error("Expected an output schema path.");
      outputSchema = JSON.parse(await readFile(schemaPath, "utf8")) as unknown;
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          schemaVersion: 1,
          kind: "governance_page_review",
          agentActions: [],
          reviewSuggestions: [],
          futurePurgeObligations: [],
          summaryItems: ["No supported governance mutation was found."]
        }),
        stderr: ""
      };
    }
  });

  await adapter.reviewPage({
    schemaVersion: 1,
    runId: "msgovrun-test",
    runKind: "monthly",
    phase: "monthly",
    coverage: {
      from: "2026-07-01T00:00:00.000Z",
      through: "2026-08-01T00:00:00.000Z"
    },
    pageOrdinal: 0,
    memories: []
  });

  const prompt = requests[0]?.standardInput;
  expect(prompt).toContain('"promptVersion":7');
  expect(prompt).toContain("Conditional architecture is still durable");
  expect(prompt).toContain("Monthly full scans use the same evidence threshold");
  expect(prompt).toContain('"task":"review_memory_governance_page"');
  expect(prompt).toContain("Never propose an Agent action against Human-authored Memory");
  expect(prompt).toContain("operational probe, exact-response check, temporary progress");
  expect(prompt).toContain("Prefer one condition-preserving successor");
  expect(prompt).toContain("Relationship actions do not require a reviewed duplicate cluster");
  expect(prompt).toContain("supports, extends, or qualifies");
  expect(prompt).toContain("time-bound status as a timeless fact");
  expect(prompt).toContain("does not authorize deletion");
  expect(outputSchema).toMatchObject({
    properties: {
      schemaVersion: { type: "integer", const: 1 },
      kind: { type: "string", const: "governance_page_review" },
      agentActions: {
        items: {
          anyOf: [
            { properties: { kind: { type: "string", const: "archive" } } },
            { properties: { kind: { type: "string", const: "supersede" } } },
            { properties: { kind: { type: "string", const: "mark_review_due" } } },
            { properties: { kind: { type: "string", const: "add_relationship" } } }
          ]
        }
      }
    }
  });
});
