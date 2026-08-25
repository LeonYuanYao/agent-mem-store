import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { assertHumanKnowledge } from "../../../src/candidates/human.js";
import { applyReviewAction } from "../../../src/review/actions.js";
import { generateReviewInbox, inspectReviewInbox } from "../../../src/review/inbox.js";
import { openRuntimeDatabase } from "../../../src/runtime/database.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("Review Inbox is rebuildable and never copies Human or evidence bodies", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-review-inbox-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  const humanBody = "Never copy this authoritative Human body into the generated Inbox.";
  const conflict = await assertHumanKnowledge({
    runtimeRoot,
    vaultRoot,
    scope: { kind: "project", projectId: "msproj_123e4567-e89b-42d3-a456-426614174001" },
    body: humanBody,
    primaryCategory: "durable_reference",
    assertedAt: "2026-08-08T01:00:00.000Z",
    potentialConflictMemoryIds: []
  });
  if (conflict.state !== "created") throw new Error("Expected first Human Memory.");
  const proposedBody = "A conflicting proposal that must also stay out of the Inbox.";
  const proposed = await assertHumanKnowledge({
    runtimeRoot,
    vaultRoot,
    scope: { kind: "project", projectId: "msproj_123e4567-e89b-42d3-a456-426614174001" },
    body: proposedBody,
    primaryCategory: "durable_reference",
    assertedAt: "2026-08-08T01:01:00.000Z",
    potentialConflictMemoryIds: [conflict.memoryId]
  });
  if (proposed.state !== "conflict") throw new Error("Expected Human conflict.");
  const database = await openRuntimeDatabase(runtimeRoot);
  const verificationRequestId = `msverify_${randomUUID()}`;
  try {
    database.prepare(
      `INSERT INTO memory_candidates(
         candidate_id, fingerprint, scope_kind, project_id, statement,
         category, certainty, state, high_value, sensitivity,
         created_at, last_evidence_at, updated_at
       ) VALUES ('candidate-test', 'candidate-test-fingerprint', 'project', ?,
                 'candidate body excluded from inbox', 'test', 'asserted',
                 'waiting', 0, 'normal', ?, ?, ?)`
    ).run(
      "msproj_123e4567-e89b-42d3-a456-426614174001",
      "2026-08-08T01:02:00.000Z",
      "2026-08-08T01:02:00.000Z",
      "2026-08-08T01:02:00.000Z"
    );
    database.prepare(
      `INSERT INTO verification_requests(
         verification_request_id, candidate_id, description,
         proposed_action, state, created_at
       ) VALUES (?, ?, ?, ?, 'open', ?)`
    ).run(
      verificationRequestId,
      "candidate-test",
      "Run the focused test named by this bounded evidence gap.",
      "Run a focused test after explicit review.",
      "2026-08-08T01:02:00.000Z"
    );
  } finally {
    database.close();
  }

  const generated = await generateReviewInbox({
    runtimeRoot,
    vaultRoot,
    generatedAt: "2026-08-08T01:03:00.000Z"
  });
  const source = await readFile(generated.path, "utf8");
  expect(generated.counts).toMatchObject({ humanConflicts: 1, verificationRequests: 1 });
  expect(source).toContain(proposed.conflictId);
  expect(source).toContain("Verification Requests");
  expect(source).not.toContain(humanBody);
  expect(source).not.toContain(proposedBody);
  await expect(inspectReviewInbox({ runtimeRoot, vaultRoot })).resolves.toEqual(generated);

  await expect(applyReviewAction({
    runtimeRoot,
    vaultRoot,
    action: { kind: "complete_verification", verificationRequestId },
    appliedAt: "2026-08-08T01:04:00.000Z"
  })).resolves.toEqual({ state: "completed", kind: "complete_verification" });
  await expect(applyReviewAction({
    runtimeRoot,
    vaultRoot,
    action: {
      kind: "resolve_human_conflict",
      conflictId: proposed.conflictId,
      resolution: { kind: "keep_existing" }
    },
    appliedAt: "2026-08-08T01:04:01.000Z"
  })).resolves.toEqual({ state: "completed", kind: "resolve_human_conflict" });
  const resolved = await generateReviewInbox({
    runtimeRoot,
    vaultRoot,
    generatedAt: "2026-08-08T01:05:00.000Z"
  });
  expect(resolved.counts).toMatchObject({ humanConflicts: 0, verificationRequests: 0 });
});

test("Review Inbox aggregates large body-free Sensitivity Quarantine ledgers", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-review-sensitivity-aggregate-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    const insert = database.prepare(
      `INSERT INTO sensitivity_findings(
         finding_id, fingerprint, state, category, first_seen_at,
         last_seen_at, occurrence_count, body_retained
       ) VALUES (?, ?, 'quarantined', 'contextual_credential', ?, ?, ?, 0)`
    );
    for (let ordinal = 0; ordinal < 50; ordinal += 1) {
      insert.run(
        `msfinding_aggregate_${String(ordinal).padStart(2, "0")}`,
        `fingerprint-aggregate-${String(ordinal)}`,
        `2026-08-08T02:00:${String(ordinal).padStart(2, "0")}.000Z`,
        `2026-08-08T02:00:${String(ordinal).padStart(2, "0")}.000Z`,
        ordinal + 1
      );
    }
  } finally {
    database.close();
  }

  const generated = await generateReviewInbox({
    runtimeRoot,
    vaultRoot,
    generatedAt: "2026-08-08T03:00:00.000Z"
  });
  const source = await readFile(generated.path, "utf8");
  expect(generated.counts.sensitivityFindings).toBe(50);
  expect(source).toContain("Sensitivity Quarantine Summary");
  expect(source).toContain("50 findings");
  expect(source).toContain("1,275 occurrences");
  expect(source.match(/msfinding_aggregate_/gu)?.length ?? 0).toBeLessThanOrEqual(3);
  expect(source).not.toContain("msfinding_aggregate_00");
  expect(source.length).toBeLessThan(5_000);
});
