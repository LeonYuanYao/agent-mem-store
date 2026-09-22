import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { z } from "zod";
import { loadConfiguration } from "../configuration/index.js";
import { openRuntimeDatabase, openRuntimeDatabaseReadOnly } from "../runtime/database.js";

interface Paths { readonly runtimeRoot: string; readonly vaultRoot: string }

export class ActiveCapacityError extends Error {
  constructor(readonly limit: number) {
    super(`Active capacity limit (${String(limit)}) reached. Archive knowledge to free a slot, then retry; existing knowledge is unchanged.`);
    this.name = "ActiveCapacityError";
  }
}

export async function loadActiveCapacityLimit(paths: Paths): Promise<number | undefined> {
  try {
    const config = await loadConfiguration(paths);
    if (config.mode !== "read_write" || config.recovery !== undefined) throw new Error("Active admission requires current valid configuration.");
    return config.policy.corpusRetention.mode === "apply" ? config.policy.corpusRetention.policy.activeLimit : undefined;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

// Durable slots are never time-expired: a slow writer must not lose its slot.
// Dead writers with an unpublished file remain visible for reconciliation.
export async function recoverActiveAdmissions(runtimeRoot: string): Promise<number> {
  const reader = await openRuntimeDatabaseReadOnly(runtimeRoot);
  let rows;
  try { rows = z.array(z.object({ memory_id: z.string(), token: z.string(), owner_pid: z.number(), canonical_path: z.string() }))
    .parse(reader.prepare("SELECT * FROM active_capacity_admissions").all()); }
  finally { reader.close(); }
  let recovered = 0;
  for (const row of rows) {
    try { process.kill(row.owner_pid, 0); continue; }
    catch (error) { if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH")) continue; }
    let fileMissing = false;
    try { await access(row.canonical_path); }
    catch (error) { fileMissing = typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"; }
    const db = await openRuntimeDatabase(runtimeRoot);
    try { recovered += Number(db.prepare(`DELETE FROM active_capacity_admissions WHERE token=? AND
      (?=1 OR EXISTS (SELECT 1 FROM memory_catalog WHERE memory_id=? AND lifecycle='active'))`)
      .run(row.token, fileMissing ? 1 : 0, row.memory_id).changes); }
    finally { db.close(); }
  }
  return recovered;
}

export async function reserveActiveAdmission(request: Paths & { readonly memoryId: string; readonly path: string }): Promise<string | undefined> {
  const limit = await loadActiveCapacityLimit(request);
  if (limit === undefined) return undefined;
  await recoverActiveAdmissions(request.runtimeRoot);
  const db = await openRuntimeDatabase(request.runtimeRoot);
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      if (db.prepare("SELECT 1 FROM memory_catalog WHERE memory_id=? AND lifecycle='active'").get(request.memoryId) !== undefined) {
        db.exec("COMMIT"); return undefined;
      }
      if (db.prepare("SELECT 1 FROM active_capacity_admissions WHERE memory_id=?").get(request.memoryId) !== undefined) {
        throw new Error("Active admission is already in progress or requires reconciliation.");
      }
      const count = z.number().parse(db.prepare(`SELECT
        (SELECT COUNT(*) FROM memory_catalog WHERE lifecycle='active') +
        (SELECT COUNT(*) FROM active_capacity_admissions a WHERE NOT EXISTS
          (SELECT 1 FROM memory_catalog m WHERE m.memory_id=a.memory_id AND m.lifecycle='active')) AS n`).get()?.n);
      if (count >= limit) throw new ActiveCapacityError(limit);
      const token = randomUUID();
      db.prepare("INSERT INTO active_capacity_admissions VALUES (?, ?, ?, ?, ?)")
        .run(request.memoryId, token, process.pid, request.path, new Date().toISOString());
      db.exec("COMMIT");
      return token;
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  } finally { db.close(); }
}

export async function finishActiveAdmission(runtimeRoot: string, token: string, safeToRelease: boolean): Promise<void> {
  const db = await openRuntimeDatabase(runtimeRoot);
  try { db.prepare(`DELETE FROM active_capacity_admissions WHERE token=? AND
    (?=1 OR EXISTS (SELECT 1 FROM memory_catalog m WHERE m.memory_id=active_capacity_admissions.memory_id AND m.lifecycle='active'))`)
    .run(token, safeToRelease ? 1 : 0); }
  finally { db.close(); }
}

export async function resumeCapacityCandidates(paths: Paths): Promise<number> {
  let limit: number | undefined;
  try { limit = await loadActiveCapacityLimit(paths); }
  catch { return 0; }
  const db = await openRuntimeDatabaseReadOnly(paths.runtimeRoot);
  let slots: number;
  let waiting: boolean;
  try {
    slots = limit === undefined ? 50 : Math.max(0, limit - z.number().parse(db.prepare(`SELECT
      (SELECT COUNT(*) FROM memory_catalog WHERE lifecycle='active') +
      (SELECT COUNT(*) FROM active_capacity_admissions a WHERE NOT EXISTS
        (SELECT 1 FROM memory_catalog m WHERE m.memory_id=a.memory_id AND m.lifecycle='active')) AS n`).get()?.n));
    waiting = db.prepare(`SELECT 1 FROM active_capacity_waiters w JOIN memory_candidates c USING(candidate_id)
      WHERE c.state='waiting' AND c.successful_evaluation_at IS NOT NULL LIMIT 1`).get() !== undefined;
    const ready = z.number().parse(db.prepare(`SELECT COUNT(*) n FROM active_capacity_waiters w
      JOIN memory_candidates c USING(candidate_id) WHERE c.state='waiting' AND c.successful_evaluation_at IS NULL`).get()?.n);
    slots = Math.max(0, slots - ready);
  } finally { db.close(); }
  if (slots === 0 || !waiting) return 0;
  const writer = await openRuntimeDatabase(paths.runtimeRoot);
  try {
    return Number(writer.prepare(`UPDATE memory_candidates SET successful_evaluation_at=NULL WHERE candidate_id IN (
      SELECT w.candidate_id FROM active_capacity_waiters w JOIN memory_candidates c USING(candidate_id)
      WHERE c.state='waiting' AND c.successful_evaluation_at IS NOT NULL
      ORDER BY w.waiting_since, w.candidate_id LIMIT ?)` ).run(Math.min(slots, 50)).changes);
  } finally { writer.close(); }
}
