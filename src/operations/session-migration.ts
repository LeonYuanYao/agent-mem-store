import { createHash } from "node:crypto";
import { mkdir, readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

import { candidateFingerprint } from "../candidates/index.js";
import { writeFileAtomicallyExclusive } from "../contracts/atomic-file.js";
import { setSessionProjectRoute } from "../projects/session-route.js";
import { openRuntimeDatabase } from "../runtime/database.js";
import { ensurePortableProjectCatalog, inspectStandaloneCanonicalFile, renderCanonicalProjectMigration } from "../vault/index.js";

const candidateShape = z.object({
  statement: z.string(), applicabilitySummary: z.string(), conditions: z.array(z.string()),
  exclusions: z.array(z.string()), preservedNegations: z.array(z.string()),
  sensitivity: z.enum(["normal", "private"]).default("normal")
});
const itemSchema = z.object({
  memoryId: z.string(), sourcePath: z.string(), targetPath: z.string(),
  source: z.string(), target: z.string(), oldIdentity: z.string(), newIdentity: z.string(),
  oldRevisionId: z.string(), newRevisionId: z.string(), revisedAt: z.string()
});
const planSchema = z.object({
  sessionId: z.string(), sourceProjectId: z.string(), targetProjectId: z.string(),
  vaultRoot: z.string(), createdAt: z.string(), items: z.array(itemSchema),
  candidates: z.array(z.object({ candidateId: z.string(), oldFingerprint: z.string(), newFingerprint: z.string() }))
});

/** Offline maintenance operation. Stop the worker and back up DB + Vault before apply.
 * The durable plan makes interrupted per-Memory file/catalog moves replayable.
 * Capture/evidence/receipts and old revisions are never rewritten.
 */
export async function migrateSessionProject(request: {
  readonly runtimeRoot: string; readonly vaultRoot: string;
  readonly sessionId: string; readonly sourceProjectId: string; readonly targetProjectId: string;
  readonly preview: boolean;
}) {
  if (request.sourceProjectId === request.targetProjectId) throw new Error("Source and target must differ.");
  const key = createHash("sha256").update(JSON.stringify([
    request.sessionId, request.sourceProjectId, request.targetProjectId
  ])).digest("hex");
  const planPath = join(request.runtimeRoot, "state", "session-migrations", `${key}.json`);
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    if (!request.preview && database.prepare("SELECT worker_paused FROM worker_control WHERE singleton = 1").get()?.worker_paused !== 1) {
      throw new Error("Pause and stop the worker, then back up DB and Vault before applying a session migration.");
    }
    for (const projectId of [request.sourceProjectId, request.targetProjectId]) {
      if (database.prepare("SELECT 1 FROM projects WHERE project_id = ?").get(projectId) === undefined) {
        throw new Error("Both projects must already be registered.");
      }
    }
    let saved: string | undefined;
    try { saved = await readFile(planPath, "utf8"); } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    let plan: z.infer<typeof planSchema>;
    if (saved !== undefined) {
      plan = planSchema.parse(JSON.parse(saved));
      if (plan.vaultRoot !== request.vaultRoot || plan.sessionId !== request.sessionId ||
          plan.sourceProjectId !== request.sourceProjectId || plan.targetProjectId !== request.targetProjectId) {
        throw new Error("Migration plan identity mismatch.");
      }
    } else {
      const candidates = z.array(z.object({
        candidate_id: z.string(), candidate_json: z.string(), fingerprint: z.string(),
        promoted_memory_id: z.string().nullable()
      })).parse(database.prepare(
        `SELECT candidate_id, candidate_json, fingerprint, promoted_memory_id FROM memory_candidates
         WHERE source_session_id = ? AND project_id = ? AND scope_kind = 'project'
           AND state NOT IN ('expired', 'rejected')`
      ).all(request.sessionId, request.sourceProjectId));
      const createdAt = new Date().toISOString();
      const items: z.infer<typeof itemSchema>[] = [];
      for (const memoryId of new Set(candidates.flatMap((c) => c.promoted_memory_id === null ? [] : [c.promoted_memory_id]))) {
        if (database.prepare("SELECT 1 FROM memory_candidates WHERE promoted_memory_id = ? AND source_session_id IS NOT ?")
          .get(memoryId, request.sessionId) !== undefined) {
          throw new Error(`Memory is also linked to another source: ${memoryId}`);
        }
        const row = z.object({ canonical_path: z.string(), project_id: z.string() }).parse(database.prepare(
          "SELECT canonical_path, project_id FROM memory_catalog WHERE memory_id = ?"
        ).get(memoryId));
        if (row.project_id !== request.sourceProjectId) throw new Error("Memory already belongs to another project.");
        const inspected = await inspectStandaloneCanonicalFile(row.canonical_path);
        if (inspected.memory.provenance.some((p) => p.startsWith("codex:") && !p.startsWith(`codex:${request.sessionId}:`))) {
          throw new Error(`Shared-source Memory requires separate review: ${memoryId}`);
        }
        const source = await readFile(row.canonical_path, "utf8");
        const target = renderCanonicalProjectMigration({ source, projectId: request.targetProjectId, migratedAt: createdAt });
        items.push({ memoryId, sourcePath: row.canonical_path,
          targetPath: join(request.vaultRoot, "Memories", "Projects", request.targetProjectId, `${memoryId}.md`),
          source, target: target.source, oldIdentity: inspected.contentIdentity,
          newIdentity: target.contentIdentity, oldRevisionId: inspected.memory.revisionId,
          newRevisionId: target.memory.revisionId, revisedAt: createdAt });
      }
      plan = {
        sessionId: request.sessionId, sourceProjectId: request.sourceProjectId,
        targetProjectId: request.targetProjectId, vaultRoot: request.vaultRoot, createdAt, items,
        candidates: candidates.map((c) => ({ candidateId: c.candidate_id, oldFingerprint: c.fingerprint,
          newFingerprint: candidateFingerprint({ kind: "project", projectId: request.targetProjectId },
            candidateShape.parse(JSON.parse(c.candidate_json))) }))
      };
      for (const c of plan.candidates) {
        if (database.prepare("SELECT 1 FROM memory_candidates WHERE fingerprint = ? AND candidate_id != ? AND state != 'expired'")
          .get(c.newFingerprint, c.candidateId) !== undefined) throw new Error("Target candidate collision requires separate review.");
      }
      if (!request.preview) {
        await mkdir(dirname(planPath), { recursive: true, mode: 0o700 });
        await writeFileAtomicallyExclusive(planPath, JSON.stringify(plan), 0o600);
      }
    }
    if (request.preview) return { dry_run: true, memories: plan.items.length, candidates: plan.candidates.length, planPath };
    await ensurePortableProjectCatalog(request.vaultRoot, request.runtimeRoot, request.targetProjectId);
    // Published index revisions are immutable. Unselect the old snapshot instead
    // of editing its documents; the worker rebuilds before normal recall resumes.
    if (plan.items.some((item) => database.prepare(
      "SELECT 1 FROM memory_catalog WHERE memory_id = ? AND content_identity = ?"
    ).get(item.memoryId, item.oldIdentity) !== undefined)) {
      database.prepare("DELETE FROM active_retrieval_index WHERE singleton = 1").run();
    }
    await setSessionProjectRoute({ runtimeRoot: request.runtimeRoot, sessionId: request.sessionId, projectId: request.targetProjectId });
    for (const item of plan.items) {
      const row = z.object({ content_identity: z.string(), canonical_path: z.string() }).parse(database.prepare(
        "SELECT content_identity, canonical_path FROM memory_catalog WHERE memory_id = ?"
      ).get(item.memoryId));
      if (row.content_identity !== item.oldIdentity && row.content_identity !== item.newIdentity) {
        throw new Error(`Concurrent Memory change: ${item.memoryId}`);
      }
      let oldSource: string | undefined;
      try { oldSource = await readFile(item.sourcePath, "utf8"); } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      if (oldSource !== undefined && oldSource !== item.source) throw new Error("Source changed after migration planning.");
      if (row.content_identity === item.oldIdentity && oldSource === undefined) throw new Error("Source is missing.");
      const revisionPath = join(request.vaultRoot, "_MemStore", "Revisions", item.memoryId, `${item.newRevisionId}.md`);
      for (const path of [item.targetPath, revisionPath]) {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        try { await writeFileAtomicallyExclusive(path, item.target, 0o600); } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
          if (await readFile(path, "utf8") !== item.target) throw new Error("Migration target collision.");
        }
      }
      database.exec("BEGIN IMMEDIATE");
      try {
        database.prepare(`INSERT OR IGNORE INTO memory_revisions
          (revision_id, memory_id, predecessor_revision_id, revision_path, content_identity, created_at)
          VALUES (?, ?, ?, ?, ?, ?)`).run(item.newRevisionId, item.memoryId, item.oldRevisionId, revisionPath, item.newIdentity, item.revisedAt);
        database.prepare(`UPDATE memory_catalog SET current_revision_id = ?, canonical_path = ?, project_id = ?,
          content_identity = ?, revised_at = ?, catalog_updated_at = ? WHERE memory_id = ? AND content_identity = ?`)
          .run(item.newRevisionId, item.targetPath, request.targetProjectId, item.newIdentity, item.revisedAt, item.revisedAt, item.memoryId, item.oldIdentity);
        database.prepare("UPDATE memory_relationships SET source_revision_id = ? WHERE source_memory_id = ?")
          .run(item.newRevisionId, item.memoryId);
        database.prepare("UPDATE memory_ranking_exclusions SET revision_id = ?, space_key = ? WHERE memory_id = ?")
          .run(item.newRevisionId, `project:${request.targetProjectId}`, item.memoryId);
        database.exec("COMMIT");
      } catch (error) { database.exec("ROLLBACK"); throw error; }
      if (oldSource !== undefined) await unlink(item.sourcePath);
    }
    database.exec("BEGIN IMMEDIATE");
    try {
      for (const c of plan.candidates) {
        const updated = database.prepare(`UPDATE memory_candidates SET project_id = ?, fingerprint = ?, updated_at = ?,
          promotion_revision_id = COALESCE((SELECT current_revision_id FROM memory_catalog WHERE memory_id = promoted_memory_id), promotion_revision_id)
          WHERE candidate_id = ? AND fingerprint IN (?, ?)`)
          .run(request.targetProjectId, c.newFingerprint, plan.createdAt, c.candidateId, c.oldFingerprint, c.newFingerprint);
        if (updated.changes !== 1) throw new Error(`Concurrent Candidate change: ${c.candidateId}`);
      }
      database.exec("COMMIT");
    } catch (error) { database.exec("ROLLBACK"); throw error; }
    return { state: "migrated", memories: plan.items.length, candidates: plan.candidates.length, planPath };
  } finally { database.close(); }
}
