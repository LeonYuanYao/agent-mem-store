import { expect, test } from "vitest";

import { inspectCodexHookStates } from "../../src/integration/codex-hook-state.js";

const hooksPath = "/home/fixture/.codex/hooks.json";
const events = ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop", "SessionEnd"] as const;

function memstoreRoute(event: string) {
  return {
    matcher: "*",
    hooks: [{ type: "command", command: `node hook.js codex ${event} # memstore:gate5-shadow-v1:${event}:active`, timeout: 2 }]
  };
}

const otherRoute = { matcher: "*", hooks: [{ type: "command", command: "other-tool hook", timeout: 5 }] };

function hooksSource(overrides: Partial<Record<typeof events[number], unknown[]>> = {}): string {
  return JSON.stringify({
    hooks: Object.fromEntries(events.map((event) => [event, overrides[event] ?? [memstoreRoute(event)]]))
  });
}

const reviewedState = [
  "[hooks.state]",
  ...events.map((event) => {
    const key = { SessionStart: "session_start", UserPromptSubmit: "user_prompt_submit", PostToolUse: "post_tool_use", Stop: "stop", SessionEnd: "session_end" }[event];
    return `[hooks.state."${hooksPath}:${key}:0:0"]\ntrusted_hash = "sha256:fixture"\n`;
  })
].join("\n");

test("reports every owned Hook as enabled when each position is reviewed and not disabled", () => {
  expect(inspectCodexHookStates({ hooksPath, hooksSource: hooksSource(), configSource: reviewedState })).toEqual({
    missing: [], disabled: [], unreviewed: [], enabledCount: 5
  });
});

test("a disabled flag left at a reordered position applies to the owned Hook that moved there", () => {
  // Another tool inserted its route before MemStore, so MemStore's PostToolUse moved
  // to group 1, where Codex still records the earlier occupant as disabled.
  const configSource = `${reviewedState}
[hooks.state."${hooksPath}:post_tool_use:1:0"]
trusted_hash = "sha256:other"
enabled = false
`;
  const report = inspectCodexHookStates({
    hooksPath,
    hooksSource: hooksSource({ PostToolUse: [otherRoute, memstoreRoute("PostToolUse")] }),
    configSource
  });

  expect(report.disabled).toEqual([{ event: "PostToolUse", key: `${hooksPath}:post_tool_use:1:0` }]);
  expect(report.enabledCount).toBe(4);
});

test("separates owned Hooks without a trust entry from Hooks missing from the file", () => {
  const report = inspectCodexHookStates({
    hooksPath,
    hooksSource: hooksSource({ Stop: [otherRoute, memstoreRoute("Stop")], SessionEnd: [otherRoute] }),
    configSource: reviewedState
  });

  expect(report.unreviewed).toEqual([{ event: "Stop", key: `${hooksPath}:stop:1:0` }]);
  expect(report.missing).toEqual([{ event: "SessionEnd", key: null }]);
  expect(report.enabledCount).toBe(3);
});
