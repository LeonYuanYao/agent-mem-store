import { randomUUID } from "node:crypto";
import { z } from "zod";

import { openRuntimeDatabase } from "../runtime/database.js";

const knowledgeVerificationPolicyVersion = "source-first-recall-v1";
const verificationReviewerKindSchema = z.enum([
  "human",
  "model_proposed",
  "model_proposed_human_confirmed"
]);
const recordedVerificationReviewerKindSchema = z.enum([
  "human",
  "model_proposed_human_confirmed"
]);

const verificationDispositionSchema = z.enum([
  "matched_durable",
  "missed_durable",
  "correct_omission",
  "ambiguous"
]);

const verificationSampleFrameSchema = z.object({
  kind: z.literal("source_first_session_stratified"),
  strata: z.array(z.enum([
    "project",
    "session_recency",
    "session_length",
    "event_kind"
  ])).min(1).max(4),
  perStratumCap: z.number().int().positive().max(64)
}).superRefine((frame, context) => {
  if (new Set(frame.strata).size !== frame.strata.length) {
    context.addIssue({
      code: "custom",
      message: "Verification strata must be unique.",
      path: ["strata"]
    });
  }
});

const verificationUnitSchema = z.object({
  unitId: z.string().min(1).max(128),
  sourceRef: z.object({
    sessionId: z.string().min(1).max(512),
    turnIds: z.array(z.string().min(1).max(512)).min(1).max(64),
    evidenceIds: z.array(z.string().min(1).max(512)).min(1).max(64)
  }),
  eligibleDurablePresent: z.boolean(),
  disposition: verificationDispositionSchema,
  linkedMemoryIds: z.array(z.string().min(1).max(512)).max(64),
  note: z.string().min(1).max(2048).optional()
}).superRefine((unit, context) => {
  const durableDisposition = unit.disposition === "matched_durable" ||
    unit.disposition === "missed_durable";
  if (unit.eligibleDurablePresent !== durableDisposition) {
    context.addIssue({
      code: "custom",
      message: "eligibleDurablePresent must agree with the verification disposition.",
      path: ["eligibleDurablePresent"]
    });
  }
  if (unit.disposition === "matched_durable" && unit.linkedMemoryIds.length === 0) {
    context.addIssue({
      code: "custom",
      message: "A matched durable unit must link at least one Canonical Memory.",
      path: ["linkedMemoryIds"]
    });
  }
  if (unit.disposition !== "matched_durable" && unit.linkedMemoryIds.length > 0) {
    context.addIssue({
      code: "custom",
      message: "Only matched durable units may link Canonical Memory identities.",
      path: ["linkedMemoryIds"]
    });
  }
  if (
    (unit.disposition === "missed_durable" || unit.disposition === "ambiguous") &&
    unit.note === undefined
  ) {
    context.addIssue({
      code: "custom",
      message: "Missed and ambiguous verification units require a review note.",
      path: ["note"]
    });
  }
});

const knowledgeVerificationInputSchema = z.object({
  reviewerKind: verificationReviewerKindSchema,
  sourceWindow: z.object({
    startedAt: z.iso.datetime(),
    endedAt: z.iso.datetime()
  }),
  sampleFrame: verificationSampleFrameSchema,
  units: z.array(verificationUnitSchema).min(1).max(512)
}).superRefine((run, context) => {
  if (run.sourceWindow.endedAt < run.sourceWindow.startedAt) {
    context.addIssue({
      code: "custom",
      message: "The verification source window must end after it starts.",
      path: ["sourceWindow", "endedAt"]
    });
  }
  if (new Set(run.units.map((unit) => unit.unitId)).size !== run.units.length) {
    context.addIssue({
      code: "custom",
      message: "Verification unit identities must be unique.",
      path: ["units"]
    });
  }
});

const verificationRunRequestSchema = knowledgeVerificationInputSchema.safeExtend({
  createdAt: z.iso.datetime()
});

type VerificationRunRequest = z.infer<typeof verificationRunRequestSchema>;
export type KnowledgeVerificationInput = z.infer<typeof knowledgeVerificationInputSchema>;

export function parseKnowledgeVerificationInput(value: unknown): KnowledgeVerificationInput {
  return knowledgeVerificationInputSchema.parse(value);
}

function summarizeUnits(units: VerificationRunRequest["units"]): {
  readonly counts: Record<z.infer<typeof verificationDispositionSchema>, number>;
  readonly recall: number | null;
} {
  const counts = {
    matched_durable: 0,
    missed_durable: 0,
    correct_omission: 0,
    ambiguous: 0
  };
  for (const unit of units) counts[unit.disposition] += 1;
  const recallDenominator = counts.matched_durable + counts.missed_durable;
  return {
    counts,
    recall: recallDenominator === 0 ? null : counts.matched_durable / recallDenominator
  };
}

async function validateSourceReferences(
  runtimeRoot: string,
  sourceWindow: VerificationRunRequest["sourceWindow"],
  units: VerificationRunRequest["units"]
): Promise<void> {
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    const readEvent = database.prepare(
      "SELECT session_id, turn_id, occurred_at FROM capture_events WHERE event_id = ?"
    );
    const readMemory = database.prepare(
      "SELECT lifecycle FROM memory_catalog WHERE memory_id = ?"
    );
    for (const unit of units) {
      const turns = new Set(unit.sourceRef.turnIds);
      for (const evidenceId of unit.sourceRef.evidenceIds) {
        const event = readEvent.get(evidenceId);
        if (
          event === undefined ||
          event.session_id !== unit.sourceRef.sessionId ||
          typeof event.turn_id !== "string" ||
          !turns.has(event.turn_id)
        ) {
          throw new Error(
            `Verification evidence ${evidenceId} is not bound to the declared source Session and Turn.`
          );
        }
        const occurredAt = z.iso.datetime().parse(event.occurred_at);
        if (
          occurredAt < sourceWindow.startedAt ||
          occurredAt > sourceWindow.endedAt
        ) {
          throw new Error(
            `Verification evidence ${evidenceId} is outside the declared source window.`
          );
        }
      }
      for (const memoryId of unit.linkedMemoryIds) {
        const memory = readMemory.get(memoryId);
        if (memory?.lifecycle !== "active") {
          throw new Error(
            `Verification Memory ${memoryId} is not an active Canonical Memory.`
          );
        }
      }
    }
  } finally {
    database.close();
  }
}

export async function recordKnowledgeVerificationRun(request: {
  readonly runtimeRoot: string;
  readonly createdAt: string;
  readonly preview: boolean;
} & KnowledgeVerificationInput): Promise<{
  readonly state: "preview";
  readonly dry_run: true;
  readonly would_change: readonly ["knowledge_verification_run"];
  readonly counts: Record<z.infer<typeof verificationDispositionSchema>, number>;
  readonly recall: number | null;
} | {
  readonly state: "recorded";
  readonly runId: string;
  readonly counts: Record<z.infer<typeof verificationDispositionSchema>, number>;
  readonly recall: number | null;
}> {
  const parsed = verificationRunRequestSchema.parse(request);
  await validateSourceReferences(request.runtimeRoot, parsed.sourceWindow, parsed.units);
  const summary = summarizeUnits(parsed.units);
  if (request.preview) {
    return {
      state: "preview",
      dry_run: true,
      would_change: ["knowledge_verification_run"],
      ...summary
    };
  }
  if (parsed.reviewerKind === "model_proposed") {
    throw new Error(
      "Human confirmation is required before a model-proposed Knowledge Verification Run can be recorded."
    );
  }
  const runId = `msverify_${randomUUID()}`;
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    database.prepare(
      `INSERT INTO knowledge_verification_runs(
         run_id, policy_version, reviewer_kind, source_window_start, source_window_end,
         sample_frame_json, units_json, matched_durable_count,
         missed_durable_count, correct_omission_count, ambiguous_count,
         recall, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      runId,
      knowledgeVerificationPolicyVersion,
      parsed.reviewerKind,
      parsed.sourceWindow.startedAt,
      parsed.sourceWindow.endedAt,
      JSON.stringify(parsed.sampleFrame),
      JSON.stringify(parsed.units),
      summary.counts.matched_durable,
      summary.counts.missed_durable,
      summary.counts.correct_omission,
      summary.counts.ambiguous,
      summary.recall,
      parsed.createdAt
    );
  } finally {
    database.close();
  }
  return { state: "recorded", runId, ...summary };
}

export async function inspectKnowledgeVerificationRun(request: {
  readonly runtimeRoot: string;
  readonly runId: string;
}): Promise<Record<string, unknown> | undefined> {
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    const row = database.prepare(
      "SELECT * FROM knowledge_verification_runs WHERE run_id = ?"
    ).get(request.runId);
    if (row === undefined) return undefined;
    return {
      runId: z.string().parse(row.run_id),
      policyVersion: z.literal(knowledgeVerificationPolicyVersion).parse(row.policy_version),
      reviewerKind: recordedVerificationReviewerKindSchema.parse(row.reviewer_kind),
      sourceWindow: {
        startedAt: z.iso.datetime().parse(row.source_window_start),
        endedAt: z.iso.datetime().parse(row.source_window_end)
      },
      sampleFrame: verificationSampleFrameSchema.parse(
        JSON.parse(z.string().parse(row.sample_frame_json))
      ),
      units: z.array(verificationUnitSchema).parse(
        JSON.parse(z.string().parse(row.units_json))
      ),
      counts: {
        matched_durable: z.number().int().nonnegative().parse(row.matched_durable_count),
        missed_durable: z.number().int().nonnegative().parse(row.missed_durable_count),
        correct_omission: z.number().int().nonnegative().parse(row.correct_omission_count),
        ambiguous: z.number().int().nonnegative().parse(row.ambiguous_count)
      },
      recall: row.recall === null ? null : z.number().min(0).max(1).parse(row.recall),
      createdAt: z.iso.datetime().parse(row.created_at)
    };
  } finally {
    database.close();
  }
}

export function summarizeKnowledgeVerificationRuns(
  database: Awaited<ReturnType<typeof openRuntimeDatabase>>,
  startedAt: string
): Record<string, unknown> {
  const rows = database.prepare(
    `SELECT run_id, policy_version, reviewer_kind, matched_durable_count, missed_durable_count,
            correct_omission_count, ambiguous_count, recall, created_at
     FROM knowledge_verification_runs
     WHERE created_at >= ?
     ORDER BY created_at DESC, run_id DESC`
  ).all(z.iso.datetime().parse(startedAt));
  const latest = rows[0];
  return {
    runCount: rows.length,
    ...(latest === undefined
      ? { latest: null }
      : {
          latest: {
            runId: z.string().parse(latest.run_id),
            policyVersion: z.literal(knowledgeVerificationPolicyVersion)
              .parse(latest.policy_version),
            reviewerKind: recordedVerificationReviewerKindSchema.parse(latest.reviewer_kind),
            counts: {
              matched_durable: z.number().int().nonnegative().parse(latest.matched_durable_count),
              missed_durable: z.number().int().nonnegative().parse(latest.missed_durable_count),
              correct_omission: z.number().int().nonnegative()
                .parse(latest.correct_omission_count),
              ambiguous: z.number().int().nonnegative().parse(latest.ambiguous_count)
            },
            recall: latest.recall === null
              ? null
              : z.number().min(0).max(1).parse(latest.recall),
            createdAt: z.iso.datetime().parse(latest.created_at)
          }
        })
  };
}
