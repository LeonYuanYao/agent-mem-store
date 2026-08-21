import { expect, test } from "vitest";

import { mapCapturedEventToLunaEvidence } from "../../../src/worker/evidence.js";

test("reading Codex native memory is classified as Memory Echo evidence", () => {
  const evidence = mapCapturedEventToLunaEvidence({
    event: {
      schemaVersion: 1,
      eventId: "msevent_native_memory_read",
      deduplicationKey: "codex:native-memory-read",
      agent: "codex",
      eventKind: "PostToolUse",
      occurredAt: "2026-08-21T03:00:00.000Z",
      sessionId: "native-memory-session",
      payload: {
        command: "nl -ba /Users/example/.codex/memories/MEMORY.md | sed -n '1,80p'",
        cwd: "/Users/example/project",
        exitCode: 0
      }
    },
    sourceTruncated: false
  });

  expect(evidence.memoryEcho).toBe(true);
});
