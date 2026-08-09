import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";

test("Gate 4 evidence maps the Engineering MVP and previews only owned machine effects", async () => {
  const repositoryRoot = join(import.meta.dirname, "..", "..");
  const evidence = JSON.parse(await readFile(
    join(repositoryRoot, "artifacts", "evidence", "gate4.json"),
    "utf8"
  )) as unknown;
  const document = evidence as {
    gate?: unknown;
    repository?: { sourceManifest?: readonly { path?: unknown; sha256?: unknown }[] };
    claimToEvidence?: readonly { claim?: unknown; evidence?: readonly unknown[] }[];
    machineEffectPreview?: {
      automaticInjection?: unknown;
      codexNativeMemoryChange?: unknown;
      effects?: readonly { target?: unknown; operation?: unknown; ownership?: unknown }[];
    };
    unresolvedLimitations?: readonly { id?: unknown }[];
  };

  expect(document.gate).toBe(4);
  const sourcePaths = new Set(
    document.repository?.sourceManifest?.map((entry) => entry.path) ?? []
  );
  expect(sourcePaths.has("tests/e2e/gate4-shadow-loop.test.ts")).toBe(true);
  expect(sourcePaths.has("tests/contract/gate4-evidence.test.ts")).toBe(true);
  for (const entry of document.repository?.sourceManifest ?? []) {
    expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/u);
  }

  const claims = new Set(document.claimToEvidence?.map((entry) => entry.claim));
  for (const claim of [
    "complete_uninstalled_shadow_loop",
    "failure_exercises",
    "automatic_injection_disabled",
    "portable_recovery_without_runtime_import"
  ]) {
    expect(claims.has(claim)).toBe(true);
  }
  for (const claim of document.claimToEvidence ?? []) {
    for (const evidencePath of claim.evidence ?? []) {
      expect(sourcePaths.has(evidencePath)).toBe(true);
    }
  }

  expect(document.machineEffectPreview?.automaticInjection).toBe("disabled");
  expect(document.machineEffectPreview?.codexNativeMemoryChange).toBe("none");
  expect(document.machineEffectPreview?.effects?.length).toBeGreaterThan(0);
  expect(document.machineEffectPreview?.effects?.every((effect) =>
    typeof effect.target === "string" &&
    typeof effect.operation === "string" &&
    effect.ownership === "memstore_owned"
  )).toBe(true);
  const limitations = new Set(document.unresolvedLimitations?.map((entry) => entry.id));
  for (const limitation of [
    "archive_purge_not_executable",
    "bad_case_repair_not_implemented",
    "native_notification_manual_proof_pending"
  ]) {
    expect(limitations.has(limitation)).toBe(true);
  }
});
