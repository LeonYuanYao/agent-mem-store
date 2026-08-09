import { randomUUID } from "node:crypto";
import { z } from "zod";

import { openRuntimeDatabase } from "../runtime/database.js";
import type { CandidateContent } from "./index.js";

interface HighValueAnomalyThresholds {
  readonly sessionMinimumCandidates: number;
  readonly sessionMinimumHighValue: number;
  readonly rollingMinimumCurrent: number;
  readonly rollingMinimumBaseline: number;
  readonly rollingMinimumCurrentRate: number;
  readonly rollingMinimumRateIncrease: number;
  readonly coldStartHistoricalCeiling: number;
  readonly coldStartMinimumCurrent: number;
  readonly coldStartMinimumRate: number;
  readonly tagDominanceMinimumHighValue: number;
  readonly tagDominanceMinimumRate: number;
}

const anomalyPolicyV1: {
  readonly version: "high-value-anomaly-v1";
  readonly thresholds: HighValueAnomalyThresholds;
} = {
  version: "high-value-anomaly-v1",
  thresholds: {
    sessionMinimumCandidates: 12,
    sessionMinimumHighValue: 10,
    rollingMinimumCurrent: 50,
    rollingMinimumBaseline: 100,
    rollingMinimumCurrentRate: 0.6,
    rollingMinimumRateIncrease: 0.25,
    coldStartHistoricalCeiling: 100,
    coldStartMinimumCurrent: 50,
    coldStartMinimumRate: 0.8,
    tagDominanceMinimumHighValue: 20,
    tagDominanceMinimumRate: 0.8
  }
};

interface AnomalyDetection {
  readonly key: string;
  readonly kind: "session_burst" | "project_rolling_change" | "cold_start" | "tag_dominance";
  readonly projectId: string | null;
  readonly sessionId: string | null;
  readonly measurements: Readonly<Record<string, unknown>>;
}

export async function evaluateHighValueAnomalies(request: {
  readonly runtimeRoot: string;
  readonly evaluatedAt: string;
  readonly evaluation: {
    readonly kind: "weekly" | "window";
    readonly windowStart: string;
    readonly windowEnd: string;
  };
}): Promise<readonly {
  readonly anomalyId: string;
  readonly anomalyKind: AnomalyDetection["kind"];
  readonly state: "provisional" | "persistent";
}[]> {
  const evaluatedAt = z.iso.datetime().parse(request.evaluatedAt);
  const windowStart = z.iso.datetime().parse(request.evaluation.windowStart);
  const windowEnd = z.iso.datetime().parse(request.evaluation.windowEnd);
  if (windowEnd <= windowStart) {
    throw new Error("Anomaly window must have positive duration.");
  }
  const thresholds = anomalyPolicyV1.thresholds;
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    const rows = database.prepare(
      `SELECT candidate_id, project_id, source_session_id, high_value,
              candidate_json, created_at
       FROM memory_candidates AS candidate
       WHERE scope_kind = 'project' AND pinned = 0
         AND EXISTS (
           SELECT 1 FROM candidate_evidence AS evidence
           WHERE evidence.candidate_id = candidate.candidate_id
             AND evidence.memory_echo = 0
         )`
    ).all();
    const detections: AnomalyDetection[] = [];
    const bySession = new Map<string, Record<string, unknown>[]>();
    const byProject = new Map<string, Record<string, unknown>[]>();
    for (const row of rows) {
      if (typeof row.project_id === "string") {
        const projectRows = byProject.get(row.project_id) ?? [];
        projectRows.push(row);
        byProject.set(row.project_id, projectRows);
      }
      if (typeof row.source_session_id === "string") {
        const sessionRows = bySession.get(row.source_session_id) ?? [];
        sessionRows.push(row);
        bySession.set(row.source_session_id, sessionRows);
      }
    }
    for (const [sessionId, sessionRows] of bySession) {
      const rowsInWindow = sessionRows.filter((row) => {
        const createdAt = z.string().parse(row.created_at);
        return createdAt >= windowStart && createdAt < windowEnd;
      });
      const highValueCount = rowsInWindow.filter((row) => row.high_value === 1).length;
      if (
        rowsInWindow.length >= thresholds.sessionMinimumCandidates &&
        highValueCount >= thresholds.sessionMinimumHighValue
      ) {
        const projectId =
          typeof rowsInWindow[0]?.project_id === "string"
            ? rowsInWindow[0].project_id
            : null;
        detections.push({
          key: `session_burst:${sessionId}`,
          kind: "session_burst",
          projectId,
          sessionId,
          measurements: {
            candidateCount: rowsInWindow.length,
            highValueCount,
            representativeCandidateIds: rowsInWindow
              .slice(0, 10)
              .map((row) => row.candidate_id)
          }
        });
      }
    }

    const nowMilliseconds = Date.parse(windowEnd);
    const currentStart = nowMilliseconds - 30 * 24 * 60 * 60 * 1000;
    const baselineStart = nowMilliseconds - 120 * 24 * 60 * 60 * 1000;
    for (const [projectId, projectRows] of byProject) {
      const current = projectRows.filter((row) => Date.parse(z.string().parse(row.created_at)) >= currentStart);
      const baseline = projectRows.filter((row) => {
        const created = Date.parse(z.string().parse(row.created_at));
        return created >= baselineStart && created < currentStart;
      });
      const historical = projectRows.filter(
        (row) => Date.parse(z.string().parse(row.created_at)) < currentStart
      );
      const currentHigh = current.filter((row) => row.high_value === 1);
      const baselineHigh = baseline.filter((row) => row.high_value === 1);
      const currentRate = current.length === 0 ? 0 : currentHigh.length / current.length;
      const baselineRate = baseline.length === 0 ? 0 : baselineHigh.length / baseline.length;
      if (
        current.length >= thresholds.rollingMinimumCurrent &&
        baseline.length >= thresholds.rollingMinimumBaseline &&
        currentRate >= thresholds.rollingMinimumCurrentRate &&
        currentRate - baselineRate >= thresholds.rollingMinimumRateIncrease
      ) {
        detections.push({
          key: `project_rolling_change:${projectId}`,
          kind: "project_rolling_change",
          projectId,
          sessionId: null,
          measurements: {
            currentCount: current.length,
            baselineCount: baseline.length,
            currentRate,
            baselineRate
          }
        });
      }
      if (
        historical.length < thresholds.coldStartHistoricalCeiling &&
        current.length >= thresholds.coldStartMinimumCurrent &&
        currentRate >= thresholds.coldStartMinimumRate
      ) {
        detections.push({
          key: `cold_start:${projectId}`,
          kind: "cold_start",
          projectId,
          sessionId: null,
          measurements: { historicalCount: historical.length, currentCount: current.length, currentRate }
        });
      }
      const tagCounts = new Map<string, number>();
      for (const row of currentHigh) {
        const content = JSON.parse(z.string().parse(row.candidate_json)) as CandidateContent;
        for (const tag of new Set(content.importanceTags)) {
          tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
        }
      }
      if (currentHigh.length >= thresholds.tagDominanceMinimumHighValue) {
        for (const [tag, count] of tagCounts) {
          const rate = count / currentHigh.length;
          if (rate >= thresholds.tagDominanceMinimumRate) {
            detections.push({
              key: `tag_dominance:${projectId}:${tag}`,
              kind: "tag_dominance",
              projectId,
              sessionId: null,
              measurements: { tag, highValueCount: currentHigh.length, tagCount: count, rate }
            });
          }
        }
      }
    }

    database.exec("BEGIN IMMEDIATE");
    const activeKeys = new Set(detections.map((item) => item.key));
    const activeRows = database
      .prepare("SELECT anomaly_key FROM high_value_anomalies WHERE state != 'resolved'")
      .all();
    for (const row of activeRows) {
      const key = z.string().parse(row.anomaly_key);
      if (!activeKeys.has(key)) {
        database.prepare(
          `UPDATE high_value_anomalies
           SET state = 'resolved', last_evaluated_at = ? WHERE anomaly_key = ?`
        ).run(evaluatedAt, key);
      }
    }
    const results: {
      anomalyId: string;
      anomalyKind: AnomalyDetection["kind"];
      state: "provisional" | "persistent";
    }[] = [];
    for (const detection of detections) {
      const existing = database.prepare(
        `SELECT anomaly_id, state, last_evaluated_at, last_evaluation_kind,
                last_window_start, last_window_end, consecutive_count
         FROM high_value_anomalies WHERE anomaly_key = ?`
      ).get(detection.key);
      if (existing === undefined) {
        const anomalyId = `msanomaly_${randomUUID()}`;
        database.prepare(
          `INSERT INTO high_value_anomalies(
             anomaly_id, anomaly_key, anomaly_kind, project_id, session_id,
             measurements_json, policy_version, state, detected_at, last_evaluated_at,
             last_evaluation_kind, last_window_start, last_window_end,
             consecutive_count
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'provisional', ?, ?, ?, ?, ?, 1)`
        ).run(
          anomalyId,
          detection.key,
          detection.kind,
          detection.projectId,
          detection.sessionId,
          JSON.stringify(detection.measurements),
          anomalyPolicyV1.version,
          evaluatedAt,
          evaluatedAt,
          request.evaluation.kind,
          windowStart,
          windowEnd
        );
        results.push({ anomalyId, anomalyKind: detection.kind, state: "provisional" });
        continue;
      }
      const sameEvaluationWindow =
        existing.last_evaluation_kind === request.evaluation.kind &&
        existing.last_window_start === windowStart &&
        existing.last_window_end === windowEnd;
      const previousCount = z.number().int().positive().parse(existing.consecutive_count);
      const consecutiveWindow =
        existing.last_evaluation_kind === request.evaluation.kind &&
        windowStart === existing.last_window_end;
      const continues =
        existing.state !== "resolved" &&
        consecutiveWindow;
      const count = sameEvaluationWindow
        ? previousCount
        : continues
          ? previousCount + 1
          : 1;
      const state = count >= 2 ? "persistent" as const : "provisional" as const;
      database.prepare(
        `UPDATE high_value_anomalies
         SET measurements_json = ?, policy_version = ?, state = ?, last_evaluated_at = ?,
             last_evaluation_kind = ?, last_window_start = ?,
             last_window_end = ?, consecutive_count = ? WHERE anomaly_key = ?`
      ).run(
        JSON.stringify(detection.measurements),
        anomalyPolicyV1.version,
        state,
        evaluatedAt,
        request.evaluation.kind,
        windowStart,
        windowEnd,
        count,
        detection.key
      );
      results.push({
        anomalyId: z.string().parse(existing.anomaly_id),
        anomalyKind: detection.kind,
        state
      });
    }
    database.exec("COMMIT");
    return results;
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}
