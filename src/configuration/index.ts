import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse } from "smol-toml";
import { z } from "zod";

import { writeFileAtomically } from "../contracts/atomic-file.js";
import { classifyLocalSensitivity } from "../contracts/sensitivity.js";
import { adapterDisplaySchema } from "./hook-display.js";
import { corpusRetentionConfigurationSchema, type CorpusRetentionConfiguration } from "./corpus-retention.js";

const extensibleSectionSchema = z.record(z.string(), z.unknown()).default({});
const policyOwnedKeys = [
  "retention",
  "lifecycle",
  "promotion",
  "capacity",
  "corpus_retention",
  "injection",
  "governance",
  "review",
  "anomalies",
  "luna_health"
] as const;
const machineOwnedKeys = [
  "paths",
  "projects",
  "git_cache",
  "adapters",
  "embedding",
  "jev",
  "luna",
  "notifier",
  "launch_agent"
] as const;

const memorySpaceCapacitySchema = z.object({
  target: z.number().int().positive(),
  hard_limit: z.number().int().positive(),
  low_water: z.number().int().nonnegative()
}).refine(
  (capacity) => capacity.low_water < capacity.target && capacity.target < capacity.hard_limit,
  { message: "Memory capacity must satisfy low_water < target < hard_limit." }
);

const memoryCapacitySchema = z.object({
  project: memorySpaceCapacitySchema.default({
    target: 2_500,
    hard_limit: 3_500,
    low_water: 2_200
  }),
  global: memorySpaceCapacitySchema.default({
    target: 300,
    hard_limit: 500,
    low_water: 270
  }),
  cold_days: z.number().int().positive().default(7),
  governance_batch_size: z.number().int().min(1).max(50).default(50)
}).default({
  project: { target: 2_500, hard_limit: 3_500, low_water: 2_200 },
  global: { target: 300, hard_limit: 500, low_water: 270 },
  cold_days: 7,
  governance_batch_size: 50
});

const policySchema = z.object({
  schema_version: z.literal(1),
  retention: z.object({
    archive_months: z.number().int().positive(),
    candidate_tombstone_days: z.number().int().positive().default(180),
    sensitivity_metadata_days: z.number().int().positive().default(15),
    injection_receipt_days: z.number().int().min(1).max(3650).default(30)
  }),
  lifecycle: extensibleSectionSchema,
  promotion: extensibleSectionSchema,
  capacity: memoryCapacitySchema,
  corpus_retention: corpusRetentionConfigurationSchema,
  injection: extensibleSectionSchema,
  governance: z.object({
    timezone: z.string().min(1),
    weekly: z.enum(["MONDAY 19:00", "EVERY_3_DAYS 19:00"]).transform(() => "EVERY_3_DAYS 19:00" as const),
    monthly: z.enum(["FIRST_MONDAY 19:00", "MONDAY 19:00"]).transform(() => "MONDAY 19:00" as const)
  }),
  review: extensibleSectionSchema,
  anomalies: extensibleSectionSchema,
  luna_health: extensibleSectionSchema
});

const machineSchema = z.object({
  schema_version: z.literal(1),
  paths: z.object({
    vault_root: z.string().min(1),
    runtime_root: z.string().min(1)
  }),
  projects: extensibleSectionSchema,
  git_cache: extensibleSectionSchema,
  adapters: adapterDisplaySchema,
  embedding: extensibleSectionSchema,
  jev: extensibleSectionSchema,
  luna: extensibleSectionSchema,
  notifier: extensibleSectionSchema,
  launch_agent: extensibleSectionSchema
});

const retrievalIndexPolicySchema = z.object({
  index_quiet_period_seconds: z.number().int().min(1).max(300).default(30),
  index_max_staleness_seconds: z.number().int().min(30).max(3600).default(120)
}).loose();

const versionedDocumentSchema = z.object({
  schema_version: z.number().int()
});

export interface ConfigurationLocation {
  readonly vaultRoot: string;
  readonly runtimeRoot: string;
}

export interface LoadedConfiguration {
  readonly schemaVersion: 1;
  readonly mode: "read_write";
  readonly policy: {
    readonly archiveRetentionMonths: number;
    readonly candidateTombstoneDays: number;
    readonly sensitivityMetadataDays: number;
    readonly injectionReceiptDays: number;
    readonly corpusRetention: CorpusRetentionConfiguration;
    readonly governanceTimezone: string;
    readonly weeklyGovernance: "EVERY_3_DAYS 19:00";
    readonly monthlyGovernance: "MONDAY 19:00";
    readonly memoryCapacity: {
      readonly project: {
        readonly target: number;
        readonly hardLimit: number;
        readonly lowWater: number;
      };
      readonly global: {
        readonly target: number;
        readonly hardLimit: number;
        readonly lowWater: number;
      };
      readonly coldDays: number;
      readonly governanceBatchSize: number;
    };
    readonly indexQuietPeriodSeconds: number;
    readonly indexMaximumStalenessSeconds: number;
  };
  readonly machine: {
    readonly vaultRoot: string;
    readonly runtimeRoot: string;
  };
  readonly recovery?: {
    readonly code: "last_known_good";
    readonly documents: readonly ("policy" | "machine")[];
  };
}

export interface UnsupportedConfiguration {
  readonly schemaVersion: number;
  readonly mode: "read_only";
  readonly diagnostic: {
    readonly code: "unsupported_schema_version";
    readonly document: "policy" | "machine";
    readonly found: number;
    readonly supported: 1;
  };
}

type ConfigurationDocumentName = "policy" | "machine";
type PolicyDocument = z.infer<typeof policySchema>;
type MachineDocument = z.infer<typeof machineSchema>;

type ParsedConfigurationDocument =
  | {
      readonly state: "supported";
      readonly document: PolicyDocument | MachineDocument;
      readonly recovered: boolean;
      readonly topLevelKeys: readonly string[];
    }
  | {
      readonly state: "unsupported";
      readonly version: number;
      readonly recovered: boolean;
    };

function lastKnownGoodPath(
  runtimeRoot: string,
  document: ConfigurationDocumentName
): string {
  return join(runtimeRoot, "state", "config-last-known-good", `${document}.toml`);
}

function parseConfigurationDocument(
  source: string,
  document: ConfigurationDocumentName,
  vaultRoot: string,
  runtimeRoot: string,
  recovered: boolean
): ParsedConfigurationDocument {
  const candidate = parse(source);
  const candidateRecord = z.record(z.string(), z.unknown()).parse(candidate);
  const version = versionedDocumentSchema.parse(candidate).schema_version;
  if (version > 1) {
    return { state: "unsupported", version, recovered };
  }
  const forbiddenKeys =
    document === "policy" ? machineOwnedKeys : policyOwnedKeys;
  if (forbiddenKeys.some((key) => Object.hasOwn(candidateRecord, key))) {
    throw new Error(`${document} configuration contains a key owned elsewhere.`);
  }
  if (document === "policy") {
    return {
      state: "supported",
      document: policySchema.parse(candidate),
      recovered,
      topLevelKeys: Object.keys(candidateRecord)
    };
  }
  const machine = machineSchema.parse(candidate);
  if (
    resolve(machine.paths.vault_root) !== vaultRoot ||
    resolve(machine.paths.runtime_root) !== runtimeRoot
  ) {
    throw new Error("Machine configuration paths do not match the requested location.");
  }
  return {
    state: "supported",
    document: machine,
    recovered,
    topLevelKeys: Object.keys(candidateRecord)
  };
}

async function loadConfigurationDocument(
  sourcePath: string,
  document: ConfigurationDocumentName,
  vaultRoot: string,
  runtimeRoot: string
): Promise<ParsedConfigurationDocument> {
  const source = await readFile(sourcePath, "utf8");
  try {
    return parseConfigurationDocument(
      source,
      document,
      vaultRoot,
      runtimeRoot,
      false
    );
  } catch {
    const fallbackSource = await readFile(
      lastKnownGoodPath(runtimeRoot, document),
      "utf8"
    );
    return parseConfigurationDocument(
      fallbackSource,
      document,
      vaultRoot,
      runtimeRoot,
      true
    );
  }
}

export async function rememberLastKnownGoodConfiguration(
  location: ConfigurationLocation
): Promise<void> {
  const vaultRoot = resolve(location.vaultRoot);
  const runtimeRoot = resolve(location.runtimeRoot);
  const policyPath = join(vaultRoot, "_MemStore", "policy.toml");
  const machinePath = join(runtimeRoot, "config.toml");
  const [policySource, machineSource] = await Promise.all([
    readFile(policyPath, "utf8"),
    readFile(machinePath, "utf8")
  ]);
  const policy = parseConfigurationDocument(
    policySource,
    "policy",
    vaultRoot,
    runtimeRoot,
    false
  );
  const machine = parseConfigurationDocument(
    machineSource,
    "machine",
    vaultRoot,
    runtimeRoot,
    false
  );
  if (policy.state !== "supported" || machine.state !== "supported") {
    throw new Error("A newer configuration cannot become last-known-good state.");
  }
  await mkdir(join(runtimeRoot, "state", "config-last-known-good"), {
    recursive: true,
    mode: 0o700
  });
  await Promise.all([
    writeFileAtomically(lastKnownGoodPath(runtimeRoot, "policy"), policySource, 0o600),
    writeFileAtomically(lastKnownGoodPath(runtimeRoot, "machine"), machineSource, 0o600)
  ]);
}

export async function loadConfiguration(
  location: ConfigurationLocation
): Promise<LoadedConfiguration | UnsupportedConfiguration> {
  const vaultRoot = resolve(location.vaultRoot);
  const runtimeRoot = resolve(location.runtimeRoot);
  const [policyResult, machineResult] = await Promise.all([
    loadConfigurationDocument(
      join(vaultRoot, "_MemStore", "policy.toml"),
      "policy",
      vaultRoot,
      runtimeRoot
    ),
    loadConfigurationDocument(
      join(runtimeRoot, "config.toml"),
      "machine",
      vaultRoot,
      runtimeRoot
    )
  ]);

  if (policyResult.state === "unsupported") {
    return {
      schemaVersion: policyResult.version,
      mode: "read_only",
      diagnostic: {
        code: "unsupported_schema_version",
        document: "policy",
        found: policyResult.version,
        supported: 1
      }
    };
  }
  if (machineResult.state === "unsupported") {
    return {
      schemaVersion: machineResult.version,
      mode: "read_only",
      diagnostic: {
        code: "unsupported_schema_version",
        document: "machine",
        found: machineResult.version,
        supported: 1
      }
    };
  }

  const overlappingKeys = policyResult.topLevelKeys.filter(
    (key) =>
      key !== "schema_version" && machineResult.topLevelKeys.includes(key)
  );
  if (overlappingKeys.length > 0) {
    throw new Error(
      `Configuration documents overlap at top-level key ${overlappingKeys[0] ?? "unknown"}.`
    );
  }

  const policy = policyResult.document as PolicyDocument;
  const retrievalIndexPolicy = retrievalIndexPolicySchema.parse(policy.injection);
  const recoveredDocuments: ConfigurationDocumentName[] = [];
  if (policyResult.recovered) recoveredDocuments.push("policy");
  if (machineResult.recovered) recoveredDocuments.push("machine");

  return {
    schemaVersion: 1,
    mode: "read_write",
    policy: {
      archiveRetentionMonths: policy.retention.archive_months,
      candidateTombstoneDays: policy.retention.candidate_tombstone_days,
      sensitivityMetadataDays: policy.retention.sensitivity_metadata_days,
      injectionReceiptDays: policy.retention.injection_receipt_days,
      corpusRetention: policy.corpus_retention,
      governanceTimezone: policy.governance.timezone,
      weeklyGovernance: policy.governance.weekly,
      monthlyGovernance: policy.governance.monthly,
      memoryCapacity: {
        project: {
          target: policy.capacity.project.target,
          hardLimit: policy.capacity.project.hard_limit,
          lowWater: policy.capacity.project.low_water
        },
        global: {
          target: policy.capacity.global.target,
          hardLimit: policy.capacity.global.hard_limit,
          lowWater: policy.capacity.global.low_water
        },
        coldDays: policy.capacity.cold_days,
        governanceBatchSize: policy.capacity.governance_batch_size
      },
      indexQuietPeriodSeconds: retrievalIndexPolicy.index_quiet_period_seconds,
      indexMaximumStalenessSeconds: retrievalIndexPolicy.index_max_staleness_seconds
    },
    machine: {
      vaultRoot,
      runtimeRoot
    },
    ...(recoveredDocuments.length > 0
      ? {
          recovery: {
            code: "last_known_good" as const,
            documents: recoveredDocuments
          }
        }
      : {})
  };
}

export interface ActivateConfigurationRequest extends ConfigurationLocation {
  readonly document: "policy" | "machine";
  readonly source: string;
  readonly preview: boolean;
}

export type ActivateConfigurationResult =
  | {
      readonly state: "rejected";
      readonly document: "policy" | "machine";
      readonly changed: false;
      readonly diagnostic: { readonly code: "invalid_configuration" };
    }
  | {
      readonly state: "preview";
      readonly document: "policy" | "machine";
      readonly changed: true;
      readonly targetPath: string;
    }
  | {
      readonly state: "activated";
      readonly document: "policy" | "machine";
      readonly changed: true;
      readonly backupPath: string;
    };

export async function activateConfigurationDocument(
  request: ActivateConfigurationRequest
): Promise<ActivateConfigurationResult> {
  const vaultRoot = resolve(request.vaultRoot);
  const runtimeRoot = resolve(request.runtimeRoot);
  const targetPath =
    request.document === "policy"
      ? join(vaultRoot, "_MemStore", "policy.toml")
      : join(runtimeRoot, "config.toml");
  try {
    if (classifyLocalSensitivity(request.source).state !== "normal") {
      throw new Error("Configuration cannot contain sensitive values.");
    }
    const candidate = parse(request.source);
    const candidateRecord = z.record(z.string(), z.unknown()).parse(candidate);
    const otherPath =
      request.document === "policy"
        ? join(runtimeRoot, "config.toml")
        : join(vaultRoot, "_MemStore", "policy.toml");
    const otherRecord = z
      .record(z.string(), z.unknown())
      .parse(parse(await readFile(otherPath, "utf8")));
    if (
      Object.keys(candidateRecord).some(
        (key) => key !== "schema_version" && Object.hasOwn(otherRecord, key)
      )
    ) {
      throw new Error("Configuration documents cannot own the same top-level key.");
    }
    if (request.document === "policy") {
      if (machineOwnedKeys.some((key) => Object.hasOwn(candidateRecord, key))) {
        throw new Error("Portable policy contains machine-owned keys.");
      }
      policySchema.parse(candidate);
    } else {
      if (policyOwnedKeys.some((key) => Object.hasOwn(candidateRecord, key))) {
        throw new Error("Machine configuration contains policy-owned keys.");
      }
      const machine = machineSchema.parse(candidate);
      if (
        resolve(machine.paths.vault_root) !== vaultRoot ||
        resolve(machine.paths.runtime_root) !== runtimeRoot
      ) {
        throw new Error("Machine paths do not match this MemStore location.");
      }
    }
  } catch {
    return {
      state: "rejected",
      document: request.document,
      changed: false,
      diagnostic: { code: "invalid_configuration" }
    };
  }

  if (request.preview) {
    return {
      state: "preview",
      document: request.document,
      changed: true,
      targetPath
    };
  }

  const previousSource = await readFile(targetPath, "utf8");
  const backupPath = `${targetPath}.previous`;
  await writeFileAtomically(backupPath, previousSource, 0o600);
  await writeFileAtomically(targetPath, request.source, 0o600);
  try {
    const activated = await loadConfiguration({ vaultRoot, runtimeRoot });
    if (activated.mode !== "read_write") {
      throw new Error("Activated configuration is not writable.");
    }
  } catch (error) {
    await writeFileAtomically(targetPath, previousSource, 0o600);
    throw error;
  }
  await rememberLastKnownGoodConfiguration({ vaultRoot, runtimeRoot });

  return {
    state: "activated",
    document: request.document,
    changed: true,
    backupPath
  };
}
