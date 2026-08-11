import { z } from "zod";

import {
  evaluateHighValueAnomalies,
  expireDueCandidates,
  purgeDueCandidateTombstones,
  scheduleDueCandidateExpirations
} from "../candidates/index.js";
import { openRuntimeDatabase } from "../runtime/database.js";

export type CandidateMaintenanceResult =
  | { readonly state: "empty" }
  | {
      readonly state: "completed";
      readonly governanceRunId: string;
      readonly scheduledCandidateCount: number;
      readonly expiredCandidateCount: number;
      readonly purgedTombstoneCount: number;
      readonly anomalyCount: number;
    };

export async function runNextCandidateMaintenance(request: {
  readonly runtimeRoot: string;
  readonly now: string;
}): Promise<CandidateMaintenanceResult> {
  const now = z.iso.datetime().parse(request.now);
  const database = await openRuntimeDatabase(request.runtimeRoot);
  let run: Record<string, unknown> | undefined;
  try {
    run = database.prepare(
      `SELECT run_id, weekly_from, coverage_through
       FROM governance_runs AS governance
       WHERE governance.state = 'completed' AND governance.includes_weekly = 1
         AND NOT EXISTS (
           SELECT 1 FROM candidate_maintenance_runs AS maintenance
           WHERE maintenance.governance_run_id = governance.run_id
         )
       ORDER BY governance.completed_at, governance.run_id
       LIMIT 1`
    ).get();
  } finally {
    database.close();
  }
  if (run === undefined) return { state: "empty" };
  const governanceRunId = z.string().min(1).parse(run.run_id);
  const windowStart = z.iso.datetime().parse(run.weekly_from);
  const windowEnd = z.iso.datetime().parse(run.coverage_through);
  const scheduled = await scheduleDueCandidateExpirations({
    runtimeRoot: request.runtimeRoot,
    evaluatedAt: now,
    ordinaryDays: 90,
    protectedDays: 180
  });
  const expired = await expireDueCandidates({
    runtimeRoot: request.runtimeRoot,
    evaluatedAt: now,
    ordinaryDays: 90,
    protectedDays: 180,
    tombstoneDays: 180
  });
  const purged = await purgeDueCandidateTombstones({
    runtimeRoot: request.runtimeRoot,
    evaluatedAt: now
  });
  const anomalies = await evaluateHighValueAnomalies({
    runtimeRoot: request.runtimeRoot,
    evaluatedAt: now,
    evaluation: { kind: "weekly", windowStart, windowEnd }
  });
  const result = {
    state: "completed" as const,
    governanceRunId,
    scheduledCandidateCount: scheduled.scheduledCandidateIds.length,
    expiredCandidateCount: expired.expiredCandidateIds.length,
    purgedTombstoneCount: purged.purgedCandidateIds.length,
    anomalyCount: anomalies.length
  };
  const completionDatabase = await openRuntimeDatabase(request.runtimeRoot);
  try {
    completionDatabase.prepare(
      `INSERT OR IGNORE INTO candidate_maintenance_runs(
         governance_run_id, completed_at, result_json
       ) VALUES (?, ?, ?)`
    ).run(governanceRunId, now, JSON.stringify(result));
  } finally {
    completionDatabase.close();
  }
  return result;
}
