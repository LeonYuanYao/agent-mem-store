import { mkdtemp, rm } from "node:fs/promises";
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
  const adapter = new CodexLunaAdapter({
    codexExecutable: "codex",
    codexHome: join(root, "codex-home"),
    temporaryRoot: root,
    runProcess: (request) => {
      requests.push(request);
      return Promise.resolve({
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
      });
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
  expect(prompt).toContain('"promptVersion":1');
  expect(prompt).toContain('"task":"review_memory_governance_page"');
  expect(prompt).toContain("Never propose an Agent action against Human-authored Memory");
  expect(prompt).toContain("does not authorize deletion");
});
