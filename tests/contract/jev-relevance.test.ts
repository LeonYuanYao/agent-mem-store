import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test, vi } from "vitest";

import { readJevApiKey, readJevConfiguration } from "../../src/configuration/jev.js";
import { JevAutomaticRelevanceFilter, jevModel, jevTelemetrySchema } from "../../src/retrieval/jev.js";

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
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
  expect(result).toMatchObject({ telemetry: { state: "filtered", threshold: 0.5, inputTokens: 100, outputTokens: 20,
    budgetMs: 600, budgetSource: "stage_timeout", httpStarted: true, stage: "complete" },
    scores: [{ memoryId: "memory-a", score: 0.5 }, { memoryId: "memory-b", score: 0.49 }] });
  const call = fetcher.mock.calls[0];
  expect(call?.[0]).toBe("https://api.typesafe.ai/v1/systemone");
  expect(call?.[1]?.redirect).toBe("error");
  expect(call?.[1]?.body).not.toContain("memory-a");
  expect(JSON.stringify(result)).not.toContain("synthetic-test-key");
  expect(jevTelemetrySchema.parse(result.telemetry)).toEqual(result.telemetry);
});

test("historical Jev telemetry stays readable without inventing missing diagnostics", () => {
  const legacy = { state: "fallback", model: jevModel, threshold: 0.5, elapsedMs: 600, reason: "timeout" };
  expect(jevTelemetrySchema.parse(legacy)).toEqual(legacy);
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
  expect((await judge.filter(input())).telemetry).toMatchObject({
    reason: "cooldown", httpStarted: false, stage: "configuration"
  });
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
  expect(result.telemetry).toMatchObject({ httpStarted: true,
    stage: kind === "json" || kind === "oversize" ? "response_body" : "validation" });
  expect(result.scores).toBeUndefined();
});

test("timeout aborts a pending provider and returns before the outer deadline", async () => {
  let signal: AbortSignal | null | undefined;
  const fetcher: typeof fetch = (_url, options) => { signal = options?.signal; return new Promise(() => undefined); };
  const started = performance.now();
  const result = await filter(fetcher, { timeout_ms: 50 }).filter(input());
  expect(result.telemetry).toMatchObject({ reason: "timeout", budgetMs: 50,
    budgetSource: "stage_timeout", httpStarted: true, stage: "response_headers" });
  expect(performance.now() - started).toBeLessThan(350);
  expect(signal?.aborted).toBe(true);
});

test("a timeout before configuration loads records deadline pressure without an HTTP attempt", async () => {
  vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
  const fetcher = vi.fn<typeof fetch>();
  const judge = new JevAutomaticRelevanceFilter({ runtimeRoot: "unused", fetch: fetcher,
    readConfiguration: () => new Promise(() => undefined) });
  const pending = judge.filter({ ...input(), deadlineAt: Date.now() + 400 });
  await vi.advanceTimersByTimeAsync(200);
  expect(await pending).toMatchObject({ telemetry: {
    state: "fallback", reason: "timeout", elapsedMs: 200,
    deadlineRemainingMs: 400, budgetMs: 200, budgetSource: "foreground_deadline",
    httpStarted: false, stage: "configuration"
  } });
  expect(fetcher).not.toHaveBeenCalled();
});

test("configuration time stays inside the configured budget while credentials stall", async () => {
  vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
  const fetcher = vi.fn<typeof fetch>();
  const judge = new JevAutomaticRelevanceFilter({ runtimeRoot: "unused", fetch: fetcher,
    readConfiguration: () => new Promise(resolve => {
      setTimeout(() => { resolve({ ...configuration, timeout_ms: 150 }); }, 40);
    }),
    readApiKey: () => new Promise(() => undefined) });
  const pending = judge.filter(input());
  await vi.advanceTimersByTimeAsync(150);
  expect(await pending).toMatchObject({ telemetry: {
    state: "fallback", reason: "timeout", elapsedMs: 150,
    deadlineRemainingMs: 1000, budgetMs: 150, budgetSource: "stage_timeout",
    httpStarted: false, stage: "credentials"
  } });
  expect(fetcher).not.toHaveBeenCalled();
});

test("a configured 1.3-second Jev budget permits a response after the former one-second limit", async () => {
  vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
  const fetcher: typeof fetch = () => new Promise(resolve => {
    setTimeout(() => { resolve(response()); }, 1200);
  });
  const pending = filter(fetcher, { timeout_ms: 1300 }).filter({ ...input(), deadlineAt: Date.now() + 1800 });
  await vi.advanceTimersByTimeAsync(1200);
  expect(await pending).toMatchObject({ telemetry: {
    state: "filtered", budgetMs: 1300, elapsedMs: 1200, budgetSource: "stage_timeout", httpStarted: true
  } });
});

test.each([
  { remainingMs: 1800, budgetMs: 1300, source: "stage_timeout" },
  { remainingMs: 950, budgetMs: 750, source: "foreground_deadline" }
])("a stalled Jev call respects its budget with $remainingMs ms left", async ({ remainingMs, budgetMs, source }) => {
  vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
  let signal: AbortSignal | null | undefined;
  const fetcher = vi.fn<typeof fetch>((_url, options) => {
    signal = options?.signal;
    return new Promise(() => undefined);
  });
  const pending = filter(fetcher, { timeout_ms: 1300 }).filter({ ...input(), deadlineAt: Date.now() + remainingMs });
  await vi.advanceTimersByTimeAsync(budgetMs);
  const result = await pending;
  expect(result.telemetry).toMatchObject({ reason: "timeout", budgetMs, elapsedMs: budgetMs,
    budgetSource: source, httpStarted: true, stage: "response_headers" });
  expect(jevTelemetrySchema.parse(result.telemetry)).toEqual(result.telemetry);
  expect(result.scores).toBeUndefined();
  expect(signal?.aborted).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test("a stalled response body is also bounded by the timeout", async () => {
  let cancelled = false;
  const fetcher: typeof fetch = () => Promise.resolve(new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"model":')); },
    cancel() { cancelled = true; }
  })));
  const result = await filter(fetcher, { timeout_ms: 50 }).filter(input());
  expect(result.telemetry).toMatchObject({ reason: "timeout", budgetMs: 50,
    budgetSource: "stage_timeout", httpStarted: true, stage: "response_body" });
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
  vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
  const fetcher = vi.fn<typeof fetch>();
  const judge = filter(fetcher);
  expect((await judge.filter({ ...input(), deadlineAt: Date.now() + 210 })).telemetry).toMatchObject({
    reason: "deadline_budget", deadlineRemainingMs: 210, budgetMs: 10,
    budgetSource: "foreground_deadline", httpStarted: false, stage: "admission"
  });
  const expired = await judge.filter({ ...input(), deadlineAt: Date.now() - 1 });
  expect(expired.telemetry).toMatchObject({ reason: "deadline_budget", deadlineRemainingMs: 0, budgetMs: 0 });
  expect(jevTelemetrySchema.parse(expired.telemetry)).toEqual(expired.telemetry);
  expect((await judge.filter({ ...input(), items: [] })).telemetry).toMatchObject({
    state: "empty", httpStarted: false, stage: "admission"
  });
  expect(fetcher).not.toHaveBeenCalled();
});

test.each(["prompt", "history", "memory"])("suspected credentials in %s are never transmitted", async location => {
  const fetcher = vi.fn<typeof fetch>();
  const secret = "password=synthetic-secret-value";
  const request = { ...input(), ...(location === "prompt" ? { prompt: secret } : {}),
    ...(location === "history" ? { recentPrompts: [secret] } : {}),
    ...(location === "memory" ? { items: [{ memoryId: "a", text: secret }] } : {}) };
  expect((await filter(fetcher).filter(request)).telemetry).toMatchObject({
    reason: "sensitive_input", httpStarted: false, stage: "request_preparation"
  });
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
  expect(await readJevConfiguration(root)).toEqual({ enabled: false, threshold: 0.5, timeout_ms: 1300 });
  await writeFile(join(root, "config.toml"), "schema_version = 1\n[jev]\nenabled = true\ntimeout_ms = 1300\n");
  expect(await readJevConfiguration(root)).toEqual({ enabled: true, threshold: 0.5, timeout_ms: 1300 });
  await writeFile(join(root, "config.toml"), "schema_version = 1\n[jev]\ntimeout_ms = 1301\n");
  await expect(readJevConfiguration(root)).rejects.toThrow();
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

test("Jev receives role-labeled context for long requests and resolves applicability explicitly", async () => {
  const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(response()));
  const result = await filter(fetcher).filter({ ...input(), prompt: `Apply that plan. ${"Verify the result. ".repeat(20)}`,
    conversation: { status: "available", messages: [
      { role: "user", text: "Inspect project A only; do not change project B.", truncated: false },
      { role: "assistant", text: "I propose checking A. The cause remains unconfirmed.", truncated: false }
    ] } });
  expect(result.telemetry).toMatchObject({ state: "filtered", contextStatus: "available", contextMessageCount: 2, contextPolicyVersion: 1, contextTruncated: false });
  const body = fetcher.mock.calls[0]?.[1]?.body;
  expect(body).toContain("[user; previous_message=2]");
  expect(body).toContain("[assistant; previous_message=1]");
  expect(body).toContain("cause remains unconfirmed");
  expect(body).toContain("not as independent factual proof or new authorization");
  expect(JSON.stringify(result.telemetry)).not.toContain("project A");
});

test("serialized request budget reallocates history space and never truncates the current request", async () => {
  const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(response()));
  const prompt = "SQLite WAL \"escaped\"\\value ".repeat(350);
  const result = await filter(fetcher, { timeout_ms: 1300 }).filter({ ...input(), deadlineAt: Date.now() + 1800, prompt,
    conversation: { status: "available", messages: [
      { role: "user", text: "Check WAL.", truncated: false },
      { role: "assistant", text: Array.from({ length: 120 }, (_, i) => `Plan ${String(i)}: inspect SQLite WAL; do not delete the database.`).join("\n\n"), truncated: false }
    ] } });
  expect(result.telemetry.state).toBe("filtered");
  expect(result.telemetry.requestTokens).toBeLessThanOrEqual(4096);
  expect(result.telemetry.contextTokens).toBeLessThanOrEqual(1024);
  expect(result.telemetry.contextTruncated).toBe(true);
  expect(fetcher.mock.calls[0]?.[1]?.body).toContain(JSON.stringify(prompt));
});

test("context sensitivity is checked before paragraph selection", async () => {
  const fetcher = vi.fn<typeof fetch>();
  const result = await filter(fetcher).filter({ ...input(), conversation: { status: "available", messages: [
    { role: "assistant", text: `Safe plan.\n\n${"noise ".repeat(4000)}\n\napi_key=sk-1234567890abcdefghijklmnopqrstuv`, truncated: false }
  ] } });
  expect(result.telemetry).toMatchObject({ state: "fallback", reason: "sensitive_input" });
  expect(fetcher).not.toHaveBeenCalled();
});
