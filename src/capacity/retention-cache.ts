import { z } from "zod";
import { openRuntimeDatabase, openRuntimeDatabaseReadOnly } from "../runtime/database.js";
import { readCanonicalMemory, type CanonicalMemory } from "../vault/index.js";
import { retentionAssessmentSchema, retentionSubjectHash, retentionValuePolicyVersion, type RetentionAssessment, type RetentionSubject } from "./retention-value.js";

const cacheSchema = z.object({ subject_hash: z.string(), assessment_json: z.string(), assessed_at: z.iso.datetime() });
export interface CachedRetentionAssessment {
  readonly subjectHash: string;
  readonly assessment: RetentionAssessment;
  readonly assessedAt: string;
}

export async function loadRetentionAssessmentCache(runtimeRoot: string): Promise<ReadonlyMap<string, CachedRetentionAssessment>> {
  const database = await openRuntimeDatabaseReadOnly(runtimeRoot, { minimumSchemaVersion: 61 });
  const result = new Map<string, CachedRetentionAssessment>();
  try {
    if (database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_retention_assessments'").get() === undefined) return result;
    for (const row of database.prepare("SELECT * FROM memory_retention_assessments").all()) {
      const parsed = cacheSchema.safeParse(row);
      if (!parsed.success || typeof row.memory_id !== "string") continue;
      try {
        const assessment = retentionAssessmentSchema.parse(JSON.parse(parsed.data.assessment_json));
        if (assessment.policyVersion === retentionValuePolicyVersion) result.set(row.memory_id, {
          subjectHash: parsed.data.subject_hash, assessment, assessedAt: parsed.data.assessed_at
        });
      } catch { /* Invalid derived data is an unknown assessment, not a low-value judgment. */ }
    }
    return result;
  } finally { database.close(); }
}

export function matchRetentionAssessment(cache: ReadonlyMap<string, CachedRetentionAssessment>, memory: RetentionSubject & { readonly memoryId: string }): CachedRetentionAssessment | undefined {
  const entry = cache.get(memory.memoryId);
  return entry?.subjectHash === retentionSubjectHash(memory) && entry.assessment.policyVersion === retentionValuePolicyVersion ? entry : undefined;
}

export async function readRetentionAssessment(request: { readonly runtimeRoot: string; readonly memory: RetentionSubject & { readonly memoryId: string } }): Promise<CachedRetentionAssessment | undefined> {
  return matchRetentionAssessment(await loadRetentionAssessmentCache(request.runtimeRoot), request.memory);
}

export async function recordRetentionAssessment(request: {
  readonly runtimeRoot: string; readonly vaultRoot: string; readonly memory: CanonicalMemory;
  readonly assessment: RetentionAssessment; readonly assessedAt: string;
}): Promise<"stored" | "unchanged" | "stale"> {
  const assessment = retentionAssessmentSchema.parse(request.assessment);
  if (assessment.policyVersion !== retentionValuePolicyVersion || request.memory.authority !== "agent_derived") return "stale";
  const assessedAt = z.iso.datetime().parse(request.assessedAt);
  const subjectHash = retentionSubjectHash(request.memory);
  const current = await readCanonicalMemory({ ...request, memoryId: request.memory.memoryId });
  if (current === undefined || current.memory.authority !== "agent_derived" || current.memory.lifecycle !== "active" ||
      retentionSubjectHash(current.memory) !== subjectHash) return "stale";
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    const existing = database.prepare("SELECT assessment_json FROM memory_retention_assessments WHERE memory_id=?").get(current.memory.memoryId);
    let invalidExisting = false;
    if (typeof existing?.assessment_json === "string") {
      try { invalidExisting = !retentionAssessmentSchema.safeParse(JSON.parse(existing.assessment_json)).success; }
      catch { invalidExisting = true; }
    }
    const changed = database.prepare(`INSERT INTO memory_retention_assessments(memory_id, subject_hash, assessment_json, assessed_at)
      SELECT memory_id, ?, ?, ? FROM memory_catalog
      WHERE memory_id=? AND current_revision_id=? AND content_identity=? AND authority='agent_derived' AND lifecycle='active'
      ON CONFLICT(memory_id) DO UPDATE SET subject_hash=excluded.subject_hash,
        assessment_json=excluded.assessment_json, assessed_at=excluded.assessed_at
      WHERE memory_retention_assessments.subject_hash!=excluded.subject_hash
        OR json_extract(memory_retention_assessments.assessment_json, '$.policyVersion') IS NOT ? OR ?=1`)
      .run(subjectHash, JSON.stringify(assessment), assessedAt, current.memory.memoryId,
        current.memory.revisionId, current.contentIdentity, retentionValuePolicyVersion, invalidExisting ? 1 : 0);
    return changed.changes === 1 ? "stored" : "unchanged";
  } finally { database.close(); }
}
