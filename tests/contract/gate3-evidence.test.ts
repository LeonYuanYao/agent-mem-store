import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";

test("Gate 3 evidence identifies every repository source and maps material claims", async () => {
  const repositoryRoot = join(import.meta.dirname, "..", "..");
  const evidence = JSON.parse(
    await readFile(
      join(repositoryRoot, "artifacts", "evidence", "gate3.json"),
      "utf8"
    )
  ) as unknown;
  if (typeof evidence !== "object" || evidence === null) {
    throw new Error("Gate 3 evidence must be an object.");
  }
  const document = evidence as {
    repository?: {
      sourceManifest?: readonly { path?: unknown; sha256?: unknown }[];
      trackedDiffSha256?: unknown;
    };
    claimToEvidence?: unknown;
    knownRisks?: unknown;
  };

  expect(document.repository?.sourceManifest).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: "src/vault/index.ts" }),
      expect.objectContaining({ path: "tests/contract/gate3-evidence.test.ts" })
    ])
  );
  expect(document.repository?.trackedDiffSha256).toMatch(/^[0-9a-f]{64}$/u);
  expect(document.claimToEvidence).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ claim: "human_authority_preserved" }),
      expect.objectContaining({ claim: "program_data_separated" })
    ])
  );
  expect(document.knownRisks).toEqual(expect.any(Array));

  const sourcePaths = new Set(
    document.repository?.sourceManifest?.map((entry) => entry.path) ?? []
  );
  const claims = document.claimToEvidence as
    | readonly { claim?: unknown; evidence?: readonly unknown[] }[]
    | undefined;
  for (const claim of claims ?? []) {
    expect(claim.claim).toEqual(expect.any(String));
    for (const evidencePath of claim.evidence ?? []) {
      expect(sourcePaths.has(evidencePath)).toBe(true);
    }
  }
  for (const entry of document.repository?.sourceManifest ?? []) {
    expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/u);
  }
});
