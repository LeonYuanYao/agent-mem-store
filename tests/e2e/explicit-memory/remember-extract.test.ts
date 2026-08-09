import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { initializeMemStore } from "../../../src/operations/initialize.js";
import { rememberExtract } from "../../../src/operations/remember.js";
import { openRuntimeDatabase } from "../../../src/runtime/database.js";
import { runNextLunaWork } from "../../../src/worker/distillation.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

test("explicit Global extraction durably authorizes Luna Candidates and preserves startup", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-explicit-extract-"));
  temporaryDirectories.push(root);
  const projectRoot = join(root, "workspace");
  const vaultRoot = join(root, "vault");
  const runtimeRoot = join(root, "runtime");
  const sourcePath = join(projectRoot, "decision.txt");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, ".memstore-project"), JSON.stringify({
    schema_version: 1,
    project_id: "msproj_123e4567-e89b-42d3-a456-426614174000"
  }));
  await writeFile(sourcePath, "Use a single durable outbox for capture retries.");
  await initializeMemStore({ vaultRoot, runtimeRoot, preview: false });

  const queued = await rememberExtract({
    runtimeRoot,
    vaultRoot,
    path: projectRoot,
    source: `file:${sourcePath}`,
    scope: "global",
    startup: "never",
    preview: false,
    requestedAt: "2026-08-07T01:00:00.000Z"
  }) as { operation_id: string };
  const completed = await runNextLunaWork({
    runtimeRoot,
    workerId: "explicit-test-worker",
    now: "2026-08-07T01:01:00.000Z",
    adapter: {
      distillBatch(request) {
        const evidenceId = request.evidence[0]?.evidenceId;
        if (evidenceId === undefined) throw new Error("Missing explicit evidence.");
        return Promise.resolve({
          schemaVersion: 1,
          kind: "distillation" as const,
          candidates: [{
            statement: "Use a single durable outbox for capture retries.",
            category: "architecture_contract",
            applicabilitySummary: "Current project",
            conditions: [],
            exclusions: [],
            preservedNegations: [],
            certainty: "asserted",
            importanceTags: ["architecture_invariant"],
            importanceReasons: [{
              tag: "architecture_invariant",
              reason: "The source states a durable architecture decision.",
              evidenceIds: [evidenceId]
            }],
            sensitivity: "normal",
            evidenceIds: [evidenceId]
          }]
        });
      },
      consolidateSession() {
        return Promise.reject(new Error("Explicit one-batch extraction must not consolidate."));
      }
    }
  });
  const database = await openRuntimeDatabase(runtimeRoot);
  const candidate = database.prepare(
    `SELECT scope_kind, project_id, startup, global_authorization_id
     FROM memory_candidates LIMIT 1`
  ).get();
  database.close();

  expect(queued.operation_id).toMatch(/^msop_/u);
  expect(completed).toMatchObject({ state: "completed", operationId: queued.operation_id });
  expect(candidate).toMatchObject({
    scope_kind: "global",
    project_id: null,
    startup: "never"
  });
  expect(candidate?.global_authorization_id).toMatch(/^msglobalauth_/u);
});
