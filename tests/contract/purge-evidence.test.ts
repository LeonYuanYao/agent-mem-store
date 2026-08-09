import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";

test("Outcome 12 evidence maps destructive claims and proves real external targets stayed unchanged", async () => {
  const root = join(import.meta.dirname, "..", "..");
  const document = JSON.parse(await readFile(
    join(root, "artifacts", "evidence", "purge.json"),
    "utf8"
  )) as {
    milestone?: unknown;
    repository?: { sourceManifest?: readonly { path?: unknown; sha256?: unknown }[] };
    claimToEvidence?: readonly { claim?: unknown; evidence?: readonly unknown[] }[];
    destructiveBoundary?: {
      realVaultWritten?: unknown;
      externalTargetsUnchanged?: unknown;
      defaultLimits?: unknown;
      safetyMaxima?: unknown;
      backupRequired?: unknown;
    };
    unresolvedLimitations?: readonly { id?: unknown }[];
  };
  expect(document.milestone).toBe("outcome12_archive_purge");
  const sourcePaths = new Set(
    document.repository?.sourceManifest?.map((entry) => entry.path) ?? []
  );
  for (const path of [
    "src/purge/index.ts",
    "migrations/0014-archive-purge.sql",
    "tests/destructive/purge/ordinary-purge.test.ts",
    "tests/destructive/purge/crash-recovery.test.ts",
    "tests/contract/purge-evidence.test.ts"
  ]) {
    expect(sourcePaths.has(path)).toBe(true);
  }
  for (const entry of document.repository?.sourceManifest ?? []) {
    expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/u);
  }
  const claims = new Set(document.claimToEvidence?.map((entry) => entry.claim));
  for (const claim of [
    "strict_preview_and_backup_gate",
    "authority_retention_and_restore_protection",
    "checkpointed_idempotent_crash_recovery",
    "bounded_yielding_and_catch_up",
    "body_revision_index_and_catalog_agreement"
  ]) {
    expect(claims.has(claim)).toBe(true);
  }
  for (const claim of document.claimToEvidence ?? []) {
    for (const path of claim.evidence ?? []) expect(sourcePaths.has(path)).toBe(true);
  }
  expect(document.destructiveBoundary).toMatchObject({
    realVaultWritten: false,
    externalTargetsUnchanged: true,
    backupRequired: true,
    defaultLimits: { bodies: 25, bytes: 16_777_216, destructiveMilliseconds: 10_000 },
    safetyMaxima: { bodies: 200, bytes: 134_217_728, destructiveMilliseconds: 60_000 }
  });
  const limitations = new Set(document.unresolvedLimitations?.map((item) => item.id));
  expect(limitations.has("real_vault_purge_not_executed")).toBe(true);
  expect(limitations.has("managed_scheduler_not_installed")).toBe(true);
});
