import { createHash, randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { z } from "zod";

import type { NotifierPort } from "../adapters/macos/notifier.js";
import { openRuntimeDatabase } from "../runtime/database.js";
import { inspectReviewInbox } from "./inbox.js";

type PreparedReminder =
  | { readonly state: "empty" }
  | { readonly state: "pending"; readonly reminderId: string; readonly digestKey: string };

const modelHealthStateSchema = z.enum(["degraded", "unavailable", "recovered"]);

export async function prepareNextModelHealthReminder(request: {
  readonly runtimeRoot: string;
  readonly vaultRoot: string;
  readonly preparedAt: string;
}): Promise<PreparedReminder> {
  const preparedAt = z.iso.datetime().parse(request.preparedAt);
  const database = await openRuntimeDatabase(request.runtimeRoot);
  const pendingIncidentsSql = `SELECT incident_id, state, reason_category, transition_count
       FROM model_health_incidents WHERE notification_pending = 1
       ORDER BY started_at, incident_id`;
  try {
    if (database.prepare(pendingIncidentsSql).get() === undefined) {
      return { state: "empty" };
    }
    database.exec("BEGIN IMMEDIATE");
    const rows = database.prepare(pendingIncidentsSql).all();
    if (rows.length === 0) {
      database.exec("COMMIT");
      return { state: "empty" };
    }
    const health = database.prepare(
      "SELECT state, reason_category FROM luna_health_state WHERE singleton = 1"
    ).get();
    const latest = rows[rows.length - 1];
    const currentHealth = z.enum(["healthy", "degraded", "unavailable"]).parse(health?.state);
    const notificationState = rows.length === 1
      ? modelHealthStateSchema.parse(latest?.state)
      : currentHealth === "healthy"
        ? "recovered"
        : currentHealth;
    const reasonCategory = z.string().min(1).max(64).parse(
      notificationState === "recovered" ? latest?.reason_category : health?.reason_category
    );
    const title = notificationState === "recovered"
      ? "MemStore Luna recovered"
      : notificationState === "degraded"
        ? "MemStore Luna degraded"
        : "MemStore Luna unavailable";
    const body = rows.length > 1
      ? notificationState === "recovered"
        ? `Luna is healthy; ${String(rows.length)} pending historical health notices were reconciled.`
        : `Luna is ${notificationState}; ${String(rows.length)} pending health transitions were reconciled. Latest reason: ${reasonCategory}.`
      : notificationState === "recovered"
        ? `Luna recovered from ${reasonCategory}; queued memory work will continue.`
        : notificationState === "degraded"
          ? `Luna is degraded due to ${reasonCategory}; capture and existing recall remain available.`
          : `Luna is unavailable due to ${reasonCategory}; capture continues and model work remains queued.`;
    z.string().min(1).max(80).parse(title);
    z.string().min(1).max(160).parse(body);
    const digestSource = rows.map((row) => [
      z.string().parse(row.incident_id),
      modelHealthStateSchema.parse(row.state),
      z.number().int().nonnegative().parse(row.transition_count)
    ].join(":")) .join("|");
    const digestKey = `model-health:${createHash("sha256").update(digestSource).digest("hex")}`;
    const proposedReminderId = `msreminder_${randomUUID()}`;
    database.prepare(
      `INSERT OR IGNORE INTO reminder_obligations(
         reminder_id, digest_key, state, counts_json, issue_categories_json,
         inbox_path, due_at, created_at, updated_at,
         notification_title, notification_body
       ) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      proposedReminderId,
      digestKey,
      JSON.stringify({ modelHealthIncidents: rows.length }),
      JSON.stringify(["model_health"]),
      join(request.vaultRoot, "_MemStore", "Review Inbox.md"),
      preparedAt,
      preparedAt,
      preparedAt,
      title,
      body
    );
    const reminderId = z.string().parse(database.prepare(
      "SELECT reminder_id FROM reminder_obligations WHERE digest_key = ?"
    ).get(digestKey)?.reminder_id);
    const clearPending = database.prepare(
      "UPDATE model_health_incidents SET notification_pending = 0 WHERE incident_id = ?"
    );
    for (const row of rows) clearPending.run(z.string().parse(row.incident_id));
    database.exec("COMMIT");
    return { state: "pending", reminderId, digestKey };
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}

export async function prepareReviewReminder(request: {
  readonly runtimeRoot: string;
  readonly vaultRoot: string;
  readonly digestKey: string;
  readonly dueAt: string;
  readonly createdAt: string;
}): Promise<PreparedReminder> {
  const dueAt = z.iso.datetime().parse(request.dueAt);
  const createdAt = z.iso.datetime().parse(request.createdAt);
  const digestKey = z.string().min(1).max(256).parse(request.digestKey);
  const inbox = await inspectReviewInbox(request);
  if (inbox === undefined) throw new Error("Review Inbox must be generated before its reminder.");
  const total = Object.values(inbox.counts).reduce((sum, value) => sum + value, 0);
  if (total === 0) return { state: "empty" };
  const categories = Object.entries(inbox.counts)
    .filter(([, count]) => count > 0)
    .map(([category]) => category);
  const reminderId = `msreminder_${randomUUID()}`;
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    database.prepare(
      `INSERT OR IGNORE INTO reminder_obligations(
         reminder_id, digest_key, state, counts_json, issue_categories_json,
         inbox_path, due_at, created_at, updated_at
       ) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?)`
    ).run(
      reminderId,
      digestKey,
      JSON.stringify(inbox.counts),
      JSON.stringify(categories),
      inbox.path,
      dueAt,
      createdAt,
      createdAt
    );
    const row = database.prepare(
      "SELECT reminder_id FROM reminder_obligations WHERE digest_key = ?"
    ).get(digestKey);
    return {
      state: "pending",
      reminderId: z.string().parse(row?.reminder_id),
      digestKey
    };
  } finally {
    database.close();
  }
}

function obsidianOpenUri(inboxPath: string): string {
  const vaultName = basename(inboxPath.split("/_MemStore/")[0] ?? "");
  return `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent("_MemStore/Review Inbox.md")}`;
}

export async function dispatchNextReminder(request: {
  readonly runtimeRoot: string;
  readonly now: string;
  readonly notifier: NotifierPort;
}): Promise<
  | { readonly state: "empty" }
  | { readonly state: "delivered" | "failed" | "fallback"; readonly reminderId: string }
> {
  const now = z.iso.datetime().parse(request.now);
  const database = await openRuntimeDatabase(request.runtimeRoot);
  let row: Record<string, unknown> | undefined;
  const dueReminderSql = `SELECT * FROM reminder_obligations
       WHERE (
         (state = 'pending' AND due_at <= ?)
         OR (state = 'failed' AND next_retry_at <= ?)
         OR (state = 'snoozed' AND snoozed_until <= ?)
       ) ORDER BY due_at, created_at LIMIT 1`;
  try {
    if (database.prepare(dueReminderSql).get(now, now, now) === undefined) {
      return { state: "empty" };
    }
    database.exec("BEGIN IMMEDIATE");
    row = database.prepare(dueReminderSql).get(now, now, now);
    if (row === undefined) {
      database.exec("COMMIT");
      return { state: "empty" };
    }
    const selectedReminderId = z.string().parse(row.reminder_id);
    database.prepare(
      `UPDATE reminder_obligations
       SET state = 'delivering', attempt_count = attempt_count + 1, updated_at = ?
       WHERE reminder_id = ?`
    ).run(now, selectedReminderId);
    database.exec("COMMIT");
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
  const reminderId = z.string().parse(row.reminder_id);
  const counts = z.record(z.string(), z.number().int().nonnegative()).parse(
    JSON.parse(z.string().parse(row.counts_json))
  );
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  const title = typeof row.notification_title === "string"
    ? z.string().min(1).max(80).parse(row.notification_title)
    : "MemStore review available";
  const body = typeof row.notification_body === "string"
    ? z.string().min(1).max(160).parse(row.notification_body)
    : `${String(total)} items are ready in Review Inbox.`;
  const result = await request.notifier.deliver({
    reminderId,
    title,
    body,
    openUri: obsidianOpenUri(z.string().parse(row.inbox_path)),
    snoozeDays: 7
  });
  const resultDatabase = await openRuntimeDatabase(request.runtimeRoot);
  try {
    resultDatabase.exec("BEGIN IMMEDIATE");
    const attemptId = `msreminderattempt_${randomUUID()}`;
    if (result.state === "delivered") {
      resultDatabase.prepare(
        `INSERT INTO reminder_attempts(
           attempt_id, reminder_id, outcome, attempted_at, adapter_receipt
         ) VALUES (?, ?, 'delivered', ?, ?)`
      ).run(attemptId, reminderId, now, result.receipt);
      resultDatabase.prepare(
        `UPDATE reminder_obligations
         SET state = 'delivered', delivered_at = ?, updated_at = ?,
             next_retry_at = NULL, last_error_code = NULL
         WHERE reminder_id = ? AND state = 'delivering'`
      ).run(now, now, reminderId);
      resultDatabase.exec("COMMIT");
      return { state: "delivered", reminderId };
    }
    const fallback = result.state === "permission_denied";
    resultDatabase.prepare(
      `INSERT INTO reminder_attempts(
         attempt_id, reminder_id, outcome, attempted_at, error_code
       ) VALUES (?, ?, ?, ?, ?)`
    ).run(attemptId, reminderId, result.state, now, result.errorCode);
    const nextRetryAt = fallback
      ? null
      : new Date(Date.parse(now) + 5 * 60 * 1000).toISOString();
    resultDatabase.prepare(
      `UPDATE reminder_obligations
       SET state = ?, next_retry_at = ?, last_error_code = ?, updated_at = ?
       WHERE reminder_id = ? AND state = 'delivering'`
    ).run(fallback ? "fallback" : "failed", nextRetryAt, result.errorCode, now, reminderId);
    resultDatabase.exec("COMMIT");
    return { state: fallback ? "fallback" : "failed", reminderId };
  } catch (error) {
    resultDatabase.exec("ROLLBACK");
    throw error;
  } finally {
    resultDatabase.close();
  }
}

export async function snoozeReminder(request: {
  readonly runtimeRoot: string;
  readonly reminderId: string;
  readonly snoozedAt: string;
  readonly durationDays?: number;
}): Promise<{ readonly state: "snoozed"; readonly reminderId: string; readonly snoozedUntil: string }> {
  const snoozedAt = z.iso.datetime().parse(request.snoozedAt);
  const durationDays = z.number().int().min(1).max(90).parse(request.durationDays ?? 7);
  const snoozedUntil = new Date(Date.parse(snoozedAt) + durationDays * 86_400_000).toISOString();
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    const result = database.prepare(
      `UPDATE reminder_obligations
       SET state = 'snoozed', snoozed_until = ?, updated_at = ?
       WHERE reminder_id = ? AND state IN ('pending', 'delivered', 'failed', 'fallback', 'snoozed')`
    ).run(snoozedUntil, snoozedAt, request.reminderId);
    if (result.changes !== 1) throw new Error("Reminder cannot be snoozed from its current state.");
    return { state: "snoozed", reminderId: request.reminderId, snoozedUntil };
  } finally {
    database.close();
  }
}

export async function acknowledgeReminder(request: {
  readonly runtimeRoot: string;
  readonly reminderId: string;
  readonly acknowledgedAt: string;
}): Promise<{ readonly state: "acknowledged"; readonly reminderId: string }> {
  const acknowledgedAt = z.iso.datetime().parse(request.acknowledgedAt);
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    const result = database.prepare(
      `UPDATE reminder_obligations
       SET state = 'acknowledged', acknowledged_at = ?, updated_at = ?
       WHERE reminder_id = ? AND state IN ('delivered', 'snoozed', 'fallback')`
    ).run(acknowledgedAt, acknowledgedAt, request.reminderId);
    if (result.changes !== 1) throw new Error("Reminder cannot be acknowledged from its current state.");
    return { state: "acknowledged", reminderId: request.reminderId };
  } finally {
    database.close();
  }
}
