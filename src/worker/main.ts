import { z } from "zod";
import { Temporal } from "@js-temporal/polyfill";

import {
  inspectMemoryWorkingSetGeneration,
  loadMemoryCapacityPolicy,
  markMemoryWorkingSetPublished,
  rebalancePressuredMemorySpaces,
  recordMemoryWorkingSetPublicationFailure
} from "../capacity/index.js";
import { pruneExpiredAdmissionAudit } from "../admission/audit.js";
import type { GovernanceAdapter } from "../governance/worker.js";
import { runNextGovernanceStep } from "../governance/worker.js";
import { scheduleDueGovernance } from "../governance/scheduling.js";
import {
  recordCaptureHealthIncident,
  recoverCaptureHealthIncident
} from "../capture/index.js";
import { importCaptureInboxBatch } from "../capture/inbox.js";
import type { NotifierPort } from "../adapters/macos/notifier.js";
import { dispatchNextReminder } from "../review/reminders.js";
import { prepareNextModelHealthReminder } from "../review/reminders.js";
import { prepareReviewReminder } from "../review/reminders.js";
import { generateReviewInbox } from "../review/inbox.js";
import { openRuntimeDatabase } from "../runtime/database.js";
import {
  buildRetrievalIndex,
  inspectActiveRetrievalIndex,
  pruneRetiredRetrievalSnapshots,
  type EmbeddingAdapter
} from "../retrieval/index.js";
import {
  beginRetrievalIndexBuild,
  completeRetrievalIndexBuild,
  failRetrievalIndexBuild
} from "../retrieval/index-coordinator.js";
import { loadRetrievalSnapshot, type RetrievalSnapshot } from "../retrieval/snapshot.js";
import { pruneForegroundAttempts } from "../retrieval/foreground-attempts.js";
import { runNextShadowEvaluation } from "../retrieval/shadow-worker.js";
import {
  advanceCandidateReevaluationBackfill,
  prepareNextCandidateEvaluation,
  runNextCandidateAssessment,
  type CandidateAssessmentAdapter
} from "./governance.js";
import {
  runNextHumanConflictAssessment,
  type HumanConflictAssessmentAdapter
} from "./human-conflicts.js";
import {
  distillationBatchReady,
  prepareNextDistillationBatch,
  prepareNextSessionConsolidation,
  recoverNextBlockedLifecycleOnlyBatch,
  runNextLunaWork,
  type LunaWorkerAdapter
} from "./distillation.js";
import {
  abandonedSessionInactivityMilliseconds,
  captureAbandonedSessionEnd
} from "./session-catchup.js";
import { runNextCandidateMaintenance } from "./candidate-maintenance.js";
import { runScheduledArchiveRetention } from "../purge/index.js";
import {
  advanceCompactQualityDiscovery,
  runNextMemoryQualityStep,
  type MemoryQualityAdapter
} from "../quality/pipeline.js";
import {
  advanceDuplicateDiscovery,
  runNextDuplicateAssessment,
  type DuplicateAssessmentAdapter
} from "../quality/duplicates.js";

export interface WorkerAdapters {
  readonly luna?: LunaWorkerAdapter & CandidateAssessmentAdapter & HumanConflictAssessmentAdapter;
  readonly quality?: MemoryQualityAdapter & DuplicateAssessmentAdapter;
  readonly governance?: GovernanceAdapter;
  readonly notifier?: NotifierPort;
  readonly embedding?: EmbeddingAdapter;
  readonly publishRetrievalSnapshot?: (snapshot: RetrievalSnapshot) => Promise<void>;
  readonly foregroundPressure?: () => boolean;
}

async function foregroundMemoryWorkExists(runtimeRoot: string, now: string): Promise<boolean> {
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    const activeOperation = database.prepare(
      `SELECT
         EXISTS(SELECT 1 FROM luna_operations
           WHERE state IN ('pending', 'processing')
              OR (state = 'retrying' AND next_retry_at <= ?))
         OR EXISTS(SELECT 1 FROM governance_runs
           WHERE state IN ('pending', 'processing')
              OR (state = 'retrying' AND next_retry_at <= ?)) AS present`
    ).get(now, now)?.present === 1;
    if (activeOperation) return true;
  } finally {
    database.close();
  }
  return distillationBatchReady({
    runtimeRoot,
    maximumEvents: 64,
    preparedAt: now,
    minimumEventAgeMilliseconds: 30_000
  });
}

function reviewDigestKey(now: string, timeZone: string): string {
  const local = Temporal.Instant.from(now).toZonedDateTimeISO(timeZone);
  const monday = local.toPlainDate().subtract({ days: local.dayOfWeek - 1 });
  return `review:week:${monday.toString()}`;
}

async function retrievalIndexBuildIsCoolingDown(runtimeRoot: string, now: string): Promise<boolean> {
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    const activity = database.prepare(
      `SELECT state, started_at, completed_at
       FROM retrieval_index_build_activity
       WHERE singleton = 1`
    ).get();
    if (activity === undefined) return false;
    if (activity.state === "building") {
      const startedAt = Date.parse(z.string().parse(activity.started_at));
      return startedAt + 5 * 60 * 1_000 > Date.parse(now);
    }
    if (activity.completed_at === null) return false;
    const completedAt = Date.parse(z.string().parse(activity.completed_at));
    const withinCooldown = completedAt + 5 * 60 * 1_000 > Date.parse(now);
    if (activity.state === "failed") return withinCooldown;
    if (activity.state !== "complete" || !withinCooldown) return false;
    const backlog = database.prepare(
      `SELECT
         EXISTS(
           SELECT 1 FROM luna_operations
           WHERE state IN ('pending', 'processing', 'retrying', 'blocked')
         ) OR EXISTS(
           SELECT 1 FROM memory_candidates
           WHERE state = 'waiting' AND successful_evaluation_at IS NULL
         ) OR EXISTS(
           SELECT 1 FROM capture_events
           WHERE state IN ('pending', 'processing', 'retrying')
         ) AS present`
    ).get();
    return backlog?.present === 1;
  } finally {
    database.close();
  }
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
  let admissionPruningDue = false;
  let foregroundAttemptPruningDue = false;
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
    const admissionMaintenance = database.prepare(
      "SELECT next_prune_at FROM admission_audit_maintenance WHERE singleton = 1"
    ).get();
    admissionPruningDue = typeof admissionMaintenance?.next_prune_at === "string" &&
      admissionMaintenance.next_prune_at <= now;
    const foregroundAttemptMaintenance = database.prepare(
      "SELECT next_prune_at FROM foreground_attempt_maintenance WHERE singleton = 1"
    ).get();
    foregroundAttemptPruningDue =
      typeof foregroundAttemptMaintenance?.next_prune_at === "string" &&
      foregroundAttemptMaintenance.next_prune_at <= now;
  } finally {
    database.close();
  }
  if (paused) return { state: "paused" };

  const activities: string[] = [];
  if (admissionPruningDue) {
    const pruned = await pruneExpiredAdmissionAudit({
      runtimeRoot: request.runtimeRoot,
      now
    });
    if (pruned.deletedCount > 0) {
      activities.push(`admission-audit:pruned:${String(pruned.deletedCount)}`);
    }
  }
  if (foregroundAttemptPruningDue) {
    const pruned = await pruneForegroundAttempts({
      runtimeRoot: request.runtimeRoot,
      now
    });
    if (pruned.deletedCount > 0) {
      activities.push(`foreground-attempts:pruned:${String(pruned.deletedCount)}`);
    }
  }
  let shouldRefreshReview = false;
  const captureInbox = await importCaptureInboxBatch({
    runtimeRoot: request.runtimeRoot,
    importedAt: now,
    maximumEntries: 64,
    maximumMilliseconds: 25
  });
  if (captureInbox.importedCount > 0) {
    activities.push(`capture-inbox:imported:${String(captureInbox.importedCount)}`);
  }
  if (captureInbox.quarantinedCount > 0) {
    activities.push(`capture-inbox:quarantined:${String(captureInbox.quarantinedCount)}`);
  }
  if (captureInbox.remainingCount > 0 && activities.length > 0) {
    return { state: "worked", activities };
  }
  const lifecycleRecovery = await recoverNextBlockedLifecycleOnlyBatch({
    runtimeRoot: request.runtimeRoot,
    recoveredAt: now
  });
  if (lifecycleRecovery.state === "completed") {
    activities.push("distillation:lifecycle-only-recovered");
  }
  const capacityPolicy = await loadMemoryCapacityPolicy({
    runtimeRoot: request.runtimeRoot,
    vaultRoot: request.vaultRoot
  });
  try {
    const capacityResults = await rebalancePressuredMemorySpaces({
      runtimeRoot: request.runtimeRoot,
      vaultRoot: request.vaultRoot,
      policy: capacityPolicy,
      observedAt: now
    });
    for (const result of capacityResults) {
      if (result.state === "deferred" || result.lowWaterUnreachable) {
        shouldRefreshReview = true;
      }
      activities.push(result.state === "rebalanced"
        ? `memory-working-set:${result.scope.kind}:${String(result.rankedActiveAgentCount)}/${String(result.durableActiveAgentCount)}`
        : `memory-working-set:${result.scope.kind}:deferred`);
    }
  } catch {
    activities.push("memory-working-set:reconciliation-failed");
  }
  if (request.adapters?.publishRetrievalSnapshot !== undefined) {
    const generation = await inspectMemoryWorkingSetGeneration(request.runtimeRoot);
    const publicationDue = generation.publicationNextRetryAt === null ||
      generation.publicationNextRetryAt <= now;
    if (generation.dirtyGeneration > generation.publishedGeneration && publicationDue) {
      const activeIndex = await inspectActiveRetrievalIndex(request.runtimeRoot);
      if (activeIndex !== undefined) {
        try {
          await request.adapters.publishRetrievalSnapshot(
            await loadRetrievalSnapshot({ runtimeRoot: request.runtimeRoot })
          );
          await markMemoryWorkingSetPublished({
            runtimeRoot: request.runtimeRoot,
            generation: generation.dirtyGeneration,
            publishedAt: now
          });
          if (generation.publicationFailureCount > 0) shouldRefreshReview = true;
          activities.push(`memory-working-set:published:${String(generation.dirtyGeneration)}`);
        } catch {
          const failure = await recordMemoryWorkingSetPublicationFailure({
            runtimeRoot: request.runtimeRoot,
            failedAt: now,
            errorCode: "snapshot_publication_failed"
          }).catch(() => undefined);
          activities.push(failure === undefined
            ? "memory-working-set:publication-failed"
            : `memory-working-set:publication-deferred:${failure.nextRetryAt}`);
          shouldRefreshReview = true;
        }
      }
    }
  }
  try {
    const pruning = await pruneRetiredRetrievalSnapshots({
      runtimeRoot: request.runtimeRoot,
      maximumSnapshots: 1,
      prunedAt: now
    });
    if (pruning.selectedCount > 0) {
      activities.push(`retrieval-pruning:${String(pruning.prunedCount)}/${String(pruning.selectedCount)}`);
    }
  } catch {
    activities.push("retrieval-pruning:failed");
  }
  const sessionCatchUp = await captureAbandonedSessionEnd({
    runtimeRoot: request.runtimeRoot,
    now,
    inactivityMilliseconds: abandonedSessionInactivityMilliseconds
  });
  if (sessionCatchUp.state !== "empty") {
    activities.push("session-end:catch-up");
  }
  const archiveRetention = await runScheduledArchiveRetention({
    runtimeRoot: request.runtimeRoot,
    vaultRoot: request.vaultRoot,
    now,
    ...(request.adapters?.foregroundPressure === undefined
      ? {}
      : {
          foregroundPressure: () => Promise.resolve(
            request.adapters?.foregroundPressure?.() === true
          )
        })
  });
  if (archiveRetention.state !== "not_due") {
    if (archiveRetention.state === "failed") {
      activities.push(`archive-purge:failed:${archiveRetention.errorCode ?? "unknown_error"}`);
      shouldRefreshReview = true;
    } else if (archiveRetention.state === "yielded") {
      activities.push("archive-purge:yielded");
    }
    if (archiveRetention.deadlineCount > 0) {
      activities.push(`archive-retention:deadlines:${String(archiveRetention.deadlineCount)}`);
    }
    if (archiveRetention.purgedMemoryIds.length > 0) {
      activities.push(`archive-purge:purged:${String(archiveRetention.purgedMemoryIds.length)}`);
    }
  }
  if (request.adapters?.embedding !== undefined) {
    const foregroundPressure = request.adapters.foregroundPressure?.() === true;
    const activeIndex = await inspectActiveRetrievalIndex(request.runtimeRoot);
    const identity = request.adapters.embedding.identity;
    const adapterMatches = activeIndex !== undefined &&
      JSON.stringify(activeIndex.adapterIdentity) === JSON.stringify(identity);
    const indexBuild = await retrievalIndexBuildIsCoolingDown(request.runtimeRoot, now)
      ? { state: "not_due" as const, reason: "failure_cooldown" as const }
      : await beginRetrievalIndexBuild({
          runtimeRoot: request.runtimeRoot,
          now,
          activeIndexExists: activeIndex !== undefined,
          adapterMatches,
          foregroundPressure
        });
    if (indexBuild.state === "started") {
      try {
        const index = await buildRetrievalIndex({
          runtimeRoot: request.runtimeRoot,
          vaultRoot: request.vaultRoot,
          adapter: request.adapters.embedding,
          builtAt: now
        });
        if (request.adapters.publishRetrievalSnapshot !== undefined) {
          await request.adapters.publishRetrievalSnapshot(
            await loadRetrievalSnapshot({ runtimeRoot: request.runtimeRoot })
          );
        }
        await completeRetrievalIndexBuild({
          runtimeRoot: request.runtimeRoot,
          targetGeneration: indexBuild.targetGeneration,
          completedAt: now
        });
        activities.push(`retrieval-index:${index.state}`);
      } catch {
        await failRetrievalIndexBuild({
          runtimeRoot: request.runtimeRoot,
          targetGeneration: indexBuild.targetGeneration,
          failedAt: now
        }).catch(() => undefined);
        activities.push("retrieval-index:failed");
      }
    }
    if (!foregroundPressure) {
      const shadow = await runNextShadowEvaluation({
        runtimeRoot: request.runtimeRoot,
        vaultRoot: request.vaultRoot,
        adapter: request.adapters.embedding,
        now
      });
      if (shadow.state !== "empty") activities.push(`shadow:${shadow.state}`);
    }
  }
  if (request.adapters?.foregroundPressure?.() === true) {
    return activities.length === 0
      ? { state: "idle" }
      : { state: "worked", activities };
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
    const consolidation = await prepareNextSessionConsolidation({
      runtimeRoot: request.runtimeRoot,
      preparedAt: now
    });
    if (consolidation.state !== "empty") {
      activities.push(`consolidation:${consolidation.state}`);
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
  const candidateBackfill = await advanceCandidateReevaluationBackfill({
    runtimeRoot: request.runtimeRoot,
    now
  });
  if (
    candidateBackfill.state !== "empty" &&
    candidateBackfill.reopenedCandidateCount > 0
  ) {
    activities.push(`candidate-backfill:${String(candidateBackfill.reopenedCandidateCount)}`);
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
      adapter: request.adapters.governance,
      foregroundTurnCompleted: true
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
  if (
    request.adapters?.quality !== undefined &&
    !(await foregroundMemoryWorkExists(request.runtimeRoot, now))
  ) {
    try {
      const qualityDiscovery = await advanceCompactQualityDiscovery({
        runtimeRoot: request.runtimeRoot,
        vaultRoot: request.vaultRoot,
        now
      });
      if (qualityDiscovery.state !== "idle") {
        activities.push(`memory-quality-discovery:${qualityDiscovery.state}`);
      }
      const quality = await runNextMemoryQualityStep({
        runtimeRoot: request.runtimeRoot,
        vaultRoot: request.vaultRoot,
        workerId: request.workerId,
        now,
        adapter: request.adapters.quality
      });
      if (quality.state !== "empty") {
        activities.push(`memory-quality:${quality.state}`);
      }
      if (quality.state === "empty") {
        const discovery = await advanceDuplicateDiscovery({
          runtimeRoot: request.runtimeRoot,
          now
        });
        if (!["idle", "index_unavailable"].includes(discovery.state)) {
          activities.push(`memory-duplicate-discovery:${discovery.state}`);
        }
        const duplicates = await runNextDuplicateAssessment({
          runtimeRoot: request.runtimeRoot,
          vaultRoot: request.vaultRoot,
          workerId: request.workerId,
          now,
          adapter: request.adapters.quality
        });
        if (duplicates.state !== "empty") {
          activities.push(`memory-duplicates:${duplicates.state}`);
        }
      }
    } catch {
      activities.push("memory-quality:failed");
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
    const modelHealthReminder = await prepareNextModelHealthReminder({
      runtimeRoot: request.runtimeRoot,
      vaultRoot: request.vaultRoot,
      preparedAt: now
    });
    if (modelHealthReminder.state !== "empty") {
      activities.push(`model-health-reminder:${modelHealthReminder.state}`);
    }
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
  readonly wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}): Promise<{ readonly state: "stopped"; readonly iterations: number }> {
  const intervalMilliseconds = z.number().int().min(100).max(60_000).parse(
    request.intervalMilliseconds ?? 1_000
  );
  const maximumIdleIntervalMilliseconds = Math.max(
    intervalMilliseconds,
    Math.min(30_000, intervalMilliseconds * 30)
  );
  const wait = request.wait ?? waitForWorkerDelay;
  let iterations = 0;
  let consecutiveIdleIterations = 0;
  let consecutiveIterationFailure = false;
  let initialIncidentRecoveryPending = true;
  while (request.signal?.aborted !== true) {
    const iterationAt = new Date().toISOString();
    let delayMilliseconds = intervalMilliseconds;
    try {
      const result = await runWorkerOnce({
        runtimeRoot: request.runtimeRoot,
        vaultRoot: request.vaultRoot,
        workerId: request.workerId,
        now: iterationAt,
        workerStartedAt: request.startedAt,
        ...(request.adapters === undefined ? {} : { adapters: request.adapters })
      });
      if (result.state === "worked") {
        consecutiveIdleIterations = 0;
      } else {
        consecutiveIdleIterations += 1;
        const idleMultiplier = consecutiveIdleIterations === 1
          ? 5
          : consecutiveIdleIterations === 2
            ? 10
            : 30;
        delayMilliseconds = Math.max(
          intervalMilliseconds,
          Math.min(maximumIdleIntervalMilliseconds, intervalMilliseconds * idleMultiplier)
        );
      }
      if (initialIncidentRecoveryPending || consecutiveIterationFailure) {
        await recoverCaptureHealthIncident({
          runtimeRoot: request.runtimeRoot,
          category: "worker_loop",
          recoveredAt: new Date().toISOString()
        });
        initialIncidentRecoveryPending = false;
        consecutiveIterationFailure = false;
      }
    } catch (error) {
      if (!consecutiveIterationFailure) {
        try {
          await recordCaptureHealthIncident({
            runtimeRoot: request.runtimeRoot,
            category: "worker_loop",
            errorCode: workerLoopErrorCode(error),
            occurredAt: new Date().toISOString()
          });
        } catch {
          process.stderr.write("memstore worker: iteration failed; health incident unavailable\n");
        }
      }
      consecutiveIterationFailure = true;
      consecutiveIdleIterations = 0;
    }
    iterations += 1;
    await wait(delayMilliseconds, request.signal);
  }
  return { state: "stopped", iterations };
}

async function waitForWorkerDelay(
  milliseconds: number,
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted === true) return;
  await new Promise<void>((resolveWait) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolveWait();
    };
    const timer = setTimeout(finish, milliseconds);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

function workerLoopErrorCode(error: unknown): string {
  const suppliedCode = typeof error === "object" && error !== null && "code" in error
    ? error.code
    : undefined;
  const source = typeof suppliedCode === "string"
    ? suppliedCode
    : error instanceof Error && error.name !== "Error"
      ? error.name
      : "iteration_failed";
  const normalized = source.toLowerCase().replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  return `worker_${normalized.length === 0 ? "iteration_failed" : normalized}`.slice(0, 64);
}
