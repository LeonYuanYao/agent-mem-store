import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test, vi } from "vitest";

import { readJevApiKey, readJevConfiguration } from "../../src/configuration/jev.js";
import { JevAutomaticRelevanceFilter, jevModel } from "../../src/retrieval/jev.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
const configuration = { enabled: true, threshold: 0.5, timeout_ms: 600 };
const input = () => ({ prompt: "Inspect SQLite WAL", recentPrompts: [],
  items: [{ memoryId: "memory-a", text: "Use SQLite WAL" }, { memoryId: "memory-b", text: "CSS colors" }],
  deadlineAt: Date.now() + 1000 });
const response = (scores = [0.5, 0.49]) => Response.json({ model: jevModel,
  answers: Object.fromEntries(scores.map((score, index) => [`c${String(index + 1)}`, { type: "noul", noul: score }])),
  usage: { input_tokens: 100, output_tokens: 20 } });
function filter(fetcher: typeof fetch, overrides: Partial<typeof configuration> = {}) {
  return new JevAutomaticRelevanceFilter({ runtimeRoot: "unused", fetch: fetcher,
    readConfiguration: () => Promise.resolve({ ...configuration, ...overrides }),
    readApiKey: () => Promise.resolve("synthetic-test-key") });
}

test("Jev is opt-in and does not read credentials or call the network when disabled", async () => {
  const fetcher = vi.fn<typeof fetch>();
  const readApiKey = vi.fn(() => Promise.resolve("synthetic-test-key"));
  const judge = new JevAutomaticRelevanceFilter({ runtimeRoot: "unused", fetch: fetcher,
    readConfiguration: () => Promise.resolve({ ...configuration, enabled: false }), readApiKey });
  expect((await judge.filter(input())).telemetry.state).toBe("disabled");
  expect(fetcher).not.toHaveBeenCalled();
  expect(readApiKey).not.toHaveBeenCalled();
});

test("valid scores preserve original identities without sending identities to the provider", async () => {
  const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(response()));
  const result = await filter(fetcher).filter(input());
  expect(result).toMatchObject({ telemetry: { state: "filtered", threshold: 0.5, inputTokens: 100, outputTokens: 20 },
    scores: [{ memoryId: "memory-a", score: 0.5 }, { memoryId: "memory-b", score: 0.49 }] });
  const call = fetcher.mock.calls[0];
  expect(call?.[0]).toBe("https://api.typesafe.ai/v1/systemone");
  expect(call?.[1]?.redirect).toBe("error");
  expect(call?.[1]?.body).not.toContain("memory-a");
  expect(JSON.stringify(result)).not.toContain("synthetic-test-key");
});

test("missing credentials and invalid configuration leave the local result available", async () => {
  const fetcher = vi.fn<typeof fetch>();
  const judge = new JevAutomaticRelevanceFilter({ runtimeRoot: "unused", fetch: fetcher,
    readConfiguration: () => Promise.resolve(configuration), readApiKey: () => Promise.resolve(undefined) });
  expect(await judge.filter(input())).toMatchObject({ telemetry: { state: "fallback", reason: "missing_credentials" } });
  const invalid = new JevAutomaticRelevanceFilter({ runtimeRoot: "unused", fetch: fetcher,
    readConfiguration: () => Promise.reject(new Error("private configuration details")) });
  const result = await invalid.filter(input());
  expect(result.telemetry.reason).toBe("configuration_unavailable");
  expect(JSON.stringify(result)).not.toContain("private");
  expect(fetcher).not.toHaveBeenCalled();
});

test.each([402, 429, 401, 403, 500, 529])("HTTP %s falls back without retry and enters a bounded cooldown", async status => {
  const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(new Response("private error body", { status })));
  const judge = filter(fetcher);
  const first = await judge.filter(input());
  expect(first.telemetry.state).toBe("fallback");
  expect(first.scores).toBeUndefined();
  expect(JSON.stringify(first)).not.toContain("private");
  expect((await judge.filter(input())).telemetry.reason).toBe("cooldown");
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test("an offline failure recovers after cooldown without restarting the filter", async () => {
  const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error("offline"))
    .mockImplementation(() => Promise.resolve(response()));
  const judge = filter(fetcher);
  expect((await judge.filter(input())).telemetry.reason).toBe("network_error");
  const future = Date.now() + 16_000;
  vi.spyOn(Date, "now").mockReturnValue(future);
  expect((await judge.filter(input())).telemetry.state).toBe("filtered");
});

test.each(["missing", "extra", "range", "model", "usage", "json", "oversize"])("invalid %s response cannot partially filter local candidates", async kind => {
  const value = { model: jevModel, answers: { c1: { type: "noul", noul: 0.9 }, c2: { type: "noul", noul: 0.1 } }, usage: { input_tokens: 100, output_tokens: 20 } };
  const bad = kind === "missing" ? Response.json({ ...value, answers: { c1: value.answers.c1 } })
    : kind === "extra" ? Response.json({ ...value, answers: { ...value.answers, c3: value.answers.c1 } })
    : kind === "range" ? response([1.1, 0.1])
    : kind === "model" ? Response.json({ ...value, model: "other-model" })
    : kind === "usage" ? Response.json({ ...value, usage: {} })
    : new Response(kind === "json" ? "not JSON" : "x".repeat(33 * 1024));
  const result = await filter(() => Promise.resolve(bad)).filter(input());
  expect(result.telemetry.reason).toBe("invalid_response");
  expect(result.scores).toBeUndefined();
});

test("timeout aborts a pending provider and returns before the outer deadline", async () => {
  let signal: AbortSignal | null | undefined;
  const fetcher: typeof fetch = (_url, options) => { signal = options?.signal; return new Promise(() => undefined); };
  const started = performance.now();
  const result = await filter(fetcher, { timeout_ms: 50 }).filter(input());
  expect(result.telemetry.reason).toBe("timeout");
  expect(performance.now() - started).toBeLessThan(350);
  expect(signal?.aborted).toBe(true);
});

test("a stalled response body is also bounded by the timeout", async () => {
  let cancelled = false;
  const fetcher: typeof fetch = () => Promise.resolve(new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"model":')); },
    cancel() { cancelled = true; }
  })));
  const result = await filter(fetcher, { timeout_ms: 50 }).filter(input());
  expect(result.telemetry.reason).toBe("timeout");
  // The timeout is independent of a custom transport's willingness to abort.
  expect(result.scores).toBeUndefined();
  expect(cancelled).toBe(true);
});

test("caller cancellation aborts provider work", async () => {
  const controller = new AbortController();
  const judge = filter((_url, options) => { expect(options?.signal).toBeDefined();
    controller.abort(); return new Promise(() => undefined); });
  expect((await judge.filter({ ...input(), signal: controller.signal })).telemetry.reason).toBe("cancelled");
});

test("insufficient deadline budget and empty local packs never call Jev", async () => {
  const fetcher = vi.fn<typeof fetch>();
  const judge = filter(fetcher);
  expect((await judge.filter({ ...input(), deadlineAt: Date.now() + 210 })).telemetry.reason).toBe("deadline_budget");
  expect((await judge.filter({ ...input(), items: [] })).telemetry.state).toBe("empty");
  expect(fetcher).not.toHaveBeenCalled();
});

test.each(["prompt", "history", "memory"])("suspected credentials in %s are never transmitted", async location => {
  const fetcher = vi.fn<typeof fetch>();
  const secret = "password=synthetic-secret-value";
  const request = { ...input(), ...(location === "prompt" ? { prompt: secret } : {}),
    ...(location === "history" ? { recentPrompts: [secret] } : {}),
    ...(location === "memory" ? { items: [{ memoryId: "a", text: secret }] } : {}) };
  expect((await filter(fetcher).filter(request)).telemetry.reason).toBe("sensitive_input");
  expect(fetcher).not.toHaveBeenCalled();
});

test("oversized input is kept local without truncating its meaning", async () => {
  const fetcher = vi.fn<typeof fetch>();
  expect((await filter(fetcher).filter({ ...input(), prompt: "x".repeat(50 * 1024) })).telemetry.reason).toBe("input_limit");
  expect(fetcher).not.toHaveBeenCalled();
});

test("configuration defaults off; file credentials require an owner-only regular file", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-jev-config-")); roots.push(root);
  await writeFile(join(root, "config.toml"), "schema_version = 1\n");
  expect(await readJevConfiguration(root)).toEqual({ enabled: false, threshold: 0.5, timeout_ms: 600 });
  vi.stubEnv("JEV_MODEL_API_KEY", undefined);
  expect(await readJevApiKey(root)).toBeUndefined();
  await mkdir(join(root, "secrets"));
  const path = join(root, "secrets", "jev-api-key");
  await writeFile(path, "synthetic-test-key\n", { mode: 0o600 });
  expect(await readJevApiKey(root)).toBe("synthetic-test-key");
  await chmod(path, 0o644);
  expect(await readJevApiKey(root)).toBeUndefined();
  await rm(path);
  await symlink(join(root, "config.toml"), path);
  expect(await readJevApiKey(root)).toBeUndefined();
  vi.stubEnv("JEV_MODEL_API_KEY", "synthetic-environment-key");
  expect(await readJevApiKey(root)).toBe("synthetic-environment-key");
});
