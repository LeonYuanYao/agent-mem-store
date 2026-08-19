import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { CodexLunaAdapter, type LunaProcessRequest } from "../../../src/luna/index.js";

const roots: string[] = [];

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
  expect(prompt).toContain('"promptVersion":2');
  expect(prompt).toContain('"task":"review_memory_governance_page"');
  expect(prompt).toContain("Never propose an Agent action against Human-authored Memory");
  expect(prompt).toContain("operational probe, exact-response check, temporary progress");
  expect(prompt).toContain("Prefer one condition-preserving successor");
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
