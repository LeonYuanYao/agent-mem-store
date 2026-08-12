import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { inspectCandidate } from "../../../src/candidates/index.js";
import { openRuntimeDatabase } from "../../../src/runtime/database.js";
import { inspectStatus } from "../../../src/operations/status.js";
import { runNextCandidateMaintenance } from "../../../src/worker/candidate-maintenance.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("completed weekly governance durably runs candidate retention exactly once", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-candidate-maintenance-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    database.prepare(
      `INSERT INTO governance_runs(
         run_id, run_kind, state, includes_weekly, weekly_from, monthly_from,
         coverage_through, recovered_occurrence_count, current_phase,
         created_at, updated_at, completed_at
       ) VALUES (?, 'weekly', 'completed', 1, ?, NULL, ?, 1, 'finalize', ?, ?, ?)`
    ).run(
      "msgovrun_candidate_maintenance",
      "2026-07-01T00:00:00.000Z",
      "2026-08-10T11:00:00.000Z",
      "2026-08-10T11:00:00.000Z",
      "2026-08-10T11:00:00.000Z",
      "2026-08-10T11:00:00.000Z"
    );
    database.prepare(
      `INSERT INTO memory_candidates(
         candidate_id, fingerprint, scope_kind, project_id, statement,
         candidate_json, category, certainty, state, high_value, sensitivity,
         source_session_id, created_at, last_evidence_at, updated_at,
         successful_evaluation_at
       ) VALUES (?, ?, 'project', ?, ?, ?, 'durable_reference', 'asserted', 'waiting', 0,
                 'normal', ?, ?, ?, ?, ?)`
    ).run(
      "mscandidate_due",
      "f".repeat(64),
      "msproj_candidate_maintenance",
      "Old provisional knowledge.",
      JSON.stringify({
        statement: "Old provisional knowledge.",
        primaryCategory: "durable_reference",
        categoryTags: ["durable_reference"]
      }),
      "old-session",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
      "2026-01-02T00:00:00.000Z"
    );
  } finally {
    database.close();
  }

  await expect(inspectStatus({ runtimeRoot, vaultRoot: join(root, "vault") }))
    .resolves.toMatchObject({
      candidates: {
        waiting_count: 1,
        unevaluated_count: 0,
        pending_semantic_assessment_count: 0,
        oldest_waiting_at: "2026-01-01T00:00:00.000Z"
      }
    });

  await expect(runNextCandidateMaintenance({
    runtimeRoot,
    now: "2026-08-10T11:00:01.000Z"
  })).resolves.toMatchObject({ state: "completed", expiredCandidateCount: 1 });
  await expect(inspectCandidate(runtimeRoot, "mscandidate_due")).resolves.toMatchObject({
    state: "expired",
    bodyPresent: false,
    tombstone: { bodyPresent: false, deleteAfter: "2027-02-06T11:00:01.000Z" }
  });
  await expect(runNextCandidateMaintenance({
    runtimeRoot,
    now: "2026-08-10T11:00:02.000Z"
  })).resolves.toEqual({ state: "empty" });
});
