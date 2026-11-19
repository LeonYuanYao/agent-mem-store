import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import type { ConversationView } from "../../../src/retrieval/conversation-cache.js";
import { buildRetrievalIndex, type EmbeddingAdapter } from "../../../src/retrieval/index.js";
import type { AutomaticRelevanceFilter } from "../../../src/retrieval/jev.js";
import { inspectRetrievalReceipt, prepareUserPromptShadowPack } from "../../../src/retrieval/packs.js";
import { writeCanonicalMemory } from "../../../src/vault/index.js";
import { makeCanonicalMemory } from "../../helpers/canonical-memory.js";

// ADR-0180: a short prompt's Jev pool also ranks Memories by the reply it answers.
const projectId = "msproj_123e4567-e89b-42d3-a456-426614176000";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

// Prompt similarity falls and reply similarity rises across the palette notes; the
// release-train Memory is only moderately like the prompt but closest to the reply.
const palette = (index: number): number[] => [1 - 0.04 * index, 0.5, 0.01 * index];
const adapter: EmbeddingAdapter = {
  identity: { adapterVersion: "assistant-context-fixture-v1", modelIdentity: "assistant-context-fixture", artifactSha256: "a".repeat(64),
    dimensions: 3, normalization: "l2" },
  embed: (texts) => Promise.resolve(texts.map(text => /release train/iu.test(text) ? [0.5, 0, 0.85]
    : palette(Number(/palette (\d+)/u.exec(text)?.[1] ?? "0")))),
  embedQuery: (texts) => Promise.resolve(texts.map(text => /release train/iu.test(text) ? [0, 0, 1] : [1, 0, 0]))
};
const releaseTrain = makeCanonicalMemory({
  memoryId: "msmem_123e4567-e89b-42d3-a456-426614176001", revisionId: "msrev_123e4567-e89b-42d3-a456-426614176101",
  scope: { kind: "project", projectId }, body: "The release train freezes merges every Thursday at noon.",
  compact: "The release train freezes merges every Thursday at noon.", startup: "never"
});
const noise = Array.from({ length: 20 }, (_, index) => makeCanonicalMemory({
  memoryId: `msmem_123e4567-e89b-42d3-a456-4266141762${String(index).padStart(2, "0")}`,
  revisionId: `msrev_123e4567-e89b-42d3-a456-4266141763${String(index).padStart(2, "0")}`,
  scope: { kind: "project", projectId }, body: `Status page palette ${String(index)} uses muted colours.`,
  compact: `Status page palette ${String(index)} uses muted colours.`, startup: "never"
}));

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "memstore-assistant-context-"));
  roots.push(root);
  const location = { runtimeRoot: join(root, "runtime"), vaultRoot: join(root, "vault") };
  await mkdir(location.runtimeRoot);
  await writeFile(join(location.runtimeRoot, "config.toml"), "schema_version = 1\n");
  for (const memory of [releaseTrain, ...noise]) await writeCanonicalMemory({ ...location, actor: "human", memory });
  await buildRetrievalIndex({ ...location, adapter, builtAt: "2026-11-19T12:00:00.000Z" });
  return location;
}

const reply = "I can merge the fix today.\n\nI propose we wait for the release train instead of merging now.";
const view = (messages: ConversationView["messages"]): ConversationView => ({ messages, status: "available" });
const answered = view([
  { role: "user", text: "Can the fix go in today?", truncated: false },
  { role: "assistant", text: reply, truncated: false }
]);

async function poolFor(location: { runtimeRoot: string; vaultRoot: string }, sessionId: string, prompt: string, conversation?: ConversationView) {
  const pools: string[][] = [];
  const judge: AutomaticRelevanceFilter = { filter: request => {
    pools.push(request.items.map(item => item.memoryId));
    return Promise.resolve({ telemetry: { state: "filtered", model: "jev-1.13.0", threshold: 0.45, elapsedMs: 1 },
      scores: request.items.map(item => ({ memoryId: item.memoryId, score: item.memoryId === releaseTrain.memoryId ? 0.9 : 0.1 })) });
  } };
  const pack = await prepareUserPromptShadowPack({ ...location, projectId, sessionId, prompt, adapter, relevanceFilter: judge,
    jevCandidateLimit: 3, signals: { files: [], symbols: [], errors: [], commands: [] }, requestedAt: "2026-11-19T12:01:00.000Z",
    ...(conversation === undefined ? {} : { conversation }) });
  const receipt = await inspectRetrievalReceipt(location.runtimeRoot, pack.receiptId);
  return { pool: pools[0] ?? [], injected: pack.items.map(item => item.memoryId), timings: receipt?.timings };
}

test("a short prompt's Jev pool takes in what the previous reply was about", async () => {
  const location = await fixture();
  const without = await poolFor(location, "no-context", "ok, do that then");
  expect(without.pool).not.toContain(releaseTrain.memoryId);

  const withReply = await poolFor(location, "with-reply", "ok, do that then", answered);
  expect(withReply.pool).toContain(releaseTrain.memoryId);
  expect(withReply.injected).toEqual([releaseTrain.memoryId]);
  expect(withReply.timings?.assistantContext?.state).toBe("used");
  expect(without.timings?.assistantContext).toBeUndefined();
});

test("a long prompt or a history ending in a user message adds no reply ranking", async () => {
  const location = await fixture();
  const long = `ok, do that then; ${"also keep the status page muted and readable for everyone ".repeat(4)}`;
  expect(Array.from(long).length).toBeGreaterThan(160);
  expect((await poolFor(location, "long", long, answered)).pool).not.toContain(releaseTrain.memoryId);

  const unanswered = view([...answered.messages, { role: "user", text: "Wait, check the palette first.", truncated: false }]);
  expect((await poolFor(location, "unanswered", "ok, do that then", unanswered)).pool).not.toContain(releaseTrain.memoryId);
});
