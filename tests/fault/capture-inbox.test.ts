import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import {
  appendCaptureDisposition,
  importCaptureInboxBatch,
  inspectCaptureInbox,
  prepareCaptureDisposition
} from "../../src/capture/inbox.js";
import { handleCodexHook } from "../../src/adapters/codex/hook.js";
import {
  inspectCaptureEventState,
  inspectSensitivityFinding
} from "../../src/capture/index.js";
import { openRuntimeDatabase } from "../../src/runtime/database.js";
import { runWorkerOnce } from "../../src/worker/main.js";
import { resolveProject } from "../../src/projects/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fileBodies(root: string): Promise<readonly string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  return (await Promise.all(entries.map(async (entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? fileBodies(path) : entry.isFile() ? [await readFile(path, "utf8")] : [];
  }))).flat();
}

test("a normal Capture disposition becomes durable while Runtime SQLite is locked", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-capture-inbox-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const database = await openRuntimeDatabase(runtimeRoot);
  database.exec("BEGIN IMMEDIATE");
  try {
    await expect(appendCaptureDisposition({
      runtimeRoot,
      projectPath: root,
      capturedAt: "2026-08-26T18:00:00.000Z",
      disposition: {
        state: "event",
        event: {
          schemaVersion: 1,
          eventId: "msevent_capture_inbox_locked",
          deduplicationKey: "capture-inbox:locked",
          agent: "codex",
          eventKind: "Stop",
          occurredAt: "2026-08-26T18:00:00.000Z",
          sessionId: "capture-inbox-session",
          turnId: "capture-inbox-turn",
          payload: { assistantMessage: "Keep Capture durable without the SQLite writer." }
        }
      }
    })).resolves.toMatchObject({
      state: "durable",
      eventId: "msevent_capture_inbox_locked"
    });
  } finally {
    database.exec("ROLLBACK");
    database.close();
  }

  await expect(inspectCaptureInbox(runtimeRoot)).resolves.toMatchObject({
    pendingCount: 1,
    dispositionCount: 0,
    quarantineCount: 0
  });
});

test("a Codex Hook uses the Capture Inbox as its normal durable ingress", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-capture-inbox-hook-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");

  const result = await handleCodexHook({
    runtimeRoot,
    receivedAt: "2026-08-26T18:01:00.000Z",
    input: {
      hook_event_name: "Stop",
      session_id: "capture-inbox-hook-session",
      turn_id: "capture-inbox-hook-turn",
      cwd: root,
      last_assistant_message: "Capture through the durable Inbox before SQLite."
    }
  });

  expect(result).toMatchObject({ continue: true, captured: true });
  if (!result.captured) throw new Error("Expected a durably captured Hook event.");
  await expect(inspectCaptureInbox(runtimeRoot)).resolves.toMatchObject({ pendingCount: 1 });
  await expect(inspectCaptureEventState(runtimeRoot, result.eventId)).resolves.toBeUndefined();
});

test("the Worker imports a bounded Capture Inbox batch idempotently", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-capture-inbox-import-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const result = await handleCodexHook({
    runtimeRoot,
    receivedAt: "2026-08-26T18:02:00.000Z",
    input: {
      hook_event_name: "Stop",
      session_id: "capture-inbox-import-session",
      turn_id: "capture-inbox-import-turn",
      cwd: root,
      last_assistant_message: "Import one durable Capture disposition exactly once."
    }
  });
  if (!result.captured) throw new Error("Expected a durably captured Hook event.");

  await expect(importCaptureInboxBatch({
    runtimeRoot,
    importedAt: "2026-08-26T18:02:01.000Z",
    maximumEntries: 64,
    maximumMilliseconds: 25
  })).resolves.toEqual({
    state: "imported",
    importedCount: 1,
    quarantinedCount: 0,
    remainingCount: 0
  });
  await expect(inspectCaptureEventState(runtimeRoot, result.eventId)).resolves.toMatchObject({
    eventId: result.eventId,
    state: "pending"
  });
  await expect(importCaptureInboxBatch({
    runtimeRoot,
    importedAt: "2026-08-26T18:02:02.000Z",
    maximumEntries: 64,
    maximumMilliseconds: 25
  })).resolves.toEqual({
    state: "empty",
    importedCount: 0,
    quarantinedCount: 0,
    remainingCount: 0
  });
});

test("one Worker iteration drains a bounded Capture Inbox batch before other work", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-capture-inbox-worker-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  // This test measures bounded Inbox import, not first-use Project discovery.
  await resolveProject({ runtimeRoot, path: root });
  for (const ordinal of [1, 2]) {
    await handleCodexHook({
      runtimeRoot,
      receivedAt: `2026-08-26T18:03:0${String(ordinal)}.000Z`,
      input: {
        hook_event_name: "Stop",
        session_id: "capture-inbox-worker-session",
        turn_id: `capture-inbox-worker-turn-${String(ordinal)}`,
        cwd: root,
        last_assistant_message: `Durable Inbox event ${String(ordinal)}.`
      }
    });
  }

  await expect(runWorkerOnce({
    runtimeRoot,
    vaultRoot,
    workerId: "capture-inbox-worker",
    now: "2026-08-26T18:03:10.000Z",
    workerStartedAt: "2026-08-26T18:00:00.000Z"
  })).resolves.toMatchObject({
    state: "worked",
    activities: ["capture-inbox:imported:2"]
  });
  await expect(inspectCaptureInbox(runtimeRoot)).resolves.toMatchObject({ pendingCount: 0 });
});

test("a Secret Capture disposition is durable without retaining the matched body", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-capture-inbox-secret-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const secret = "sk-live-0123456789abcdefghijklmnopqrstuvwxyz";
  const disposition = await prepareCaptureDisposition({
    runtimeRoot,
    event: {
      schemaVersion: 1,
      eventId: "msevent_capture_inbox_secret",
      deduplicationKey: "capture-inbox:secret",
      agent: "codex",
      eventKind: "PostToolUse",
      occurredAt: "2026-08-26T18:04:00.000Z",
      sessionId: "capture-inbox-secret-session",
      payload: { output: `Authorization: Bearer ${secret}` }
    }
  });
  expect(disposition).toMatchObject({
    state: "blocked_secret",
    finding: { category: "authorization_header" }
  });
  await appendCaptureDisposition({
    runtimeRoot,
    projectPath: root,
    capturedAt: "2026-08-26T18:04:00.000Z",
    disposition
  });

  await expect(inspectCaptureInbox(runtimeRoot)).resolves.toMatchObject({
    pendingCount: 1,
    dispositionCount: 1
  });
  expect((await fileBodies(runtimeRoot)).some((body) => body.includes(secret))).toBe(false);
});

test("a Codex Hook durably reports a body-free Secret disposition", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-capture-inbox-secret-hook-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const secret = "sk-live-abcdefghijklmnopqrstuvwxyz0123456789";

  const result = await handleCodexHook({
    runtimeRoot,
    receivedAt: "2026-08-26T18:05:00.000Z",
    input: {
      hook_event_name: "PostToolUse",
      session_id: "capture-inbox-secret-hook-session",
      turn_id: "capture-inbox-secret-hook-turn",
      cwd: root,
      tool_name: "exec_command",
      tool_use_id: "capture-inbox-secret-hook-call",
      tool_input: { cmd: "redacted command" },
      tool_response: { output: `Authorization: Bearer ${secret}` }
    }
  });
  expect(result).toMatchObject({
    continue: true,
    captured: false,
    state: "blocked_secret"
  });
  if (result.captured || result.state !== "blocked_secret") {
    throw new Error("Expected a body-free Secret disposition.");
  }
  await expect(inspectCaptureInbox(runtimeRoot)).resolves.toMatchObject({ dispositionCount: 1 });
  expect((await fileBodies(runtimeRoot)).some((body) => body.includes(secret))).toBe(false);
  await expect(importCaptureInboxBatch({
    runtimeRoot,
    importedAt: "2026-08-26T18:05:01.000Z",
    maximumEntries: 64,
    maximumMilliseconds: 25
  })).resolves.toMatchObject({ importedCount: 1, remainingCount: 0 });
  await expect(inspectSensitivityFinding(runtimeRoot, result.findingId)).resolves.toMatchObject({
    findingId: result.findingId,
    state: "blocked_secret",
    category: "authorization_header",
    bodyRetained: false
  });
});

test("parallel Capture appends create unique owner-only Inbox files", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-capture-inbox-parallel-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const results = await Promise.all(Array.from({ length: 20 }, async (_, ordinal) => {
    const disposition = await prepareCaptureDisposition({
      runtimeRoot,
      event: {
        schemaVersion: 1,
        eventId: `msevent_capture_inbox_parallel_${String(ordinal)}`,
        deduplicationKey: `capture-inbox:parallel:${String(ordinal)}`,
        agent: "codex",
        eventKind: "Stop",
        occurredAt: `2026-08-26T18:06:${String(ordinal).padStart(2, "0")}.000Z`,
        sessionId: "capture-inbox-parallel-session",
        turnId: `capture-inbox-parallel-turn-${String(ordinal)}`,
        payload: { assistantMessage: `Parallel durable event ${String(ordinal)}.` }
      }
    });
    return appendCaptureDisposition({
        runtimeRoot,
        projectPath: root,
        capturedAt: `2026-08-26T18:06:${String(ordinal).padStart(2, "0")}.000Z`,
        disposition
      });
  }));

  expect(results).toHaveLength(20);
  await expect(inspectCaptureInbox(runtimeRoot)).resolves.toMatchObject({
    pendingCount: 20,
    normalEventCount: 20,
    dispositionCount: 0
  });
  const files = await readdir(join(runtimeRoot, "spool", "capture", "pending"));
  expect(new Set(files).size).toBe(20);
  await Promise.all(files.map(async (fileName) => {
    const mode = (await stat(join(runtimeRoot, "spool", "capture", "pending", fileName))).mode;
    expect(mode & 0o077).toBe(0);
  }));

  await expect(importCaptureInboxBatch({
    runtimeRoot,
    importedAt: "2026-08-26T18:07:00.000Z",
    maximumEntries: 64,
    maximumMilliseconds: 5_000
  })).resolves.toMatchObject({ importedCount: 20, remainingCount: 0 });
});

test("a malformed body-free disposition is quarantined without blocking later import", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-capture-inbox-bad-disposition-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const directory = join(runtimeRoot, "spool", "capture", "dispositions");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "000-invalid.json"), "not-json\n", "utf8");

  await expect(importCaptureInboxBatch({
    runtimeRoot,
    importedAt: "2026-08-26T18:08:00.000Z",
    maximumEntries: 64,
    maximumMilliseconds: 25
  })).resolves.toEqual({
    state: "quarantined",
    importedCount: 0,
    quarantinedCount: 1,
    remainingCount: 0
  });
  await expect(inspectCaptureInbox(runtimeRoot)).resolves.toMatchObject({
    pendingCount: 0,
    quarantineCount: 1
  });
});

test("a stale Capture Inbox capacity lock is recovered before append", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-capture-inbox-stale-lock-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const lockPath = join(runtimeRoot, "spool", "capture", ".capacity-lock");
  await mkdir(lockPath, { recursive: true });
  const staleAt = new Date(Date.now() - 10_000);
  await utimes(lockPath, staleAt, staleAt);

  await expect(handleCodexHook({
    runtimeRoot,
    receivedAt: "2026-08-26T18:09:00.000Z",
    input: {
      hook_event_name: "SessionEnd",
      session_id: "capture-inbox-stale-lock-session",
      turn_id: "capture-inbox-stale-lock-turn",
      cwd: root,
      reason: "completed"
    }
  })).resolves.toMatchObject({ captured: true, state: "captured" });
  await expect(inspectCaptureInbox(runtimeRoot)).resolves.toMatchObject({ pendingCount: 1 });
});
