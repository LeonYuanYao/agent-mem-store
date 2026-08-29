import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { handleCodexHook } from "../../src/adapters/codex/hook.js";
import {
  inspectCaptureEventState,
  readCapturedEvent
} from "../../src/capture/index.js";
import { openRuntimeDatabase } from "../../src/runtime/database.js";
import { runWorkerOnce } from "../../src/worker/main.js";
import { initializeMemStore } from "../../src/operations/initialize.js";
import { resolveProject } from "../../src/projects/index.js";
import { inspectStatus } from "../../src/operations/status.js";
import { inspectDoctor } from "../../src/operations/maintenance.js";
import {
  captureInboxFileMaximumPendingEntries,
  appendCaptureInboxEventFile,
  importNextCaptureInboxEventFile,
  inspectCaptureInboxFiles
} from "../../src/capture/inbox-files.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

test("a Stop event survives Runtime SQLite contention through the Capture Inbox", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-emergency-spool-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const database = await openRuntimeDatabase(runtimeRoot);
  database.exec("BEGIN IMMEDIATE");

  let result: Awaited<ReturnType<typeof handleCodexHook>>;
  try {
    result = await handleCodexHook({
      runtimeRoot,
      receivedAt: "2026-08-22T01:00:00.000Z",
      input: {
        hook_event_name: "Stop",
        session_id: "session-emergency-spool",
        turn_id: "turn-emergency-spool",
        cwd: root,
        last_assistant_message: "A durable conclusion that must survive contention."
      }
    });
  } finally {
    database.exec("ROLLBACK");
    database.close();
  }

  expect(result).toMatchObject({
    continue: true,
    captured: true,
    state: "captured"
  });
  if (!result.captured) throw new Error("Expected the Stop event to be durably captured.");

  await expect(runWorkerOnce({
    runtimeRoot,
    vaultRoot: join(root, "vault"),
    workerId: "worker-emergency-spool",
    now: "2026-08-22T01:00:01.000Z",
    workerStartedAt: "2026-08-22T00:59:00.000Z"
  })).resolves.toMatchObject({
    state: "worked",
    activities: ["capture-inbox:imported:1"]
  });

  await expect(
    inspectCaptureEventState(runtimeRoot, result.eventId)
  ).resolves.toMatchObject({
    eventId: result.eventId,
    state: "pending"
  });
});

test("an emergency-spooled event preserves an already registered Project during SQLite contention", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-emergency-project-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const project = await resolveProject({ runtimeRoot, path: root });
  if (project.status !== "resolved") throw new Error("Expected the Project to be registered.");
  const database = await openRuntimeDatabase(runtimeRoot);
  database.exec("BEGIN IMMEDIATE");

  let result: Awaited<ReturnType<typeof handleCodexHook>>;
  try {
    result = await handleCodexHook({
      runtimeRoot,
      receivedAt: "2026-08-22T01:05:00.000Z",
      input: {
        hook_event_name: "Stop",
        session_id: "session-emergency-project",
        turn_id: "turn-emergency-project",
        cwd: root,
        last_assistant_message: "Preserve the registered Project identity."
      }
    });
  } finally {
    database.exec("ROLLBACK");
    database.close();
  }

  expect(result).toMatchObject({
    captured: true,
    projectId: project.projectId
  });
  const pendingDirectory = join(runtimeRoot, "spool", "capture", "pending");
  const [fileName] = await readdir(pendingDirectory);
  if (fileName === undefined) throw new Error("Expected a pending emergency-spool entry.");
  const entry = JSON.parse(await readFile(join(pendingDirectory, fileName), "utf8")) as {
    event?: { projectId?: string };
  };
  expect(entry.event?.projectId).toBe(project.projectId);
});

test("the Capture Inbox preserves bounded-event truncation for a large Stop", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-emergency-spool-large-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const database = await openRuntimeDatabase(runtimeRoot);
  database.exec("BEGIN IMMEDIATE");

  let result: Awaited<ReturnType<typeof handleCodexHook>>;
  try {
    result = await handleCodexHook({
      runtimeRoot,
      receivedAt: "2026-08-22T01:10:00.000Z",
      input: {
        hook_event_name: "Stop",
        session_id: "session-emergency-spool-large",
        turn_id: "turn-emergency-spool-large",
        cwd: root,
        last_assistant_message: "x".repeat(1024 * 1024 + 4096)
      }
    });
  } finally {
    database.exec("ROLLBACK");
    database.close();
  }

  expect(result).toMatchObject({ captured: true, state: "captured" });
  if (!result.captured) throw new Error("Expected the large Stop event to be durably captured.");
  await runWorkerOnce({
    runtimeRoot,
    vaultRoot: join(root, "vault"),
    workerId: "worker-emergency-spool-large",
    now: "2026-08-22T01:10:01.000Z",
    workerStartedAt: "2026-08-22T01:09:00.000Z"
  });

  const captured = await readCapturedEvent(runtimeRoot, result.eventId);
  expect(captured?.payload).toMatchObject({
    memstoreTruncated: true,
    originalBytes: 1_052_695
  });
});

test("status and doctor expose a body-free emergency spool backlog", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-emergency-spool-status-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  await initializeMemStore({ runtimeRoot, vaultRoot, preview: false });

  await appendCaptureInboxEventFile({
    runtimeRoot,
    projectPath: root,
    spooledAt: "2026-01-01T00:00:00.000Z",
    event: {
      schemaVersion: 1,
      eventId: "msevent_emergency_status",
      deduplicationKey: "emergency:status",
      agent: "codex",
      eventKind: "Stop",
      occurredAt: "2026-01-01T00:00:00.000Z",
      sessionId: "session-emergency-status",
      turnId: "turn-emergency-status",
      payload: { assistantMessage: "This body must not appear in diagnostics." }
    }
  });

  const status = await inspectStatus({ runtimeRoot, vaultRoot });
  expect(status.pipelines.capture.capture_inbox).toMatchObject({
    pending_count: 1,
    oldest_pending_at: "2026-01-01T00:00:00.000Z",
    quarantine_count: 0
  });
  expect(status.pipelines.capture.capture_inbox.total_bytes).toBeGreaterThan(0);
  expect(JSON.stringify(status.pipelines.capture.capture_inbox))
    .not.toContain("This body must not appear");

  const doctor = await inspectDoctor({ runtimeRoot, vaultRoot, deep: false });
  expect(doctor.state).toBe("degraded");
  expect(doctor.checks.find((check) => check.name === "capture_inbox"))
    .toMatchObject({ state: "warning" });
});

test("the emergency spool quarantines malformed entries without blocking later imports", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-emergency-spool-quarantine-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const pendingRoot = join(runtimeRoot, "spool", "capture", "pending");
  await mkdir(pendingRoot, { recursive: true });
  await writeFile(join(pendingRoot, "000-invalid.json"), "not-json\n", "utf8");

  await expect(importNextCaptureInboxEventFile({
    runtimeRoot,
    importedAt: "2026-08-22T01:20:00.000Z"
  })).resolves.toEqual({ state: "quarantined", fileName: "000-invalid.json" });
  await expect(inspectCaptureInboxFiles(runtimeRoot)).resolves.toMatchObject({
    pendingCount: 0,
    quarantineCount: 1
  });
  await expect(readdir(join(runtimeRoot, "spool", "capture", "quarantine")))
    .resolves.toHaveLength(1);
});

test("the emergency spool refuses new events after reaching its bounded capacity", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-emergency-spool-capacity-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const pendingRoot = join(runtimeRoot, "spool", "capture", "pending");
  await mkdir(pendingRoot, { recursive: true });
  await Promise.all(Array.from(
    { length: captureInboxFileMaximumPendingEntries },
    (_, index) => writeFile(
      join(pendingRoot, `${String(index).padStart(4, "0")}.json`),
      "{}\n",
      "utf8"
    )
  ));

  await expect(appendCaptureInboxEventFile({
    runtimeRoot,
    projectPath: root,
    spooledAt: "2026-08-22T01:30:00.000Z",
    event: {
      schemaVersion: 1,
      eventId: "msevent_emergency_capacity",
      deduplicationKey: "emergency:capacity",
      agent: "codex",
      eventKind: "Stop",
      occurredAt: "2026-08-22T01:30:00.000Z",
      sessionId: "session-emergency-capacity",
      turnId: "turn-emergency-capacity",
      payload: { assistantMessage: "Capacity overflow must be explicit." }
    }
  })).rejects.toThrow("Capture Inbox capacity exceeded");
  await expect(inspectCaptureInboxFiles(runtimeRoot)).resolves.toMatchObject({
    pendingCount: captureInboxFileMaximumPendingEntries,
    maximumPendingCount: captureInboxFileMaximumPendingEntries,
    capacityState: "full"
  });
});
