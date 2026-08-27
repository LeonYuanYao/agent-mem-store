import { expect, test } from "vitest";

import { createForegroundRetrievalLane } from "../../src/retrieval/foreground-lane.js";

test("one admitted request owns the lane and later callers receive busy without queuing", async () => {
  let release: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const lane = createForegroundRetrievalLane({
    execute: async (request, control) => {
      await blocked;
      await control.checkpoint("after_block");
      return { state: "completed" as const, requestId: request.requestId, value: "done" };
    }
  });
  const first = lane.run({
    requestId: "first",
    deadlineAt: new Date(Date.now() + 1_000).toISOString()
  });
  await expect(lane.run({
    requestId: "second",
    deadlineAt: new Date(Date.now() + 1_000).toISOString()
  })).resolves.toEqual({ state: "busy", requestId: "second" });
  release?.();
  await expect(first).resolves.toEqual({ state: "completed", requestId: "first", value: "done" });
});

test("deadline abort stops before a later stage and releases the lane", async () => {
  const stages: string[] = [];
  const lane = createForegroundRetrievalLane({
    execute: async (request, control) => {
      stages.push("embedding_started");
      await new Promise((resolve) => setTimeout(resolve, 40));
      await control.checkpoint("after_embedding");
      stages.push("receipt_started");
      return { state: "completed" as const, requestId: request.requestId, value: "late" };
    }
  });
  await expect(lane.run({
    requestId: "deadline",
    deadlineAt: new Date(Date.now() + 10).toISOString()
  })).resolves.toEqual({ state: "deadline_exceeded", requestId: "deadline" });
  expect(stages).toEqual(["embedding_started"]);
  await expect(lane.run({
    requestId: "next",
    deadlineAt: new Date(Date.now() + 100).toISOString()
  })).resolves.toMatchObject({ state: "completed", requestId: "next" });
});

test("caller disconnect cancellation stops cooperative work", async () => {
  const controller = new AbortController();
  let reachedReceipt = false;
  const lane = createForegroundRetrievalLane({
    execute: async (request, control) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      await control.checkpoint("before_receipt");
      reachedReceipt = true;
      return { state: "completed" as const, requestId: request.requestId, value: "late" };
    }
  });
  const result = lane.run({
    requestId: "disconnect",
    deadlineAt: new Date(Date.now() + 1_000).toISOString()
  }, { signal: controller.signal });
  controller.abort();
  await expect(result).resolves.toEqual({ state: "cancelled", requestId: "disconnect" });
  expect(reachedReceipt).toBe(false);
});
