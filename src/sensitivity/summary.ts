import { z } from "zod";

import { openRuntimeDatabase } from "../runtime/database.js";

const findingStateSchema = z.enum(["blocked_secret", "quarantined"]);

const groupRowSchema = z.object({
  category: z.string().min(1),
  source_kind: z.string().min(1),
  finding_count: z.number().int().nonnegative(),
  occurrence_count: z.number().int().nonnegative(),
  first_seen_at: z.string().min(1),
  last_seen_at: z.string().min(1)
});

export interface SensitivityFindingGroup {
  readonly category: string;
  readonly sourceKind: string;
  readonly findingCount: number;
  readonly occurrenceCount: number;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly recentFindingIds: readonly string[];
}

export interface SensitivityFindingSummary {
  readonly state: "blocked_secret" | "quarantined";
  readonly findingCount: number;
  readonly occurrenceCount: number;
  readonly bodyRetainedCount: 0;
  readonly groups: readonly SensitivityFindingGroup[];
}

const findingSourcesCte = `WITH source_rows AS (
  SELECT finding.state, finding.category, observation.source_kind,
         finding.finding_id, observation.observed_at, 1 AS occurrence_weight
  FROM sensitivity_findings AS finding
  JOIN sensitivity_observations AS observation
    ON observation.fingerprint = finding.fingerprint
  WHERE finding.state = ?
  UNION ALL
  SELECT finding.state, finding.category, 'legacy_unknown' AS source_kind,
         finding.finding_id, finding.last_seen_at AS observed_at,
         finding.occurrence_count AS occurrence_weight
  FROM sensitivity_findings AS finding
  WHERE finding.state = ?
    AND NOT EXISTS (
      SELECT 1 FROM sensitivity_observations AS observation
      WHERE observation.fingerprint = finding.fingerprint
    )
), finding_sources AS (
  SELECT state, category, source_kind, finding_id,
         MIN(observed_at) AS first_seen_at,
         MAX(observed_at) AS last_seen_at,
         SUM(occurrence_weight) AS occurrence_count
  FROM source_rows
  GROUP BY state, category, source_kind, finding_id
)`;

export async function summarizeSensitivityFindings(request: {
  readonly runtimeRoot: string;
  readonly state: "blocked_secret" | "quarantined";
  readonly recentIdentityLimit?: number;
}): Promise<SensitivityFindingSummary> {
  const state = findingStateSchema.parse(request.state);
  const recentIdentityLimit = z.number().int().min(0).max(10).parse(
    request.recentIdentityLimit ?? 3
  );
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    const total = database.prepare(
      `SELECT COUNT(*) AS finding_count,
              COALESCE(SUM(occurrence_count), 0) AS occurrence_count,
              COALESCE(SUM(body_retained), 0) AS body_retained_count
       FROM sensitivity_findings WHERE state = ?`
    ).get(state);
    const groupRows = database.prepare(
      `${findingSourcesCte}
       SELECT category, source_kind, COUNT(*) AS finding_count,
              SUM(occurrence_count) AS occurrence_count,
              MIN(first_seen_at) AS first_seen_at,
              MAX(last_seen_at) AS last_seen_at
       FROM finding_sources
       GROUP BY category, source_kind
       ORDER BY category, source_kind`
    ).all(state, state).map((row) => groupRowSchema.parse(row));
    const recentRows = recentIdentityLimit === 0
      ? []
      : database.prepare(
          `${findingSourcesCte}, ranked AS (
             SELECT category, source_kind, finding_id,
                    ROW_NUMBER() OVER (
                      PARTITION BY category, source_kind
                      ORDER BY last_seen_at DESC, finding_id
                    ) AS ordinal
             FROM finding_sources
           )
           SELECT category, source_kind, finding_id
           FROM ranked WHERE ordinal <= ?
           ORDER BY category, source_kind, ordinal`
        ).all(state, state, recentIdentityLimit);
    const recentByGroup = new Map<string, string[]>();
    for (const row of recentRows) {
      const category = z.string().parse(row.category);
      const sourceKind = z.string().parse(row.source_kind);
      const findingId = z.string().parse(row.finding_id);
      const key = `${category}\0${sourceKind}`;
      const identities = recentByGroup.get(key) ?? [];
      identities.push(findingId);
      recentByGroup.set(key, identities);
    }
    const bodyRetainedCount = z.number().int().nonnegative().parse(total?.body_retained_count);
    if (bodyRetainedCount !== 0) {
      throw new Error("Sensitivity summary encountered retained body data.");
    }
    return {
      state,
      findingCount: z.number().int().nonnegative().parse(total?.finding_count),
      occurrenceCount: z.number().int().nonnegative().parse(total?.occurrence_count),
      bodyRetainedCount: 0,
      groups: groupRows.map((row) => ({
        category: row.category,
        sourceKind: row.source_kind,
        findingCount: row.finding_count,
        occurrenceCount: row.occurrence_count,
        firstSeenAt: row.first_seen_at,
        lastSeenAt: row.last_seen_at,
        recentFindingIds: recentByGroup.get(`${row.category}\0${row.source_kind}`) ?? []
      }))
    };
  } finally {
    database.close();
  }
}

export async function inspectSensitivityStatus(runtimeRoot: string): Promise<{
  readonly schemaVersion: 1;
  readonly bodyPolicy: "never_retained";
  readonly exactReviewRequires: "safe_resubmission_or_readable_source";
  readonly summaries: readonly SensitivityFindingSummary[];
}> {
  const summaries = await Promise.all([
    summarizeSensitivityFindings({ runtimeRoot, state: "quarantined" }),
    summarizeSensitivityFindings({ runtimeRoot, state: "blocked_secret" })
  ]);
  return {
    schemaVersion: 1,
    bodyPolicy: "never_retained",
    exactReviewRequires: "safe_resubmission_or_readable_source",
    summaries
  };
}

export async function inspectSensitivityAssessment(request: {
  readonly runtimeRoot: string;
  readonly findingId: string;
}): Promise<{
  readonly schemaVersion: 1;
  readonly findingId: string;
  readonly state: "blocked_secret" | "quarantined";
  readonly category: string;
  readonly bodyRetained: false;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly occurrenceCount: number;
  readonly sourceKinds: readonly {
    readonly sourceKind: string;
    readonly occurrenceCount: number;
    readonly firstSeenAt: string;
    readonly lastSeenAt: string;
  }[];
  readonly reviewability: "safe_resubmission_or_readable_source_required";
} | undefined> {
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    const finding = database.prepare(
      `SELECT finding_id, state, category, body_retained, first_seen_at,
              last_seen_at, occurrence_count, fingerprint
       FROM sensitivity_findings WHERE finding_id = ?`
    ).get(request.findingId);
    if (finding === undefined) return undefined;
    const bodyRetained = z.number().int().parse(finding.body_retained);
    if (bodyRetained !== 0) throw new Error("Sensitivity assessment encountered retained body data.");
    const fingerprint = z.string().parse(finding.fingerprint);
    const sources = database.prepare(
      `SELECT source_kind, COUNT(*) AS occurrence_count,
              MIN(observed_at) AS first_seen_at,
              MAX(observed_at) AS last_seen_at
       FROM sensitivity_observations
       WHERE fingerprint = ?
       GROUP BY source_kind
       ORDER BY source_kind`
    ).all(fingerprint);
    return {
      schemaVersion: 1,
      findingId: z.string().parse(finding.finding_id),
      state: findingStateSchema.parse(finding.state),
      category: z.string().parse(finding.category),
      bodyRetained: false,
      firstSeenAt: z.string().parse(finding.first_seen_at),
      lastSeenAt: z.string().parse(finding.last_seen_at),
      occurrenceCount: z.number().int().positive().parse(finding.occurrence_count),
      sourceKinds: sources.map((row) => ({
        sourceKind: z.string().parse(row.source_kind),
        occurrenceCount: z.number().int().positive().parse(row.occurrence_count),
        firstSeenAt: z.string().parse(row.first_seen_at),
        lastSeenAt: z.string().parse(row.last_seen_at)
      })),
      reviewability: "safe_resubmission_or_readable_source_required"
    };
  } finally {
    database.close();
  }
}
