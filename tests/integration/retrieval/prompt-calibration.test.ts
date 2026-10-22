import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { buildRetrievalIndex, type EmbeddingAdapter } from "../../../src/retrieval/index.js";
import { inspectUserPromptScoring, prepareUserPromptShadowPack } from "../../../src/retrieval/packs.js";
import type { AutomaticRelevanceFilter } from "../../../src/retrieval/jev.js";
import { writeCanonicalMemory } from "../../../src/vault/index.js";
import { makeCanonicalMemory } from "../../helpers/canonical-memory.js";

// ADR-0152: prompt similarity is judged against the prompt's own median similarity
// to the Memories in scope, and without Jev's judgment only near-certain items go in.
const projectId = "msproj_123e4567-e89b-42d3-a456-426614176000";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

// Every Memory is at least 0.90 similar to the prompt, as with multilingual-e5;
// only the checklist stands out from the median (0.90).
const adapter: EmbeddingAdapter = {
  identity: { adapterVersion: "calibration-fixture-v1", modelIdentity: "calibration-fixture", artifactSha256: "c".repeat(64),
    dimensions: 2, normalization: "l2" },
  embed: (texts) => Promise.resolve(texts.map(text =>
    /checklist/u.test(text) ? [1, 0] : /notes/u.test(text) ? [0.92, 0.3919183588] : [0.9, 0.4358898944])),
  // Prompts about deploying point at the checklist; others look like the palette notes.
  embedQuery: (texts) => Promise.resolve(texts.map(text => /deploy/u.test(text) ? [1, 0] : [0.9, 0.4358898944]))
};
const target = makeCanonicalMemory({
  memoryId: "msmem_123e4567-e89b-42d3-a456-426614176001", revisionId: "msrev_123e4567-e89b-42d3-a456-426614176101",
  scope: { kind: "project", projectId }, body: "Deploy preview checklist: run the smoke suite first.",
  compact: "Deploy preview checklist: run the smoke suite first.", startup: "never"
});
// Two shared terms and a small lift: admitted locally, not near-certain.
const probable = makeCanonicalMemory({
  memoryId: "msmem_123e4567-e89b-42d3-a456-426614176002", revisionId: "msrev_123e4567-e89b-42d3-a456-426614176102",
  scope: { kind: "project", projectId }, body: "Preview status notes are kept in the release channel.",
  compact: "Preview status notes are kept in the release channel.", startup: "never"
});
// One shared word each: not corroboration.
const noise = Array.from({ length: 9 }, (_, index) => makeCanonicalMemory({
  memoryId: `msmem_123e4567-e89b-42d3-a456-4266141762${String(index).padStart(2, "0")}`,
  revisionId: `msrev_123e4567-e89b-42d3-a456-4266141763${String(index).padStart(2, "0")}`,
  scope: { kind: "project", projectId }, body: `Status page palette ${String(index)} uses muted colours.`,
  compact: `Status page palette ${String(index)} uses muted colours.`, startup: "never"
}));

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "memstore-prompt-calibration-"));
  roots.push(root);
  const location = { runtimeRoot: join(root, "runtime"), vaultRoot: join(root, "vault") };
  await mkdir(location.runtimeRoot);
  await writeFile(join(location.runtimeRoot, "config.toml"), "schema_version = 1\n");
  for (const memory of [target, probable, ...noise]) await writeCanonicalMemory({ ...location, actor: "human", memory });
  await buildRetrievalIndex({ ...location, adapter, builtAt: "2026-10-22T12:00:00.000Z" });
  return location;
}

const prompt = "deploy preview status today quickly";
function ask(location: { runtimeRoot: string; vaultRoot: string }, sessionId: string, relevanceFilter?: AutomaticRelevanceFilter) {
  return prepareUserPromptShadowPack({ ...location, projectId, sessionId, prompt, adapter,
    signals: { files: [], symbols: [], errors: [], commands: [] }, requestedAt: "2026-10-22T12:01:00.000Z",
    ...(relevanceFilter === undefined ? {} : { relevanceFilter }) });
}
const jevFallback = (reason: "timeout" | "configuration_unavailable"): AutomaticRelevanceFilter => ({
  filter: () => Promise.resolve({ telemetry: { state: "fallback", model: "jev-1.13.0", threshold: 0.5, elapsedMs: 1, reason } })
});

test("high absolute similarity alone admits nothing; standing out from the prompt's median does", async () => {
  const location = await fixture();
  const scoring = await inspectUserPromptScoring({ ...location, projectId, prompt, adapter, requestedAt: "2026-10-22T12:01:00.000Z" });
  const byId = new Map(scoring.items.map(item => [item.memoryId, item]));
  expect(byId.get(target.memoryId)).toMatchObject({ band: "high" });
  expect(byId.get(target.memoryId)?.features.semanticLift).toBeCloseTo(0.1, 5);
  expect(byId.get(probable.memoryId)?.band).not.toBe("weak");
  expect(byId.get(probable.memoryId)?.features.semanticLift).toBeCloseTo(0.02, 5);
  for (const memory of noise) expect(byId.get(memory.memoryId)?.band ?? "weak").toBe("weak");

  const pack = await ask(location, "local-only");
  expect(pack.items.map(item => item.memoryId)).toEqual([target.memoryId, probable.memoryId]);
});

test("when Jev is enabled but gives no judgment, only near-certain items are injected", async () => {
  const location = await fixture();
  const timedOut = await ask(location, "jev-timeout", jevFallback("timeout"));
  expect(timedOut.items.map(item => item.memoryId)).toEqual([target.memoryId]);

  // Jev disabled or unconfigured: the local selection stands.
  const unconfigured = await ask(location, "jev-unconfigured", jevFallback("configuration_unavailable"));
  expect(unconfigured.items.map(item => item.memoryId)).toEqual([target.memoryId, probable.memoryId]);

  const judged = await ask(location, "jev-filtered", { filter: request => Promise.resolve({
    telemetry: { state: "filtered", model: "jev-1.13.0", threshold: 0.5, elapsedMs: 1 },
    scores: request.items.map(item => ({ memoryId: item.memoryId, score: 0.9 }))
  }) });
  expect(judged.items.map(item => item.memoryId)).toEqual([target.memoryId, probable.memoryId]);
});

test("nothing standing out under a Jev failure leaves the pack empty with its reason", async () => {
  const location = await fixture();
  const pack = await prepareUserPromptShadowPack({ ...location, projectId, sessionId: "jev-timeout-probable-only",
    prompt: "preview status today quickly", adapter, relevanceFilter: jevFallback("timeout"),
    signals: { files: [], symbols: [], errors: [], commands: [] }, requestedAt: "2026-10-22T12:02:00.000Z" });
  expect(pack.items).toHaveLength(0);
  expect(pack.emptyReason).toBe("unfiltered_low_confidence");
});
