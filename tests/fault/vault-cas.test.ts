import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, test } from "vitest";

import { writeFileAtomically } from "../../src/contracts/atomic-file.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

test("an atomic CAS write preserves a concurrently changed target", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-vault-cas-"));
  temporaryDirectories.push(root);
  const target = join(root, "memory.md");
  const original = "original\n";
  await writeFile(target, original, "utf8");
  const originalIdentity = createHash("sha256").update(original).digest("hex");
  await writeFile(target, "human edit\n", "utf8");

  await expect(
    writeFileAtomically(target, "agent edit\n", 0o600, originalIdentity)
  ).rejects.toThrow("precondition");
  expect(await readFile(target, "utf8")).toBe("human edit\n");
});
