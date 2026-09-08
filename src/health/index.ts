import { inspectRetrievalCatalogGeneration } from "../retrieval/index-coordinator.js";
import { inspectIndexWait, indexCooldownMilliseconds } from "../retrieval/index-wait.js";
import { inspectBackgroundRecovery } from "../worker/recovery-policy.js";

export async function inspectIndexHealth(runtimeRoot: string, now: string) {
  const [generation, wait, recovery] = await Promise.all([
    inspectRetrievalCatalogGeneration(runtimeRoot), inspectIndexWait(runtimeRoot, now), inspectBackgroundRecovery(runtimeRoot)
  ]);
  const dirty = generation.dirtyGeneration > generation.publishedGeneration;
  const dirtySince = generation.forceDueAt === null ? generation.dirtyAt :
    new Date(Date.parse(generation.forceDueAt) - generation.maximumStalenessMilliseconds).toISOString();
  const recoveryUntil = recovery.active && dirtySince !== null
    ? new Date(Date.parse(dirtySince) + 30 * 60_000).toISOString() : null;
  const retryUntil = generation.lastFailedAt === null ? null :
    new Date(Date.parse(generation.lastFailedAt) + indexCooldownMilliseconds).toISOString();
  const expectedAt = !dirty ? null : [generation.forceDueAt, wait.until, recoveryUntil, retryUntil]
    .filter((value): value is string => value !== null).sort().at(-1) ?? null;
  const overdue = dirty && expectedAt !== null && Date.parse(now) > Date.parse(expectedAt) + 60_000;
  const state = !dirty ? "current" : overdue ? "stalled" :
    wait.waiting ? wait.reason : recovery.active ? "recovery coalescing" : "syncing";
  return { state, expectedAt, generation,
    severity: overdue ? "warning" as const : dirty ? "info" as const : "ok" as const,
    recoveryCondition: "Publish the dirty catalog generation; scheduled waiting has a fixed deadline plus 60 seconds of scheduling grace."
  };
}
