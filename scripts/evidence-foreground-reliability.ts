import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendCaptureDisposition,
  importCaptureInboxBatch,
  inspectCaptureInbox
} from "../src/capture/inbox.js";
import {
  createForegroundRetrievalLane,
  type ForegroundLaneAttempt
} from "../src/retrieval/foreground-lane.js";
import {
  beginRetrievalIndexBuild,
  completeRetrievalIndexBuild,
  inspectRetrievalCatalogGeneration
} from "../src/retrieval/index-coordinator.js";
import { openRuntimeDatabase } from "../src/runtime/database.js";

async function legacyAbandonedRequestEvidence(): Promise<{
  readonly clientElapsedMs: number;
  readonly serverElapsedMs: number;
  readonly postDeadlineWorkMs: number;
}> {
  const started = performance.now();
  const serverWork = new Promise<void>((resolve) => { setTimeout(resolve, 19_700); });
  await Promise.race([
    serverWork,
    new Promise<void>((resolve) => { setTimeout(resolve, 50); })
  ]);
  const clientElapsedMs = performance.now() - started;
  await serverWork;
  const serverElapsedMs = performance.now() - started;
  return {
    clientElapsedMs,
    serverElapsedMs,
    postDeadlineWorkMs: Math.max(0, serverElapsedMs - 50)
  };
}

async function deadlineOwnedLaneEvidence(): Promise<{
  readonly firstState: string;
  readonly secondState: string;
  readonly postDeadlineWorkMs: number;
}> {
  let attempt: ForegroundLaneAttempt | undefined;
  const lane = createForegroundRetrievalLane({
    execute: async (request, control) => {
      await new Promise((resolve) => { setTimeout(resolve, 75); });
      await control.checkpoint("after_bounded_embedding");
      return { state: "completed" as const, requestId: request.requestId };
    },
    onAttempt: (record) => { attempt = record; }
  });
  const first = lane.run({
    requestId: "evidence-first",
    deadlineAt: new Date(Date.now() + 50).toISOString()
  });
  await new Promise((resolve) => { setTimeout(resolve, 10); });
  const second = await lane.run({
    requestId: "evidence-second",
    deadlineAt: new Date(Date.now() + 50).toISOString()
  });
  const firstResult = await first;
  if (attempt === undefined) throw new Error("Foreground attempt evidence was not recorded.");
  return {
    firstState: firstResult.state,
    secondState: second.state,
    postDeadlineWorkMs: attempt.postDeadlineWorkMs
  };
}

async function captureAndGenerationEvidence(root: string): Promise<unknown> {
  const runtimeRoot = join(root, "runtime");
  const database = await openRuntimeDatabase(runtimeRoot);
  database.exec("BEGIN IMMEDIATE");
  try {
    await appendCaptureDisposition({
      runtimeRoot,
      projectPath: root,
      capturedAt: "2026-08-26T19:00:00.000Z",
      disposition: {
        state: "event",
        event: {
          schemaVersion: 1,
          eventId: "msevent_foreground_evidence",
          deduplicationKey: "foreground:evidence",
          agent: "codex",
          eventKind: "Stop",
          occurredAt: "2026-08-26T19:00:00.000Z",
          sessionId: "foreground-evidence-session",
          payload: { assistantMessage: "Durable isolated evidence." }
        }
      }
    });
  } finally {
    database.exec("ROLLBACK");
    database.close();
  }
  const beforeImport = await inspectCaptureInbox(runtimeRoot);
  const imported = await importCaptureInboxBatch({
    runtimeRoot,
    importedAt: "2026-08-26T19:00:01.000Z",
    maximumEntries: 64,
    maximumMilliseconds: 25
  });
  const catalog = await openRuntimeDatabase(runtimeRoot);
  try {
    const insert = catalog.prepare(
      `INSERT INTO memory_catalog(
         memory_id, current_revision_id, canonical_path, scope_kind, project_id,
         authority, sensitivity, lifecycle, content_identity, revised_at, catalog_updated_at
       ) VALUES (?, ?, ?, 'global', NULL, 'agent_derived', 'normal', 'active', ?, ?, ?)`
    );
    for (let ordinal = 0; ordinal < 100; ordinal += 1) {
      insert.run(
        `msmem_evidence_${String(ordinal)}`,
        `msrev_evidence_${String(ordinal)}`,
        `/isolated/evidence-${String(ordinal)}.md`,
        `identity-${String(ordinal)}`,
        "2026-08-26T19:00:00.000Z",
        "2026-08-26T19:00:00.000Z"
      );
    }
  } finally {
    catalog.close();
  }
  const build = await beginRetrievalIndexBuild({
    runtimeRoot,
    now: "2026-08-26T19:01:00.000Z",
    activeIndexExists: true,
    adapterMatches: true,
    foregroundPressure: false
  });
  if (build.state !== "started") throw new Error("Index evidence build was not due.");
  await completeRetrievalIndexBuild({
    runtimeRoot,
    targetGeneration: build.targetGeneration,
    completedAt: "2026-08-26T19:01:01.000Z"
  });
  return {
    capture: {
      pendingBeforeImport: beforeImport.pendingCount,
      importedCount: imported.importedCount,
      remainingCount: imported.remainingCount
    },
    index: await inspectRetrievalCatalogGeneration(runtimeRoot)
  };
}

const root = await mkdtemp(join(tmpdir(), "memstore-foreground-evidence-"));
try {
  const [legacy, lane, durable] = await Promise.all([
    legacyAbandonedRequestEvidence(),
    deadlineOwnedLaneEvidence(),
    captureAndGenerationEvidence(root)
  ]);
  if (
    legacy.postDeadlineWorkMs < 19_000 ||
    lane.firstState !== "deadline_exceeded" ||
    lane.secondState !== "busy" ||
    lane.postDeadlineWorkMs > 100
  ) {
    throw new Error("Foreground reliability evidence did not meet its isolated assertions.");
  }
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    isolated: true,
    legacy,
    deadlineOwnedLane: lane,
    durable
  }, null, 2)}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
