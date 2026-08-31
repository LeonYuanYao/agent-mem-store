import type { CanonicalMemory } from "../../src/vault/index.js";
import type { MemoryCategory } from "../../src/memories/categories.js";

const defaultProjectId = "msproj_123e4567-e89b-42d3-a456-426614174001";

export function makeCanonicalMemory(request: {
  readonly memoryId: string;
  readonly revisionId: string;
  readonly body: string;
  readonly compact?: string;
  readonly standard?: string;
  readonly scope?: CanonicalMemory["scope"];
  readonly authority?: CanonicalMemory["authority"];
  readonly lifecycle?: CanonicalMemory["lifecycle"];
  readonly startup?: CanonicalMemory["startup"];
  readonly primaryCategory?: MemoryCategory;
  readonly categoryTags?: CanonicalMemory["categoryTags"];
  readonly importanceTags?: readonly string[];
  readonly relationships?: CanonicalMemory["relationships"];
  readonly validatedCompact?: boolean;
  readonly validatedStandard?: boolean;
  readonly identityLabel?: string;
  readonly validatedIdentity?: boolean;
  readonly validity?: CanonicalMemory["validity"];
  readonly applicability?: CanonicalMemory["applicability"];
}): CanonicalMemory {
  const scope = request.scope ?? { kind: "project", projectId: defaultProjectId };
  const authority = request.authority ?? "human_authored";
  const compact = request.compact ?? request.body;
  const standard = request.standard ?? request.body;
  const lifecycle = request.lifecycle ?? "active";
  return {
    schemaVersion: 1,
    memoryId: request.memoryId,
    revisionId: request.revisionId,
    scope,
    authority,
    originKind: authority === "human_authored" ? "direct_human_assertion" : "model_extraction",
    sensitivity: "normal",
    lifecycle,
    lifecycleDetails:
      lifecycle === "archived"
        ? { archivedAt: "2026-08-01T00:00:00.000Z", reason: "superseded" }
        : {},
    primaryCategory: request.primaryCategory ?? "workflow_environment_toolchain",
    categoryTags: [...(request.categoryTags ?? [
      request.primaryCategory ?? "workflow_environment_toolchain"
    ])],
    importanceTags: [...(request.importanceTags ?? ["constraint"])],
    startup: request.startup ?? "auto",
    applicability: request.applicability ?? { summary: "Current test project", conditions: [] },
    validity: request.validity ?? { state: "valid" },
    createdAt: "2026-08-07T00:00:00.000Z",
    revisedAt: "2026-08-07T00:00:00.000Z",
    semanticContract: {
      schemaVersion: 1,
      claims: [request.body],
      conditions: [],
      exclusions: [],
      preservedNegations: []
    },
    representations: {
      ...(request.identityLabel === undefined
        ? {}
        : {
            identity: {
              label: request.identityLabel,
              validated: request.validatedIdentity ?? true,
              generatorIdentity: "fixture",
              sourceRevisionId: request.revisionId,
              renderedTokenCount: request.identityLabel.split(/\s+/u).length
            }
          }),
      compact: {
        text: compact,
        validated: request.validatedCompact ?? true,
        generatorIdentity: "fixture",
        sourceRevisionId: request.revisionId,
        renderedTokenCount: compact.split(/\s+/u).length
      },
      standard: {
        text: standard,
        validated: request.validatedStandard ?? true,
        generatorIdentity: "fixture",
        sourceRevisionId: request.revisionId,
        renderedTokenCount: standard.split(/\s+/u).length
      }
    },
    provenance: ["fixture:source"],
    injectionReceiptIds: [],
    relationships: [...(request.relationships ?? [])],
    contentIdentity: "a".repeat(64),
    policyVersion: "1",
    body: request.body
  };
}
