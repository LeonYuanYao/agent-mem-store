import {
  access,
  appendFile,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test } from "vitest";

import { initializeMemStore } from "../../src/operations/initialize.js";
import {
  activateConfigurationDocument,
  loadConfiguration
} from "../../src/configuration/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

async function doesNotExist(path: string): Promise<boolean> {
  try {
    await access(path);
    return false;
  } catch {
    return true;
  }
}

test("initialization preview reports its plan without creating state", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-init-preview-"));
  temporaryDirectories.push(root);
  const vaultRoot = join(root, "vault");
  const runtimeRoot = join(root, "runtime");

  const result = await initializeMemStore({
    vaultRoot,
    runtimeRoot,
    preview: true
  });

  expect(result).toEqual({
    schemaVersion: 1,
    dryRun: true,
    state: "preview",
    vaultRoot,
    runtimeRoot,
    wouldCreate: [
      join(vaultRoot, "_MemStore", "policy.toml"),
      join(runtimeRoot, "config.toml"),
      join(runtimeRoot, "state", "memstore.sqlite")
    ]
  });
  expect(await doesNotExist(vaultRoot)).toBe(true);
  expect(await doesNotExist(runtimeRoot)).toBe(true);
});

test("initialization creates separate portable and machine configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-init-"));
  temporaryDirectories.push(root);
  const vaultRoot = join(root, "vault");
  const runtimeRoot = join(root, "runtime");

  const result = await initializeMemStore({
    vaultRoot,
    runtimeRoot,
    preview: false
  });
  const configuration = await loadConfiguration({ vaultRoot, runtimeRoot });
  const [policySource, machineSource] = await Promise.all([
    readFile(join(vaultRoot, "_MemStore", "policy.toml"), "utf8"),
    readFile(join(runtimeRoot, "config.toml"), "utf8")
  ]);
  expect(machineSource).toContain("subagents_enabled = false");

  expect(result).toEqual({
    schemaVersion: 1,
    dryRun: false,
    state: "initialized",
    vaultRoot,
    runtimeRoot,
    created: [
      join(vaultRoot, "_MemStore", "policy.toml"),
      join(runtimeRoot, "config.toml"),
      join(runtimeRoot, "state", "memstore.sqlite")
    ]
  });
  expect(configuration).toMatchObject({
    schemaVersion: 1,
    mode: "read_write",
    policy: {
      archiveRetentionMonths: 3,
      candidateTombstoneDays: 180,
      sensitivityMetadataDays: 15,
      injectionReceiptDays: 30,
      governanceTimezone: "Asia/Shanghai",
      weeklyGovernance: "EVERY_3_DAYS 19:00",
      monthlyGovernance: "MONDAY 19:00",
      memoryCapacity: {
        project: { target: 2_500, hardLimit: 3_500, lowWater: 2_200 },
        global: { target: 300, hardLimit: 500, lowWater: 270 },
        coldDays: 7,
        governanceBatchSize: 50
      }
    },
    machine: { vaultRoot, runtimeRoot }
  });
  expect((await stat(runtimeRoot)).mode & 0o777).toBe(0o700);
  expect((await stat(join(runtimeRoot, "config.toml"))).mode & 0o777).toBe(0o600);
  expect((await stat(join(runtimeRoot, "state", "memstore.sqlite"))).isFile()).toBe(
    true
  );
  expect(policySource).toContain("injection_receipt_days = 30");
  const database = new DatabaseSync(join(runtimeRoot, "state", "memstore.sqlite"), {
    readOnly: true
  });
  try {
    const schedule = database.prepare(
      "SELECT time_zone, startup_delay_seconds, page_size FROM governance_schedule WHERE singleton = 1"
    ).get();
    expect(schedule).toMatchObject({
      time_zone: "Asia/Shanghai",
      startup_delay_seconds: 600,
      page_size: 50
    });
  } finally {
    database.close();
  }
  for (const section of [
    "lifecycle",
    "promotion",
    "capacity",
    "injection",
    "review",
    "anomalies",
    "luna_health"
  ]) {
    expect(policySource).toContain(`[${section}]`);
  }
  for (const section of [
    "projects",
    "git_cache",
    "adapters",
    "embedding",
    "luna",
    "notifier",
    "launch_agent"
  ]) {
    expect(machineSource).toContain(`[${section}]`);
  }
});

test("a higher configuration schema forces bounded read-only status", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-init-newer-schema-"));
  temporaryDirectories.push(root);
  const vaultRoot = join(root, "vault");
  const runtimeRoot = join(root, "runtime");
  await initializeMemStore({ vaultRoot, runtimeRoot, preview: false });
  await writeFile(
    join(vaultRoot, "_MemStore", "policy.toml"),
    "schema_version = 2\n[paths]\nfuture_location = \"owned-by-v2\"\n",
    "utf8"
  );

  const configuration = await loadConfiguration({ vaultRoot, runtimeRoot });

  expect(configuration).toEqual({
    schemaVersion: 2,
    mode: "read_only",
    diagnostic: {
      code: "unsupported_schema_version",
      document: "policy",
      found: 2,
      supported: 1
    }
  });
});

test("initialization is idempotent and preserves manually added policy fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-init-existing-"));
  temporaryDirectories.push(root);
  const vaultRoot = join(root, "vault");
  const runtimeRoot = join(root, "runtime");
  const policyPath = join(vaultRoot, "_MemStore", "policy.toml");
  await initializeMemStore({ vaultRoot, runtimeRoot, preview: false });
  await appendFile(policyPath, '\nuser_note = "keep me"\n', "utf8");

  const result = await initializeMemStore({ vaultRoot, runtimeRoot, preview: false });

  expect(result).toEqual({
    schemaVersion: 1,
    dryRun: false,
    state: "existing",
    vaultRoot,
    runtimeRoot,
    created: []
  });
  expect(await readFile(policyPath, "utf8")).toContain('user_note = "keep me"');
});

test("configuration activation rejects invalid content and keeps one prior valid version", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-config-activation-"));
  temporaryDirectories.push(root);
  const vaultRoot = join(root, "vault");
  const runtimeRoot = join(root, "runtime");
  const policyPath = join(vaultRoot, "_MemStore", "policy.toml");
  await initializeMemStore({ vaultRoot, runtimeRoot, preview: false });
  const original = await readFile(policyPath, "utf8");

  const rejected = await activateConfigurationDocument({
    vaultRoot,
    runtimeRoot,
    document: "policy",
    source: "schema_version = 1\n",
    preview: false
  });
  const validSource = original.replace("archive_months = 3", "archive_months = 9");
  const activated = await activateConfigurationDocument({
    vaultRoot,
    runtimeRoot,
    document: "policy",
    source: validSource,
    preview: false
  });

  expect(rejected).toEqual({
    state: "rejected",
    document: "policy",
    changed: false,
    diagnostic: { code: "invalid_configuration" }
  });
  expect(activated).toEqual({
    state: "activated",
    document: "policy",
    changed: true,
    backupPath: `${policyPath}.previous`
  });
  expect(await readFile(`${policyPath}.previous`, "utf8")).toBe(original);
  const loaded = await loadConfiguration({ vaultRoot, runtimeRoot });
  expect(loaded.mode).toBe("read_write");
  if (loaded.mode === "read_write") {
    expect(loaded.policy).toMatchObject({ archiveRetentionMonths: 9 });
  }
});

test("portable and machine configuration reject keys owned by the other document", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-config-ownership-"));
  temporaryDirectories.push(root);
  const vaultRoot = join(root, "vault");
  const runtimeRoot = join(root, "runtime");
  await initializeMemStore({ vaultRoot, runtimeRoot, preview: false });
  const policyPath = join(vaultRoot, "_MemStore", "policy.toml");
  const policySource = await readFile(policyPath, "utf8");

  const result = await activateConfigurationDocument({
    vaultRoot,
    runtimeRoot,
    document: "policy",
    source: `${policySource}\n[paths]\nvault_root = "/wrong-owner"\n`,
    preview: false
  });

  expect(result).toMatchObject({
    state: "rejected",
    diagnostic: { code: "invalid_configuration" }
  });
  expect(await readFile(policyPath, "utf8")).toBe(policySource);
});

test("portable and machine configuration cannot claim the same future top-level key", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-config-future-overlap-"));
  temporaryDirectories.push(root);
  const vaultRoot = join(root, "vault");
  const runtimeRoot = join(root, "runtime");
  await initializeMemStore({ vaultRoot, runtimeRoot, preview: false });
  const policyPath = join(vaultRoot, "_MemStore", "policy.toml");
  const machinePath = join(runtimeRoot, "config.toml");
  const policySource = `${await readFile(policyPath, "utf8")}\n[future_shared]\nvalue = 1\n`;
  const machineSource = `${await readFile(machinePath, "utf8")}\n[future_shared]\nvalue = 2\n`;
  const policyResult = await activateConfigurationDocument({
    vaultRoot,
    runtimeRoot,
    document: "policy",
    source: policySource,
    preview: false
  });
  const machineBefore = await readFile(machinePath, "utf8");

  const machineResult = await activateConfigurationDocument({
    vaultRoot,
    runtimeRoot,
    document: "machine",
    source: machineSource,
    preview: false
  });

  expect(policyResult.state).toBe("activated");
  expect(machineResult).toMatchObject({
    state: "rejected",
    diagnostic: { code: "invalid_configuration" }
  });
  expect(await readFile(machinePath, "utf8")).toBe(machineBefore);
});

test("an invalid manual edit falls back to the last known good configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-config-recovery-"));
  temporaryDirectories.push(root);
  const vaultRoot = join(root, "vault");
  const runtimeRoot = join(root, "runtime");
  const policyPath = join(vaultRoot, "_MemStore", "policy.toml");
  await initializeMemStore({ vaultRoot, runtimeRoot, preview: false });
  const original = await readFile(policyPath, "utf8");
  const validSource = original.replace("archive_months = 3", "archive_months = 9");
  await activateConfigurationDocument({
    vaultRoot,
    runtimeRoot,
    document: "policy",
    source: validSource,
    preview: false
  });
  await writeFile(policyPath, "this is not valid TOML = [", "utf8");

  const loaded = await loadConfiguration({ vaultRoot, runtimeRoot });

  expect(loaded).toMatchObject({
    schemaVersion: 1,
    mode: "read_write",
    policy: { archiveRetentionMonths: 9 },
    recovery: {
      code: "last_known_good",
      documents: ["policy"]
    }
  });
  expect(await readFile(policyPath, "utf8")).toBe("this is not valid TOML = [");
});
