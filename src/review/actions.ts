import { z } from "zod";

import {
  resolveHumanConflict,
  type HumanConflictResolution
} from "../candidates/human.js";
import { openRuntimeDatabase } from "../runtime/database.js";
import { acknowledgeReminder, snoozeReminder } from "./reminders.js";

export type ReviewAction =
  | { readonly kind: "dismiss_suggestion"; readonly suggestionId: string }
  | { readonly kind: "complete_verification"; readonly verificationRequestId: string }
  | { readonly kind: "cancel_verification"; readonly verificationRequestId: string }
  | {
      readonly kind: "resolve_human_conflict";
      readonly conflictId: string;
      readonly resolution: HumanConflictResolution;
    }
  | { readonly kind: "snooze_reminder"; readonly reminderId: string; readonly durationDays?: number }
  | { readonly kind: "acknowledge_reminder"; readonly reminderId: string };

export async function applyReviewAction(request: {
  readonly runtimeRoot: string;
  readonly vaultRoot: string;
  readonly action: ReviewAction;
  readonly appliedAt: string;
}): Promise<{ readonly state: "completed"; readonly kind: ReviewAction["kind"] }> {
  const appliedAt = z.iso.datetime().parse(request.appliedAt);
  const action = request.action;
  if (action.kind === "snooze_reminder") {
    await snoozeReminder({
      runtimeRoot: request.runtimeRoot,
      reminderId: action.reminderId,
      snoozedAt: appliedAt,
      ...(action.durationDays === undefined ? {} : { durationDays: action.durationDays })
    });
    return { state: "completed", kind: action.kind };
  }
  if (action.kind === "acknowledge_reminder") {
    await acknowledgeReminder({
      runtimeRoot: request.runtimeRoot,
      reminderId: action.reminderId,
      acknowledgedAt: appliedAt
    });
    return { state: "completed", kind: action.kind };
  }
  if (action.kind === "resolve_human_conflict") {
    await resolveHumanConflict({
      runtimeRoot: request.runtimeRoot,
      vaultRoot: request.vaultRoot,
      conflictId: action.conflictId,
      resolution: action.resolution,
      resolvedAt: appliedAt
    });
    return { state: "completed", kind: action.kind };
  }
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    if (action.kind === "dismiss_suggestion") {
      const result = database.prepare(
        `UPDATE governance_review_suggestions
         SET state = 'dismissed', resolved_at = ?
         WHERE suggestion_id = ? AND state = 'open'`
      ).run(appliedAt, action.suggestionId);
      if (result.changes !== 1) throw new Error("Review Suggestion is not open.");
    } else {
      const state = action.kind === "complete_verification" ? "completed" : "cancelled";
      const result = database.prepare(
        `UPDATE verification_requests SET state = ?, completed_at = ?
         WHERE verification_request_id = ? AND state = 'open'`
      ).run(state, appliedAt, action.verificationRequestId);
      if (result.changes !== 1) throw new Error("Verification Request is not open.");
    }
  } finally {
    database.close();
  }
  return { state: "completed", kind: action.kind };
}
