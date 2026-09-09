import { access, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { stringify } from "smol-toml";

import { writeFileAtomically } from "../contracts/atomic-file.js";
import {
  loadConfiguration,
  rememberLastKnownGoodConfiguration
} from "../configuration/index.js";
import { initializeGovernanceSchedule } from "../governance/scheduling.js";
import { openRuntimeDatabase } from "../runtime/database.js";
import { backfillPortableMemoryRefs } from "../vault/index.js";

const DEFAULT_GOVERNANCE_TIME_ZONE = "Asia/Shanghai";

export interface InitializationRequest {
  readonly vaultRoot: string;
  readonly runtimeRoot: string;
  readonly preview: boolean;
}

export interface InitializationPreview {
  readonly schemaVersion: 1;
  readonly dryRun: true;
  readonly state: "preview";
  readonly vaultRoot: string;
  readonly runtimeRoot: string;
  readonly wouldCreate: readonly string[];
}

export interface InitializationComplete {
  readonly schemaVersion: 1;
  readonly dryRun: false;
  readonly state: "initialized" | "existing";
  readonly vaultRoot: string;
  readonly runtimeRoot: string;
  readonly created: readonly string[];
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function initializeMemStore(
  request: InitializationRequest
): Promise<InitializationPreview | InitializationComplete> {
  const vaultRoot = resolve(request.vaultRoot);
  const runtimeRoot = resolve(request.runtimeRoot);

  const policyPath = join(vaultRoot, "_MemStore", "policy.toml");
  const configPath = join(runtimeRoot, "config.toml");
  const databasePath = join(runtimeRoot, "state", "memstore.sqlite");

  if (request.preview) {
    return {
      schemaVersion: 1,
      dryRun: true,
      state: "preview",
      vaultRoot,
      runtimeRoot,
      wouldCreate: [policyPath, configPath, databasePath]
    };
  }

  const [policyExists, configExists] = await Promise.all([
    pathExists(policyPath),
    pathExists(configPath)
  ]);
  if (policyExists && configExists) {
    const existing = await loadConfiguration({ vaultRoot, runtimeRoot });
    if (existing.mode !== "read_write") {
      throw new Error("Existing configuration is not writable by this version.");
    }
    const database = await openRuntimeDatabase(runtimeRoot, {
      applyPendingMigrations: true
    });
    database.close();
    await backfillPortableMemoryRefs({ vaultRoot, runtimeRoot });
    await initializeGovernanceSchedule({
      runtimeRoot,
      timeZone: existing.policy.governanceTimezone,
      registeredAt: new Date().toISOString(),
      startupDelaySeconds: 600,
      pageSize: 50
    });
    return {
      schemaVersion: 1,
      dryRun: false,
      state: "existing",
      vaultRoot,
      runtimeRoot,
      created: []
    };
  }
  if (policyExists || configExists) {
    throw new Error("Partial initialization exists; refusing to overwrite it.");
  }

  await mkdir(join(vaultRoot, "_MemStore"), { recursive: true, mode: 0o700 });
  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });

  const timezone = DEFAULT_GOVERNANCE_TIME_ZONE;
  const policy = stringify({
    schema_version: 1,
    retention: {
      archive_months: 3,
      candidate_tombstone_days: 180,
      sensitivity_metadata_days: 15,
      injection_receipt_days: 30
    },
    lifecycle: {},
    promotion: {},
    capacity: {
      project: { target: 2_500, hard_limit: 3_500, low_water: 2_200 },
      global: { target: 300, hard_limit: 500, low_water: 270 },
      cold_days: 7,
      governance_batch_size: 50
    },
    injection: {},
    governance: {
      timezone,
      weekly: "MONDAY 19:00",
      monthly: "FIRST_MONDAY 19:00"
    },
    review: {},
    anomalies: {},
    luna_health: {}
  });
  const machine = stringify({
    schema_version: 1,
    paths: {
      vault_root: vaultRoot,
      runtime_root: runtimeRoot
    },
    projects: {},
    git_cache: {},
    adapters: { hook_display: "summary", session_start_injection: false },
    embedding: {},
    luna: {},
    notifier: {},
    launch_agent: {}
  });

  await writeFileAtomically(policyPath, policy, 0o600);
  await writeFileAtomically(configPath, machine, 0o600);
  const database = await openRuntimeDatabase(runtimeRoot, {
    applyPendingMigrations: true
  });
  database.close();
  await backfillPortableMemoryRefs({ vaultRoot, runtimeRoot });
  await initializeGovernanceSchedule({
    runtimeRoot,
    timeZone: timezone,
    registeredAt: new Date().toISOString(),
    startupDelaySeconds: 600,
    pageSize: 50
  });
  await rememberLastKnownGoodConfiguration({ vaultRoot, runtimeRoot });

  return {
    schemaVersion: 1,
    dryRun: false,
    state: "initialized",
    vaultRoot,
    runtimeRoot,
    created: [policyPath, configPath, databasePath]
  };
}
