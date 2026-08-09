import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";

test("Gate 5 evidence freezes one candidate and maps every Full-Cutover prerequisite", async () => {
  const root = join(import.meta.dirname, "..", "..");
  const document = JSON.parse(await readFile(
    join(root, "artifacts", "evidence", "gate5.json"),
    "utf8"
  )) as {
    gate?: unknown;
    repository?: { sourceManifest?: readonly { path?: unknown; sha256?: unknown }[] };
    claimToEvidence?: readonly { claim?: unknown; evidence?: readonly unknown[] }[];
    frozenCandidate?: {
      candidateId?: unknown;
      sha256?: unknown;
      automaticInjection?: unknown;
      nativeMemory?: unknown;
    };
    managedExercise?: {
      previewMutationFree?: unknown;
      unrelatedStatePreserved?: unknown;
      uninstallRestoredExactConfiguration?: unknown;
      cutoverRollbackRestoredExactConfiguration?: unknown;
      nativeBodiesRead?: unknown;
      workerAdaptersConfigured?: unknown;
    };
    machineBoundary?: {
      externalTargetsUnchanged?: unknown;
      realInstallationApplied?: unknown;
      officialShadowStarted?: unknown;
    };
  };
  expect(document.gate).toBe(5);
  const paths = new Set(document.repository?.sourceManifest?.map((entry) => entry.path));
  for (const path of [
    "config/gate5-shadow-v1.json",
    "src/repair/index.ts",
    "src/integration/managed.ts",
    "skills/memstore-repair/SKILL.md",
    "tests/e2e/repair/synthetic-irrelevant.test.ts",
    "tests/integration/managed-install/preservation.test.ts",
    "tests/fault/managed-install/divergence.test.ts",
    "tests/contract/codex-hook.test.ts",
    "tests/integration/retrieval/shadow-worker.test.ts",
    "tests/integration/operations/shadow-window.test.ts",
    "tests/contract/gate5-evidence.test.ts"
  ]) expect(paths.has(path)).toBe(true);
  for (const entry of document.repository?.sourceManifest ?? []) {
    expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/u);
  }
  const claims = new Set(document.claimToEvidence?.map((entry) => entry.claim));
  for (const claim of [
    "archive_purge_prerequisite",
    "reviewed_foreground_repair_loop",
    "managed_install_repair_uninstall",
    "cutover_and_rollback_rehearsal",
    "frozen_candidate_configuration",
    "official_hook_and_shadow_runtime"
  ]) expect(claims.has(claim)).toBe(true);
  expect(document.frozenCandidate).toMatchObject({
    candidateId: "gate5-shadow-v1",
    automaticInjection: false,
    nativeMemory: { generateMemories: "preserve", useMemories: "preserve", import: false, delete: false }
  });
  expect(document.frozenCandidate?.sha256).toMatch(/^[0-9a-f]{64}$/u);
  expect(document.managedExercise).toMatchObject({
    previewMutationFree: true,
    unrelatedStatePreserved: true,
    uninstallRestoredExactConfiguration: true,
    cutoverRollbackRestoredExactConfiguration: true,
    nativeBodiesRead: 0,
    workerAdaptersConfigured: true
  });
  expect(document.machineBoundary).toMatchObject({
    externalTargetsUnchanged: true,
    realInstallationApplied: false,
    officialShadowStarted: false
  });
});
