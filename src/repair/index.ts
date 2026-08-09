import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import { writeFileAtomically } from "../contracts/atomic-file.js";
import { openRuntimeDatabase } from "../runtime/database.js";

const repairStateSchema = z.enum([
  "diagnosing",
  "awaiting_gate1",
  "gate1_approved",
  "awaiting_replay",
  "awaiting_gate2",
  "monitoring",
  "monitoring_failed",
  "resolved",
  "resolved_with_limited_evidence",
  "not_reproduced"
]);
const riskClassSchema = z.enum(["A", "B", "C"]);
const timestampSchema = z.iso.datetime();

type RepairState = z.infer<typeof repairStateSchema>;
type RiskClass = z.infer<typeof riskClassSchema>;

interface RepairRow {
  readonly repair_id: string;
  readonly bad_case_id: string;
  readonly state: string;
  readonly root_cause: string | null;
  readonly risk_class: string | null;
  readonly active_model: string;
  readonly model_requirement_satisfied: number;
  readonly program_version: string;
  readonly code_revision: string;
  readonly repair_bundle_path: string;
  readonly before_version: string | null;
  readonly after_version: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly resolved_at: string | null;
}

interface RepairEvent {
  readonly kind: string;
  readonly payload: unknown;
  readonly recordedAt: string;
}

function assertStringList(values: readonly string[], name: string): readonly string[] {
  return z.array(z.string().trim().min(1)).min(1, `${name} must contain at least one item.`).parse(values);
}

function modelRequirement(activeModel: string): {
  readonly required: "gpt-5.6";
  readonly satisfied: boolean;
  readonly warning?: string;
} {
  const satisfied = /^gpt-5\.6(?:$|[-:])/iu.test(activeModel.trim());
  return {
    required: "gpt-5.6",
    satisfied,
    ...(satisfied
      ? {}
      : { warning: "GPT-5.6 model identity is not confirmed; do not claim the repair requirement is satisfied." })
  };
}

function repairRow(database: Awaited<ReturnType<typeof openRuntimeDatabase>>, repairId: string): RepairRow {
  const row = database.prepare("SELECT * FROM repair_cases WHERE repair_id = ?").get(repairId);
  return z.custom<RepairRow>((value) => value !== undefined).parse(row);
}

function requireState(row: RepairRow, expected: readonly RepairState[]): void {
  const state = repairStateSchema.parse(row.state);
  if (!expected.includes(state)) {
    throw new Error(`Repair ${row.repair_id} is ${state}; expected ${expected.join(" or ")}.`);
  }
}

function appendEvent(
  database: Awaited<ReturnType<typeof openRuntimeDatabase>>,
  repairId: string,
  kind: RepairEvent["kind"],
  payload: unknown,
  recordedAt: string
): void {
  const ordinal = z.number().int().nonnegative().parse(
    database.prepare("SELECT COUNT(*) AS count FROM repair_events WHERE repair_id = ?")
      .get(repairId)?.count
  );
  database.prepare(
    `INSERT INTO repair_events(event_id, repair_id, ordinal, kind, payload_json, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    `msrepairevent_${randomUUID()}`,
    repairId,
    ordinal,
    kind,
    JSON.stringify(payload),
    recordedAt
  );
}

async function writeBundleFile(bundlePath: string, name: string, content: string): Promise<void> {
  await writeFileAtomically(join(bundlePath, name), content.endsWith("\n") ? content : `${content}\n`, 0o600);
}

async function readDiagnostic(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

export async function prepareRepair(request: {
  readonly runtimeRoot: string;
  readonly badCaseId: string;
  readonly activeModel: string;
  readonly programVersion: string;
  readonly codeRevision: string;
  readonly preparedAt: string;
  readonly preview?: boolean;
}): Promise<{
  readonly repairId: string;
  readonly badCaseId: string;
  readonly state: "preview" | "diagnosing";
  readonly bundlePath: string;
  readonly modelRequirement: ReturnType<typeof modelRequirement>;
  readonly dryRun: boolean;
}> {
  const preparedAt = timestampSchema.parse(request.preparedAt);
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    const badCase = database.prepare(
      `SELECT bad_case_id, state, kind, component, project_id, occurrence_count,
              diagnostic_bundle_path, diagnostic_bundle_sha256
       FROM bad_cases WHERE bad_case_id = ?`
    ).get(request.badCaseId);
    if (badCase === undefined) throw new Error(`Unknown Bad Case ${request.badCaseId}.`);
    const existing = database.prepare("SELECT repair_id FROM repair_cases WHERE bad_case_id = ?")
      .get(request.badCaseId);
    if (existing !== undefined && request.preview !== true) {
      const inspected = await inspectRepair(request.runtimeRoot, z.string().parse(existing.repair_id));
      return {
        repairId: inspected.repairId,
        badCaseId: inspected.badCaseId,
        state: "diagnosing",
        bundlePath: inspected.bundlePath,
        modelRequirement: inspected.modelRequirement,
        dryRun: false
      };
    }
    const repairId = `msrepair_${randomUUID()}`;
    const bundlePath = join(request.runtimeRoot, "repair-bundles", repairId);
    const requirement = modelRequirement(request.activeModel);
    if (request.preview === true) {
      return {
        repairId,
        badCaseId: request.badCaseId,
        state: "preview",
        bundlePath,
        modelRequirement: requirement,
        dryRun: true
      };
    }
    const receiptSamples = database.prepare(
      `SELECT observation.receipt_id AS receiptId,
              observation.memory_id AS memoryId,
              observation.revision_id AS revisionId,
              observation.observed_at AS observedAt,
              receipt.scope_binding AS scopeBinding,
              receipt.project_id AS projectId,
              receipt.index_revision_id AS indexRevisionId,
              revision.adapter_version AS adapterVersion,
              revision.model_identity AS modelIdentity,
              revision.artifact_sha256 AS artifactSha256
       FROM irrelevant_observations AS observation
       JOIN retrieval_receipts AS receipt ON receipt.receipt_id = observation.receipt_id
       LEFT JOIN retrieval_index_revisions AS revision
         ON revision.index_revision_id = receipt.index_revision_id
       WHERE observation.bad_case_id = ?
       ORDER BY observation.observed_at DESC LIMIT 20`
    ).all(request.badCaseId);
    const schemaVersions = database.prepare(
      "SELECT version, name, source_sha256 AS sourceSha256 FROM schema_migrations ORDER BY version"
    ).all();
    const context = {
      schemaVersion: 1,
      repairId,
      badCaseId: request.badCaseId,
      badCase: {
        kind: badCase.kind,
        component: badCase.component,
        projectId: badCase.project_id,
        occurrenceCount: badCase.occurrence_count,
        diagnosticBundleSha256: badCase.diagnostic_bundle_sha256
      },
      diagnostic: await readDiagnostic(z.string().parse(badCase.diagnostic_bundle_path)),
      receiptSamples,
      versionContext: {
        programVersion: request.programVersion,
        codeRevision: request.codeRevision,
        schemaVersions
      },
      modelRequirement: requirement,
      preparedAt
    };
    await mkdir(bundlePath, { recursive: true, mode: 0o700 });
    await writeBundleFile(bundlePath, "context.json", JSON.stringify(context, null, 2));
    await writeBundleFile(bundlePath, "diagnosis.md", "# Diagnosis\n\nStatus: pending foreground analysis.\n");
    await writeBundleFile(bundlePath, "proposed-changes.md", "# Proposed changes\n\nStatus: pending Review Gate 1.\n");
    await writeBundleFile(bundlePath, "reproduction.json", JSON.stringify({ schemaVersion: 1, badCaseId: request.badCaseId, status: "pending" }, null, 2));
    await writeBundleFile(bundlePath, "verification-plan.md", "# Verification plan\n\nStatus: pending foreground analysis.\n");
    database.exec("BEGIN IMMEDIATE");
    database.prepare(
      `INSERT INTO repair_cases(
         repair_id, bad_case_id, state, active_model, model_requirement_satisfied,
         program_version, code_revision, repair_bundle_path, created_at, updated_at
       ) VALUES (?, ?, 'diagnosing', ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      repairId,
      request.badCaseId,
      request.activeModel,
      requirement.satisfied ? 1 : 0,
      request.programVersion,
      request.codeRevision,
      bundlePath,
      preparedAt,
      preparedAt
    );
    database.prepare("UPDATE bad_cases SET state = 'repairing' WHERE bad_case_id = ?")
      .run(request.badCaseId);
    appendEvent(database, repairId, "prepared", { modelRequirement: requirement }, preparedAt);
    database.exec("COMMIT");
    return {
      repairId,
      badCaseId: request.badCaseId,
      state: "diagnosing",
      bundlePath,
      modelRequirement: requirement,
      dryRun: false
    };
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}

export async function recordRepairProposal(request: {
  readonly runtimeRoot: string;
  readonly repairId: string;
  readonly rootCause: string;
  readonly riskClass: RiskClass;
  readonly diagnosis: string;
  readonly proposedChanges: readonly string[];
  readonly expectedImpact: string;
  readonly risks: readonly string[];
  readonly rollbackMethod: string;
  readonly verificationPlan: readonly string[];
  readonly recordedAt: string;
}): Promise<{ readonly state: "awaiting_gate1" }> {
  const recordedAt = timestampSchema.parse(request.recordedAt);
  const payload = {
    rootCause: z.string().trim().min(1).parse(request.rootCause),
    riskClass: riskClassSchema.parse(request.riskClass),
    diagnosis: z.string().trim().min(1).parse(request.diagnosis),
    proposedChanges: assertStringList(request.proposedChanges, "proposedChanges"),
    expectedImpact: z.string().trim().min(1).parse(request.expectedImpact),
    risks: assertStringList(request.risks, "risks"),
    rollbackMethod: z.string().trim().min(1).parse(request.rollbackMethod),
    verificationPlan: assertStringList(request.verificationPlan, "verificationPlan")
  };
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    const row = repairRow(database, request.repairId);
    requireState(row, ["diagnosing"]);
    await writeBundleFile(row.repair_bundle_path, "diagnosis.md", `# Diagnosis\n\n${payload.diagnosis}\n\nRoot cause: ${payload.rootCause}\nRisk class: ${payload.riskClass}\n`);
    await writeBundleFile(row.repair_bundle_path, "proposed-changes.md", `# Proposed changes\n\n${payload.proposedChanges.map((item) => `- ${item}`).join("\n")}\n\nExpected impact: ${payload.expectedImpact}\n\nRisks:\n${payload.risks.map((item) => `- ${item}`).join("\n")}\n\nRollback: ${payload.rollbackMethod}\n`);
    await writeBundleFile(row.repair_bundle_path, "verification-plan.md", `# Verification plan\n\n${payload.verificationPlan.map((item) => `- ${item}`).join("\n")}\n`);
    database.exec("BEGIN IMMEDIATE");
    database.prepare(
      "UPDATE repair_cases SET state = 'awaiting_gate1', root_cause = ?, risk_class = ?, updated_at = ? WHERE repair_id = ?"
    ).run(payload.rootCause, payload.riskClass, recordedAt, request.repairId);
    appendEvent(database, request.repairId, "proposal_recorded", payload, recordedAt);
    database.exec("COMMIT");
    return { state: "awaiting_gate1" };
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}

export async function approveRepairGate1(request: {
  readonly runtimeRoot: string;
  readonly repairId: string;
  readonly approvedBy: string;
  readonly authorizedTargets: readonly string[];
  readonly approvedAt: string;
}): Promise<{ readonly state: "gate1_approved" }> {
  const approvedAt = timestampSchema.parse(request.approvedAt);
  const payload = {
    approvedBy: z.string().trim().min(1).parse(request.approvedBy),
    authorizedTargets: assertStringList(request.authorizedTargets, "authorizedTargets")
  };
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    const row = repairRow(database, request.repairId);
    requireState(row, ["awaiting_gate1"]);
    database.exec("BEGIN IMMEDIATE");
    database.prepare("UPDATE repair_cases SET state = 'gate1_approved', updated_at = ? WHERE repair_id = ?")
      .run(approvedAt, request.repairId);
    appendEvent(database, request.repairId, "gate1_approved", payload, approvedAt);
    database.exec("COMMIT");
    return { state: "gate1_approved" };
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}

export async function recordRepairApplication(request: {
  readonly runtimeRoot: string;
  readonly repairId: string;
  readonly beforeVersion: string;
  readonly afterVersion: string;
  readonly changedTargets: readonly string[];
  readonly appliedAt: string;
}): Promise<{ readonly state: "awaiting_replay" }> {
  const appliedAt = timestampSchema.parse(request.appliedAt);
  const payload = {
    beforeVersion: z.string().trim().min(1).parse(request.beforeVersion),
    afterVersion: z.string().trim().min(1).parse(request.afterVersion),
    changedTargets: assertStringList(request.changedTargets, "changedTargets")
  };
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    const row = repairRow(database, request.repairId);
    requireState(row, ["gate1_approved"]);
    const gate1 = database.prepare(
      "SELECT payload_json FROM repair_events WHERE repair_id = ? AND kind = 'gate1_approved'"
    ).get(request.repairId);
    const gate1Payload = z.record(z.string(), z.unknown()).parse(
      JSON.parse(z.string().parse(gate1?.payload_json))
    );
    const authorized = z.array(z.string()).parse(gate1Payload.authorizedTargets);
    if (payload.changedTargets.some((target) => !authorized.includes(target))) {
      throw new Error("Repair application contains a target outside Review Gate 1 authorization.");
    }
    database.exec("BEGIN IMMEDIATE");
    database.prepare(
      `UPDATE repair_cases SET state = 'awaiting_replay', before_version = ?,
              after_version = ?, updated_at = ? WHERE repair_id = ?`
    ).run(payload.beforeVersion, payload.afterVersion, appliedAt, request.repairId);
    appendEvent(database, request.repairId, "application_recorded", payload, appliedAt);
    database.exec("COMMIT");
    return { state: "awaiting_replay" };
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}

const replayPayloadSchema = z.object({
  originalCasesPassed: z.boolean(),
  protectedCasesPassed: z.boolean(),
  aggregateTargetMet: z.boolean(),
  irrelevantRetrievalWorsened: z.boolean(),
  criticalRecallDecreased: z.boolean(),
  boundaryRegression: z.boolean(),
  labelsOrThresholdsWeakened: z.boolean(),
  commands: z.array(z.string().trim().min(1)).min(1)
});

export async function recordRepairReplay(request: {
  readonly runtimeRoot: string;
  readonly repairId: string;
  readonly originalCasesPassed: boolean;
  readonly protectedCasesPassed: boolean;
  readonly aggregateTargetMet: boolean;
  readonly irrelevantRetrievalWorsened: boolean;
  readonly criticalRecallDecreased: boolean;
  readonly boundaryRegression: boolean;
  readonly labelsOrThresholdsWeakened: boolean;
  readonly commands: readonly string[];
  readonly replayedAt: string;
}): Promise<{ readonly state: "awaiting_gate2" }> {
  const replayedAt = timestampSchema.parse(request.replayedAt);
  const payload = replayPayloadSchema.parse(request);
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    const row = repairRow(database, request.repairId);
    requireState(row, ["awaiting_replay"]);
    database.exec("BEGIN IMMEDIATE");
    database.prepare("UPDATE repair_cases SET state = 'awaiting_gate2', updated_at = ? WHERE repair_id = ?")
      .run(replayedAt, request.repairId);
    appendEvent(database, request.repairId, "replay_recorded", payload, replayedAt);
    database.exec("COMMIT");
    return { state: "awaiting_gate2" };
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}

function replayPasses(payload: z.infer<typeof replayPayloadSchema>): boolean {
  return payload.originalCasesPassed && payload.protectedCasesPassed &&
    payload.aggregateTargetMet && !payload.irrelevantRetrievalWorsened &&
    !payload.criticalRecallDecreased && !payload.boundaryRegression &&
    !payload.labelsOrThresholdsWeakened;
}

export async function approveRepairGate2(request: {
  readonly runtimeRoot: string;
  readonly repairId: string;
  readonly approvedBy: string;
  readonly approvedAt: string;
}): Promise<{ readonly state: "resolved" | "monitoring" }> {
  const approvedAt = timestampSchema.parse(request.approvedAt);
  const approvedBy = z.string().trim().min(1).parse(request.approvedBy);
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    const row = repairRow(database, request.repairId);
    requireState(row, ["awaiting_gate2"]);
    const riskClass = riskClassSchema.parse(row.risk_class);
    const replay = database.prepare(
      "SELECT payload_json FROM repair_events WHERE repair_id = ? AND kind = 'replay_recorded'"
    ).get(request.repairId);
    const replayPayload = replayPayloadSchema.parse(JSON.parse(z.string().parse(replay?.payload_json)));
    if (!replayPasses(replayPayload)) {
      throw new Error("Repair replay does not satisfy the accepted risk-tier evidence.");
    }
    const state = riskClass === "C" ? "monitoring" : "resolved";
    database.exec("BEGIN IMMEDIATE");
    database.prepare(
      "UPDATE repair_cases SET state = ?, updated_at = ?, resolved_at = ? WHERE repair_id = ?"
    ).run(state, approvedAt, state === "resolved" ? approvedAt : null, request.repairId);
    if (state === "resolved") {
      database.prepare("UPDATE bad_cases SET state = 'resolved' WHERE bad_case_id = ?")
        .run(row.bad_case_id);
    }
    appendEvent(database, request.repairId, "gate2_approved", { approvedBy, riskClass, state }, approvedAt);
    database.exec("COMMIT");
    return { state };
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}

function consecutiveCalendarDays(timestamps: readonly string[]): number {
  const days = [...new Set(timestamps.map((value) => value.slice(0, 10)))].sort();
  if (days.length === 0) return 0;
  let longest = 1;
  let current = 1;
  for (let index = 1; index < days.length; index += 1) {
    const previousDay = z.string().parse(days[index - 1]);
    const nextDay = z.string().parse(days[index]);
    const previous = Date.parse(`${previousDay}T00:00:00.000Z`);
    const next = Date.parse(`${nextDay}T00:00:00.000Z`);
    current = next - previous === 86_400_000 ? current + 1 : 1;
    longest = Math.max(longest, current);
  }
  return longest;
}

export async function recordSafetyObservation(request: {
  readonly runtimeRoot: string;
  readonly repairId: string;
  readonly opportunityCount: number;
  readonly violationCount: number;
  readonly observedAt: string;
}): Promise<{ readonly state: "monitoring" | "monitoring_failed" | "resolved" }> {
  const observedAt = timestampSchema.parse(request.observedAt);
  const opportunityCount = z.number().int().nonnegative().parse(request.opportunityCount);
  const violationCount = z.number().int().nonnegative().max(opportunityCount).parse(request.violationCount);
  const database = await openRuntimeDatabase(request.runtimeRoot);
  try {
    const row = repairRow(database, request.repairId);
    requireState(row, ["monitoring"]);
    database.exec("BEGIN IMMEDIATE");
    database.prepare(
      `INSERT INTO repair_safety_observations(
         observation_id, repair_id, opportunity_count, violation_count, observed_at
       ) VALUES (?, ?, ?, ?, ?)`
    ).run(`msrepairobservation_${randomUUID()}`, request.repairId, opportunityCount, violationCount, observedAt);
    appendEvent(database, request.repairId, "safety_observed", { opportunityCount, violationCount }, observedAt);
    const observations = database.prepare(
      `SELECT opportunity_count, violation_count, observed_at
       FROM repair_safety_observations WHERE repair_id = ? ORDER BY observed_at`
    ).all(request.repairId);
    const opportunities = observations.reduce(
      (sum, item) => sum + z.number().int().nonnegative().parse(item.opportunity_count),
      0
    );
    const violations = observations.reduce(
      (sum, item) => sum + z.number().int().nonnegative().parse(item.violation_count),
      0
    );
    const days = consecutiveCalendarDays(observations.map((item) => z.string().parse(item.observed_at)));
    const state = violations > 0
      ? "monitoring_failed"
      : opportunities >= 30 && days >= 7
        ? "resolved"
        : "monitoring";
    database.prepare(
      "UPDATE repair_cases SET state = ?, updated_at = ?, resolved_at = ? WHERE repair_id = ?"
    ).run(state, observedAt, state === "resolved" ? observedAt : null, request.repairId);
    if (state === "resolved") {
      database.prepare("UPDATE bad_cases SET state = 'resolved' WHERE bad_case_id = ?")
        .run(row.bad_case_id);
    }
    if (state === "monitoring_failed") {
      appendEvent(database, request.repairId, "monitoring_failed", { opportunities, violations, days }, observedAt);
    }
    database.exec("COMMIT");
    return { state };
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}

export async function inspectRepair(runtimeRoot: string, repairId: string): Promise<{
  readonly repairId: string;
  readonly badCaseId: string;
  readonly state: RepairState;
  readonly rootCause?: string;
  readonly riskClass?: RiskClass;
  readonly bundlePath: string;
  readonly modelRequirement: ReturnType<typeof modelRequirement>;
  readonly safetyOpportunityCount: number;
  readonly safetyViolationCount: number;
  readonly events: readonly RepairEvent[];
}> {
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    const row = repairRow(database, repairId);
    const totals = database.prepare(
      `SELECT COALESCE(SUM(opportunity_count), 0) AS opportunities,
              COALESCE(SUM(violation_count), 0) AS violations
       FROM repair_safety_observations WHERE repair_id = ?`
    ).get(repairId);
    const events = database.prepare(
      "SELECT kind, payload_json, recorded_at FROM repair_events WHERE repair_id = ? ORDER BY ordinal"
    ).all(repairId).map((event) => ({
      kind: z.string().parse(event.kind),
      payload: JSON.parse(z.string().parse(event.payload_json)) as unknown,
      recordedAt: z.string().parse(event.recorded_at)
    }));
    return {
      repairId: row.repair_id,
      badCaseId: row.bad_case_id,
      state: repairStateSchema.parse(row.state),
      ...(row.root_cause === null ? {} : { rootCause: row.root_cause }),
      ...(row.risk_class === null ? {} : { riskClass: riskClassSchema.parse(row.risk_class) }),
      bundlePath: row.repair_bundle_path,
      modelRequirement: modelRequirement(row.active_model),
      safetyOpportunityCount: z.number().int().nonnegative().parse(totals?.opportunities),
      safetyViolationCount: z.number().int().nonnegative().parse(totals?.violations),
      events
    };
  } finally {
    database.close();
  }
}
