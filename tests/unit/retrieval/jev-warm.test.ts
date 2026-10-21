import { afterEach, expect, test, vi } from "vitest";

import { JevConnectionWarmer, jevWarmCheckMilliseconds, jevWarmIntervalMilliseconds } from "../../../src/retrieval/jev-warm.js";
import { idleSocketMilliseconds } from "../../../src/retrieval/proxy-fetch.js";

afterEach(() => { vi.useRealTimers(); });

function warmer() {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
  const warm = vi.fn<(options: { readonly reuseAfterMs: number }) => Promise<void>>(() => Promise.resolve());
  return { warm, subject: new JevConnectionWarmer({ warm, intervalMs: 1_000, checkMs: 100, activeWindowMs: 5_000 }) };
}

test("the connection is used again before the pool closes it as idle", () => {
  expect(jevWarmIntervalMilliseconds + jevWarmCheckMilliseconds).toBeLessThan(idleSocketMilliseconds);
});

test("nothing is sent before any foreground activity", async () => {
  const { warm } = warmer();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(warm).not.toHaveBeenCalled();
});

test("a Session boundary warms at once; prompts only start the checks", () => {
  const { warm, subject } = warmer();
  subject.noteActivity({ warmNow: false });
  expect(warm).not.toHaveBeenCalled();
  subject.noteActivity({ warmNow: true });
  expect(warm).toHaveBeenCalledTimes(1);
  expect(warm).toHaveBeenLastCalledWith({ reuseAfterMs: 1_000 });
  subject.close();
});

test("the pool is checked during the active window, and checks stop after it", async () => {
  const { warm, subject } = warmer();
  subject.noteActivity({ warmNow: false });
  // The client decides per check whether to reuse, reopen or skip.
  await vi.advanceTimersByTimeAsync(4_999);
  expect(warm).toHaveBeenCalledTimes(49);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(warm).toHaveBeenCalledTimes(50);
  subject.noteActivity({ warmNow: false });
  await vi.advanceTimersByTimeAsync(1_000);
  expect(warm).toHaveBeenCalledTimes(60);
  subject.close();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(warm).toHaveBeenCalledTimes(60);
});

test("a slow warm-up is not stacked and a failing one does not escape", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
  let release: (() => void) | undefined;
  const warm = vi.fn(() => new Promise<void>((_resolve, reject) => { release = () => { reject(new Error("offline")); }; }));
  const subject = new JevConnectionWarmer({ warm, intervalMs: 1_000, checkMs: 100, activeWindowMs: 5_000 });
  subject.noteActivity({ warmNow: true });
  await vi.advanceTimersByTimeAsync(2_000);
  expect(warm).toHaveBeenCalledTimes(1);
  release?.();
  await vi.advanceTimersByTimeAsync(100);
  expect(warm).toHaveBeenCalledTimes(2);
  subject.close();
});

test("closed warmers ignore later activity", async () => {
  const { warm, subject } = warmer();
  subject.close();
  subject.noteActivity({ warmNow: true });
  await vi.advanceTimersByTimeAsync(5_000);
  expect(warm).not.toHaveBeenCalled();
});
