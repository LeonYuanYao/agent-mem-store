import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { resolveProject, inspectProject } from "../../src/projects/index.js";
import { readSessionProjectRoute, setSessionProjectRoute } from "../../src/projects/session-route.js";
import { migrateSessionProject } from "../../src/operations/session-migration.js";
import { createAgentCandidate } from "../../src/candidates/index.js";
import { captureEvent } from "../../src/capture/index.js";
import { openRuntimeDatabase } from "../../src/runtime/database.js";
import { readCanonicalMemory, writeCanonicalMemory } from "../../src/vault/index.js";
import { handleCodexHook } from "../../src/adapters/codex/hook.js";
import { makeCanonicalMemory } from "../helpers/canonical-memory.js";
import { prepareNextDistillationBatch, runNextLunaWork } from "../../src/worker/distillation.js";
import { makeLongTermCandidateDurability } from "../helpers/candidate-durability.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "memstore-session-migration-")); roots.push(root);
  const runtimeRoot = join(root, "runtime"), vaultRoot = join(root, "vault");
  const path = join(root, "source"), target = join(root, "target");
  await mkdir(path); await mkdir(target);
  const source = await resolveProject({ path, runtimeRoot });
  const destination = await resolveProject({ path: target, runtimeRoot });
  if (source.status !== "resolved" || destination.status !== "resolved") throw new Error("Fixture resolution failed.");
  return { runtimeRoot, vaultRoot, path, sourceProjectId: source.projectId,
    targetProjectId: destination.projectId, sessionId: "session-to-move", preview: false };
}

test("exact session route changes hook project without changing the cwd registry or other threads", async () => {
  const f = await fixture();
  await setSessionProjectRoute({ ...f, projectId: f.targetProjectId });
  expect(await inspectProject(f)).toMatchObject({ projectId: f.targetProjectId, source: "session_override" });
  expect(await inspectProject({ ...f, sessionId: "forked-session" })).toMatchObject({ projectId: f.sourceProjectId });
  expect(await inspectProject({ path: f.path, runtimeRoot: f.runtimeRoot })).toMatchObject({ projectId: f.sourceProjectId });
  expect(await handleCodexHook({ runtimeRoot: f.runtimeRoot, input: {
    hook_event_name: "UserPromptSubmit", session_id: f.sessionId, turn_id: "after-move", cwd: f.path,
    prompt: "Use the registered project for future work."
  } })).toMatchObject({ captured: true, projectId: f.targetProjectId });
});

test("migration previews without writes, preserves authorship and references, and safely replays", async () => {
  const f = await fixture();
  const memory = { ...makeCanonicalMemory({ memoryId: `msmem_${randomUUID()}`,
    revisionId: `msrev_${randomUUID()}`, body: "Prefer the designated review platform.",
    scope: { kind: "project" as const, projectId: f.sourceProjectId }, authority: "agent_derived" }),
    provenance: [`codex:${f.sessionId}:turn-one`] };
  const written = await writeCanonicalMemory({ ...f, actor: "agent", memory });
  const eventId = `msev_${randomUUID()}`;
  await captureEvent({ runtimeRoot: f.runtimeRoot, event: {
    schemaVersion: 1, eventId, deduplicationKey: eventId, agent: "codex", eventKind: "UserPromptSubmit",
    occurredAt: memory.createdAt, sessionId: f.sessionId, turnId: "turn-one", projectId: f.sourceProjectId,
    payload: { text: memory.body }
  } });
  const db = await openRuntimeDatabase(f.runtimeRoot);
  const hash = db.prepare("SELECT whole_content_sha256 FROM capture_events WHERE event_id = ?").get(eventId)?.whole_content_sha256;
  if (typeof hash !== "string") throw new Error("Missing evidence hash.");
  const evidence = [{ evidenceId: eventId, evidenceClass: "explicit_user_statement" as const,
    sourceIdentity: `codex:${f.sessionId}:turn-one`, projectId: f.sourceProjectId,
    occurredAt: memory.createdAt, integrity: "intact" as const, sourceTruncated: false, memoryEcho: false,
    evidenceContentIdentity: hash }];
  const candidate = await createAgentCandidate({ runtimeRoot: f.runtimeRoot,
    scope: memory.scope, sourceSessionId: f.sessionId, createdAt: memory.createdAt, evidence,
    candidate: { statement: memory.body, primaryCategory: "preference_constraint", categoryTags: ["preference_constraint"],
      applicabilitySummary: "Review workflow", conditions: [], exclusions: [], preservedNegations: [], certainty: "asserted", importanceTags: [] }
  });
  if (!("candidateId" in candidate)) throw new Error("Fixture candidate failed.");
  db.prepare("UPDATE memory_candidates SET state = 'promoted', promoted_memory_id = ?, promotion_revision_id = ? WHERE candidate_id = ?")
    .run(memory.memoryId, memory.revisionId, candidate.candidateId);
  expect(await migrateSessionProject({ ...f, preview: true })).toMatchObject({ dry_run: true, memories: 1, candidates: 1 });
  expect(await readSessionProjectRoute(f.runtimeRoot, f.sessionId)).toBeUndefined();
  await expect(migrateSessionProject(f)).rejects.toThrow("Pause and stop");
  db.prepare("INSERT OR REPLACE INTO worker_control(singleton, worker_paused, updated_at) VALUES (1, 1, ?)").run(memory.createdAt);
  const result = await migrateSessionProject(f);
  expect(result).toMatchObject({ state: "migrated", memories: 1, candidates: 1 });
  const moved = await readCanonicalMemory({ ...f, memoryId: memory.memoryId });
  if (moved === undefined) throw new Error("Moved memory missing.");
  expect(moved.memory).toMatchObject({ body: memory.body, memoryRef: written.memoryRef,
    authority: "agent_derived", provenance: memory.provenance, predecessorRevisionId: memory.revisionId,
    scope: { kind: "project", projectId: f.targetProjectId } });
  await expect(readFile(written.path)).rejects.toMatchObject({ code: "ENOENT" });
  expect(db.prepare("SELECT project_id, promotion_revision_id FROM memory_candidates WHERE candidate_id = ?").get(candidate.candidateId))
    .toMatchObject({ project_id: f.targetProjectId, promotion_revision_id: moved.memory.revisionId });
  // Simulate a crash after catalog commit, before removing the old canonical path.
  const plan = JSON.parse(await readFile(result.planPath, "utf8")) as { items: { source: string }[] };
  await writeFile(written.path, plan.items[0]?.source ?? "");
  expect(await migrateSessionProject(f)).toMatchObject({ state: "migrated", memories: 1 });
  await expect(readFile(written.path)).rejects.toMatchObject({ code: "ENOENT" });
  expect((await readCanonicalMemory({ ...f, memoryId: memory.memoryId }))?.memory.revisionId).toBe(moved.memory.revisionId);
  const next = await createAgentCandidate({ runtimeRoot: f.runtimeRoot,
    scope: { kind: "project", projectId: f.targetProjectId }, sourceSessionId: f.sessionId,
    createdAt: memory.createdAt, evidence,
    candidate: { statement: "Another durable rule.", primaryCategory: "preference_constraint", categoryTags: ["preference_constraint"],
      applicabilitySummary: "Review workflow", conditions: [], exclusions: [], preservedNegations: [], certainty: "asserted", importanceTags: [] }
  });
  if (!("candidateId" in next)) throw new Error("Routed candidate failed.");
  expect(db.prepare("SELECT project_id FROM candidate_evidence WHERE candidate_id = ?").get(next.candidateId))
    .toMatchObject({ project_id: f.sourceProjectId });
  db.close();
});

test("a pre-route queued batch uses the new scope but retains original evidence", async () => {
  const f = await fixture();
  const eventId = `msev_${randomUUID()}`;
  await captureEvent({ runtimeRoot: f.runtimeRoot, event: {
    schemaVersion: 1, eventId, deduplicationKey: eventId, agent: "codex", eventKind: "UserPromptSubmit",
    occurredAt: "2026-08-07T00:00:00.000Z", sessionId: f.sessionId, turnId: "old-turn", projectId: f.sourceProjectId,
    payload: { text: "Use the designated review platform for merge requests." }
  } });
  const endId = `msev_${randomUUID()}`;
  await captureEvent({ runtimeRoot: f.runtimeRoot, event: {
    schemaVersion: 1, eventId: endId, deduplicationKey: endId, agent: "codex", eventKind: "SessionEnd",
    occurredAt: "2026-08-07T00:01:00.000Z", sessionId: f.sessionId, projectId: f.sourceProjectId, payload: {}
  } });
  expect(await prepareNextDistillationBatch({ runtimeRoot: f.runtimeRoot, maximumEvents: 2,
    preparedAt: "2026-08-07T01:00:00.000Z" })).toMatchObject({ state: "queued" });
  await setSessionProjectRoute({ ...f, projectId: f.targetProjectId });
  expect(await runNextLunaWork({ runtimeRoot: f.runtimeRoot, workerId: "test-worker", now: "2026-08-07T01:01:00.000Z",
    adapter: {
      distillBatch: (request) => {
        expect(request.scope).toEqual({ kind: "project", projectId: f.targetProjectId });
        expect(request.evidence[0]?.projectId).toBe(f.sourceProjectId);
        return Promise.resolve({ schemaVersion: 1, kind: "distillation", candidates: [{
          statement: "Use the designated review platform for merge requests.", primaryCategory: "preference_constraint",
          categoryTags: ["preference_constraint"], applicabilitySummary: "Merge requests", conditions: [], exclusions: [],
          preservedNegations: [], certainty: "asserted", sensitivity: "normal", evidenceIds: [eventId],
          importanceTags: ["constraint"], importanceReasons: [{ tag: "constraint", reason: "Explicit preference", evidenceIds: [eventId] }],
          durability: makeLongTermCandidateDurability()
        }] });
      },
      consolidateSession: () => { throw new Error("Not expected for a batch."); }
    }
  })).toMatchObject({ state: "completed" });
  const db = await openRuntimeDatabase(f.runtimeRoot);
  try {
    expect(db.prepare("SELECT project_id FROM memory_candidates WHERE source_session_id = ?").get(f.sessionId))
      .toMatchObject({ project_id: f.targetProjectId });
    expect(db.prepare("SELECT project_id FROM capture_events WHERE event_id = ?").get(eventId))
      .toMatchObject({ project_id: f.sourceProjectId });
  } finally { db.close(); }
});
