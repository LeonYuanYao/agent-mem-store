import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

interface CompactQualitySource {
  readonly memoryId: string;
  readonly revisionId: string;
  readonly authority: "human_authored" | "agent_derived";
  readonly lifecycle: "active" | "archived" | "tombstone";
  readonly representations: {
    readonly compact: {
      readonly text: string;
      readonly validated: boolean;
      readonly sourceRevisionId: string;
    };
  };
}

export function enqueueCompactQualityRecord(database: DatabaseSync, request: {
  readonly memory: CompactQualitySource;
  readonly sourceContentIdentity: string;
  readonly requestedAt: string;
}): {
  readonly state: "disabled" | "not_eligible" | "enqueued" | "already_queued";
} {
  const requestedAt = z.iso.datetime().parse(request.requestedAt);
  if (
    request.memory.authority !== "agent_derived" ||
    request.memory.lifecycle !== "active" ||
    (request.memory.representations.compact.validated &&
      request.memory.representations.compact.sourceRevisionId === request.memory.revisionId &&
      request.memory.representations.compact.text.trim().length > 0)
  ) return { state: "not_eligible" };
  const schedule = database.prepare(
    "SELECT enabled FROM memory_quality_schedule WHERE singleton = 1"
  ).get();
  if (schedule?.enabled !== 1) return { state: "disabled" };
  const result = database.prepare(
    `INSERT OR IGNORE INTO memory_quality_items(
       item_id, memory_id, source_revision_id, source_content_identity,
       state, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'pending_generation', ?, ?)`
  ).run(
    `msquality_${randomUUID()}`,
    request.memory.memoryId,
    request.memory.revisionId,
    request.sourceContentIdentity,
    requestedAt,
    requestedAt
  );
  return { state: result.changes === 1 ? "enqueued" : "already_queued" };
}
