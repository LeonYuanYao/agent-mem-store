import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import {
  inspectAdmissionAudit,
  recordAdmissionAudit
} from "../../../src/admission/audit.js";
import { enqueueLunaOperation } from "../../../src/luna/operations.js";
import { runWorkerOnce } from "../../../src/worker/main.js";
import { makeLongTermCandidateDurability } from "../../helpers/candidate-durability.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

test("the Worker removes expired admission audit bodies through a daily bounded maintenance pass", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-admission-retention-"));
  temporaryDirectories.push(root);
  const runtimeRoot = join(root, "runtime");
  const operation = await enqueueLunaOperation({
    runtimeRoot,
    kind: "distill_batch",
    idempotencyKey: "admission-retention",
    payload: { batchId: "batch-retention" },
    createdAt: "2026-08-01T00:00:00.000Z"
  });
  await recordAdmissionAudit({
    runtimeRoot,
    operationId: operation.operationId,
    sourceKind: "distillation",
    sourceId: "batch-retention",
    candidates: [{
      statement: "A rejected clause retained only for bounded Shadow review.",
      primaryCategory: "durable_reference",
      categoryTags: ["durable_reference"],
      applicabilitySummary: "this run",
      conditions: [],
      exclusions: [],
      preservedNegations: [],
      certainty: "asserted",
      sensitivity: "normal",
      evidenceIds: ["evidence-1"],
      retentionDecision: "no_memory",
      durability: {
        ...makeLongTermCandidateDurability(),
        disposition: "session_only",
        horizon: "session",
        abstractionLevel: "task_observation"
      },
      importanceTags: [],
      importanceReasons: []
    }],
    promptVersion: 5,
    createdAt: "2026-08-01T00:00:01.000Z"
  });

  await runWorkerOnce({
    runtimeRoot,
    vaultRoot: join(root, "vault"),
    workerId: "worker-admission-retention",
    now: "2026-08-16T00:00:00.000Z",
    workerStartedAt: "2026-08-16T00:00:00.000Z"
  });

  await expect(inspectAdmissionAudit({
    runtimeRoot,
    operationId: operation.operationId
  })).resolves.toEqual([]);
});

test("admission audit never retains a statement that local sensitivity checks reject", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-admission-redaction-"));
  temporaryDirectories.push(root);
  const runtimeRoot = join(root, "runtime");
  const operation = await enqueueLunaOperation({
    runtimeRoot,
    kind: "distill_batch",
    idempotencyKey: "admission-redaction",
    payload: { batchId: "batch-redaction" },
    createdAt: "2026-08-01T00:00:00.000Z"
  });
  await recordAdmissionAudit({
    runtimeRoot,
    operationId: operation.operationId,
    sourceKind: "distillation",
    sourceId: "batch-redaction",
    candidates: [{
      statement: "password=supersecretvalue must not be retained.",
      primaryCategory: "safety_data_integrity",
      categoryTags: ["safety_data_integrity"],
      applicabilitySummary: "this rejected output",
      conditions: [],
      exclusions: [],
      preservedNegations: [],
      certainty: "asserted",
      sensitivity: "normal",
      evidenceIds: ["evidence-1"],
      retentionDecision: "no_memory",
      durability: {
        ...makeLongTermCandidateDurability(),
        disposition: "session_only",
        horizon: "session",
        abstractionLevel: "task_observation"
      },
      importanceTags: [],
      importanceReasons: []
    }],
    promptVersion: 5,
    createdAt: "2026-08-01T00:00:01.000Z"
  });

  await expect(inspectAdmissionAudit({
    runtimeRoot,
    operationId: operation.operationId
  })).resolves.toMatchObject([{
    retentionDecision: "no_memory",
    statementRedacted: true
  }]);
  const audit = await inspectAdmissionAudit({
    runtimeRoot,
    operationId: operation.operationId
  });
  expect(audit[0]).not.toHaveProperty("statement");
  expect(audit[0]).not.toHaveProperty("statementSha256");
});
