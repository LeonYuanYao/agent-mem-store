import { z } from "zod";
import { Temporal } from "@js-temporal/polyfill";

import type { GovernanceAdapter } from "../governance/worker.js";
import { runNextGovernanceStep } from "../governance/worker.js";
import { scheduleDueGovernance } from "../governance/scheduling.js";
import type { NotifierPort } from "../adapters/macos/notifier.js";
import { dispatchNextReminder } from "../review/reminders.js";
import { prepareReviewReminder } from "../review/reminders.js";
import { generateReviewInbox } from "../review/inbox.js";
import { openRuntimeDatabase } from "../runtime/database.js";
import {
  buildRetrievalIndex,
  retrievalIndexNeedsRebuild,
  type EmbeddingAdapter
} from "../retrieval/index.js";
import { runNextShadowEvaluation } from "../retrieval/shadow-worker.js";
import {
  prepareNextCandidateEvaluation,
  runNextCandidateAssessment,
  type CandidateAssessmentAdapter
} from "./governance.js";
import {
  runNextHumanConflictAssessment,
  type HumanConflictAssessmentAdapter
} from "./human-conflicts.js";
import {
  prepareNextDistillationBatch,
  runNextLunaWork,
  type LunaWorkerAdapter
} from "./distillation.js";
import { captureAbandonedSessionEnd } from "./session-catchup.js";
import { runNextCandidateMaintenance } from "./candidate-maintenance.js";

export interface WorkerAdapters {
  readonly luna?: LunaWorkerAdapter & CandidateAssessmentAdapter & HumanConflictAssessmentAdapter;
  readonly governance?: GovernanceAdapter;
  readonly notifier?: NotifierPort;
  readonly embedding?: EmbeddingAdapter;
}

function reviewDigestKey(now: string, timeZone: string): string {
  const local = Temporal.Instant.from(now).toZonedDateTimeISO(timeZone);
  const monday = local.toPlainDate().subtract({ days: local.dayOfWeek - 1 });
  return `review:week:${monday.toString()}`;
}

export async function runWorkerOnce(request: {
  readonly runtimeRoot: string;
  readonly vaultRoot: string;
  readonly workerId: string;
  readonly now: string;
  readonly workerStartedAt: string;
  readonly adapters?: WorkerAdapters;
}): Promise<{ readonly state: "paused" | "idle" | "worked"; readonly activities?: readonly string[] }> {
  const now = z.iso.datetime().parse(request.now);
  const workerStartedAt = z.iso.datetime().parse(request.workerStartedAt);
  const database = await openRuntimeDatabase(request.runtimeRoot);
  let paused = false;
  let scheduleExists = false;
  let timeZone = "UTC";
  try {
    paused = database.prepare(
      "SELECT worker_paused FROM worker_control WHERE singleton = 1"
    ).get()?.worker_paused === 1;
    scheduleExists = database.prepare(
      "SELECT 1 AS present FROM governance_schedule WHERE singleton = 1"
    ).get() !== undefined;
    const schedule = database.prepare(
      "SELECT time_zone FROM governance_schedule WHERE singleton = 1"
    ).get();
    if (typeof schedule?.time_zone === "string") timeZone = schedule.time_zone;
  } finally {
    database.close();
  }
  if (paused) return { state: "paused" };

  const activities: string[] = [];
  let shouldRefreshReview = false;
  const sessionCatchUp = await captureAbandonedSessionEnd({
    runtimeRoot: request.runtimeRoot,
    now,
    inactivityMilliseconds: 24 * 60 * 60 * 1_000
  });
  if (sessionCatchUp.state !== "empty") {
    activities.push("session-end:catch-up");
  }
  if (request.adapters?.embedding !== undefined) {
    if (await retrievalIndexNeedsRebuild({
      runtimeRoot: request.runtimeRoot,
      adapter: request.adapters.embedding
    })) {
      const index = await buildRetrievalIndex({
        runtimeRoot: request.runtimeRoot,
        vaultRoot: request.vaultRoot,
        adapter: request.adapters.embedding,
        builtAt: now
      });
      activities.push(`retrieval-index:${index.state}`);
    }
    const shadow = await runNextShadowEvaluation({
      runtimeRoot: request.runtimeRoot,
      vaultRoot: request.vaultRoot,
      adapter: request.adapters.embedding,
      now
    });
    if (shadow.state !== "empty") activities.push(`shadow:${shadow.state}`);
  }
  if (request.adapters?.luna !== undefined) {
    const prepared = await prepareNextDistillationBatch({
      runtimeRoot: request.runtimeRoot,
      maximumEvents: 64,
      preparedAt: now,
      minimumEventAgeMilliseconds: 30_000
    });
    if (prepared.state !== "empty") {
      activities.push(`distillation:${prepared.state}`);
      shouldRefreshReview = true;
    }
    const luna = await runNextLunaWork({
      runtimeRoot: request.runtimeRoot,
      workerId: request.workerId,
      now,
      adapter: request.adapters.luna
    });
    if (luna.state !== "empty") {
      activities.push(`luna:${luna.state}`);
      shouldRefreshReview = true;
    }
    const conflict = await runNextHumanConflictAssessment({
      runtimeRoot: request.runtimeRoot,
      vaultRoot: request.vaultRoot,
      workerId: request.workerId,
      now,
      adapter: request.adapters.luna
    });
    if (conflict.state !== "empty") {
      activities.push(`human-conflict:${conflict.state}`);
      shouldRefreshReview = true;
    }
  }
  const candidatePreparation = await prepareNextCandidateEvaluation({
    runtimeRoot: request.runtimeRoot,
    vaultRoot: request.vaultRoot,
    now
  });
  if (candidatePreparation.state !== "empty") {
    activities.push(`candidate:${candidatePreparation.state}`);
    shouldRefreshReview = true;
  }
  if (request.adapters?.luna !== undefined) {
    const candidate = await runNextCandidateAssessment({
      runtimeRoot: request.runtimeRoot,
      vaultRoot: request.vaultRoot,
      workerId: request.workerId,
      now,
      adapter: request.adapters.luna
    });
    if (candidate.state !== "empty") {
      activities.push(`candidate:${candidate.state}`);
      shouldRefreshReview = true;
    }
  }
  if (scheduleExists && request.adapters?.governance !== undefined) {
    const scheduled = await scheduleDueGovernance({
      runtimeRoot: request.runtimeRoot,
      now,
      workerStartedAt
    });
    if (scheduled.state !== "idle") activities.push(`governance-schedule:${scheduled.state}`);
    const governance = await runNextGovernanceStep({
      runtimeRoot: request.runtimeRoot,
      vaultRoot: request.vaultRoot,
      now,
      workerId: request.workerId,
      adapter: request.adapters.governance
    });
    if (governance.state !== "idle") activities.push(`governance:${governance.state}`);
    if (!["idle", "busy", "blocked", "yielded"].includes(governance.state)) {
      shouldRefreshReview = true;
    }
  }
  if (scheduleExists) {
    const maintenance = await runNextCandidateMaintenance({
      runtimeRoot: request.runtimeRoot,
      now
    });
    if (maintenance.state !== "empty") {
      activities.push("candidate-maintenance:completed");
      shouldRefreshReview = true;
    }
  }
  if (shouldRefreshReview) {
    await generateReviewInbox({
      runtimeRoot: request.runtimeRoot,
      vaultRoot: request.vaultRoot,
      generatedAt: now
    });
    const reminder = await prepareReviewReminder({
      runtimeRoot: request.runtimeRoot,
      vaultRoot: request.vaultRoot,
      digestKey: reviewDigestKey(now, timeZone),
      dueAt: now,
      createdAt: now
    });
    if (reminder.state !== "empty") activities.push(`reminder:${reminder.state}`);
  }
  if (request.adapters?.notifier !== undefined) {
    const notification = await dispatchNextReminder({
      runtimeRoot: request.runtimeRoot,
      now,
      notifier: request.adapters.notifier
    });
    if (notification.state !== "empty") activities.push(`reminder:${notification.state}`);
  }
  return activities.length === 0
    ? { state: "idle" }
    : { state: "worked", activities };
}

export async function runWorker(request: {
  readonly runtimeRoot: string;
  readonly vaultRoot: string;
  readonly workerId: string;
  readonly startedAt: string;
  readonly intervalMilliseconds?: number;
  readonly signal?: AbortSignal;
  readonly adapters?: WorkerAdapters;
}): Promise<{ readonly state: "stopped"; readonly iterations: number }> {
  const intervalMilliseconds = z.number().int().min(100).max(60_000).parse(
    request.intervalMilliseconds ?? 1_000
  );
  let iterations = 0;
  while (request.signal?.aborted !== true) {
    await runWorkerOnce({
      runtimeRoot: request.runtimeRoot,
      vaultRoot: request.vaultRoot,
      workerId: request.workerId,
      now: new Date().toISOString(),
      workerStartedAt: request.startedAt,
      ...(request.adapters === undefined ? {} : { adapters: request.adapters })
    });
    iterations += 1;
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, intervalMilliseconds));
  }
  return { state: "stopped", iterations };
}
