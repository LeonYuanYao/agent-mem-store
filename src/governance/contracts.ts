import { z } from "zod";

import type { CanonicalMemory } from "../vault/index.js";

const evidenceRefsSchema = z.array(z.string().min(1).max(512)).min(1).max(16);
export const governanceAgentActionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("archive"),
    targetMemoryId: z.string().min(1),
    reason: z.string().min(1).max(1024),
    evidenceRefs: evidenceRefsSchema
  }),
  z.object({
    kind: z.literal("archive_for_capacity"),
    targetMemoryId: z.string().min(1),
    reason: z.string().min(1).max(1024),
    evidenceRefs: evidenceRefsSchema
  }),
  z.object({
    kind: z.literal("supersede"),
    targetMemoryId: z.string().min(1),
    successorMemoryId: z.string().min(1),
    reason: z.string().min(1).max(1024),
    evidenceRefs: evidenceRefsSchema
  }),
  z.object({
    kind: z.literal("supersede_for_capacity"),
    targetMemoryId: z.string().min(1),
    successorMemoryId: z.string().min(1),
    reason: z.string().min(1).max(1024),
    evidenceRefs: evidenceRefsSchema
  }),
  z.object({
    kind: z.literal("mark_review_due"),
    targetMemoryId: z.string().min(1),
    reason: z.string().min(1).max(1024),
    evidenceRefs: evidenceRefsSchema
  }),
  z.object({
    kind: z.literal("add_relationship"),
    sourceMemoryId: z.string().min(1),
    targetMemoryId: z.string().min(1),
    relationshipType: z.string().min(1).max(128),
    reason: z.string().min(1).max(1024),
    evidenceRefs: evidenceRefsSchema
  })
]);
export type GovernanceAgentAction = z.infer<typeof governanceAgentActionSchema>;
const reviewSuggestionSchema = z.object({
  targetMemoryId: z.string().min(1),
  kind: z.enum(["conflict", "outdated", "relationship", "other"]),
  reason: z.string().min(1).max(1024),
  evidenceRefs: evidenceRefsSchema
});
const futurePurgeSchema = z.object({
  memoryId: z.string().min(1),
  notBefore: z.iso.datetime(),
  reason: z.string().min(1).max(1024)
});
export const governanceOutputSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("governance_page_review"),
  agentActions: z.array(governanceAgentActionSchema).max(100),
  reviewSuggestions: z.array(reviewSuggestionSchema).max(100),
  futurePurgeObligations: z.array(futurePurgeSchema).max(100),
  summaryItems: z.array(z.string().min(1).max(240)).max(16)
});

export const governanceOutputJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion", "kind", "agentActions", "reviewSuggestions",
    "futurePurgeObligations", "summaryItems"
  ],
  properties: {
    schemaVersion: { type: "integer", const: 1 },
    kind: { type: "string", const: "governance_page_review" },
    agentActions: {
      type: "array",
      maxItems: 100,
      items: {
        anyOf: [
          {
            type: "object", additionalProperties: false,
            required: ["kind", "targetMemoryId", "reason", "evidenceRefs"],
            properties: {
              kind: { type: "string", const: "archive" }, targetMemoryId: { type: "string", minLength: 1 },
              reason: { type: "string", minLength: 1, maxLength: 1024 },
              evidenceRefs: { type: "array", minItems: 1, maxItems: 16, items: { type: "string", minLength: 1, maxLength: 512 } }
            }
          },
          {
            type: "object", additionalProperties: false,
            required: ["kind", "targetMemoryId", "reason", "evidenceRefs"],
            properties: {
              kind: { type: "string", const: "archive_for_capacity" }, targetMemoryId: { type: "string", minLength: 1 },
              reason: { type: "string", minLength: 1, maxLength: 1024 },
              evidenceRefs: { type: "array", minItems: 1, maxItems: 16, items: { type: "string", minLength: 1, maxLength: 512 } }
            }
          },
          {
            type: "object", additionalProperties: false,
            required: ["kind", "targetMemoryId", "successorMemoryId", "reason", "evidenceRefs"],
            properties: {
              kind: { type: "string", const: "supersede" }, targetMemoryId: { type: "string", minLength: 1 },
              successorMemoryId: { type: "string", minLength: 1 },
              reason: { type: "string", minLength: 1, maxLength: 1024 },
              evidenceRefs: { type: "array", minItems: 1, maxItems: 16, items: { type: "string", minLength: 1, maxLength: 512 } }
            }
          },
          {
            type: "object", additionalProperties: false,
            required: ["kind", "targetMemoryId", "successorMemoryId", "reason", "evidenceRefs"],
            properties: {
              kind: { type: "string", const: "supersede_for_capacity" }, targetMemoryId: { type: "string", minLength: 1 },
              successorMemoryId: { type: "string", minLength: 1 },
              reason: { type: "string", minLength: 1, maxLength: 1024 },
              evidenceRefs: { type: "array", minItems: 1, maxItems: 16, items: { type: "string", minLength: 1, maxLength: 512 } }
            }
          },
          {
            type: "object", additionalProperties: false,
            required: ["kind", "targetMemoryId", "reason", "evidenceRefs"],
            properties: {
              kind: { type: "string", const: "mark_review_due" }, targetMemoryId: { type: "string", minLength: 1 },
              reason: { type: "string", minLength: 1, maxLength: 1024 },
              evidenceRefs: { type: "array", minItems: 1, maxItems: 16, items: { type: "string", minLength: 1, maxLength: 512 } }
            }
          },
          {
            type: "object", additionalProperties: false,
            required: ["kind", "sourceMemoryId", "targetMemoryId", "relationshipType", "reason", "evidenceRefs"],
            properties: {
              kind: { type: "string", const: "add_relationship" }, sourceMemoryId: { type: "string", minLength: 1 },
              targetMemoryId: { type: "string", minLength: 1 }, relationshipType: { type: "string", minLength: 1, maxLength: 128 },
              reason: { type: "string", minLength: 1, maxLength: 1024 },
              evidenceRefs: { type: "array", minItems: 1, maxItems: 16, items: { type: "string", minLength: 1, maxLength: 512 } }
            }
          }
        ]
      }
    },
    reviewSuggestions: {
      type: "array", maxItems: 100,
      items: {
        type: "object", additionalProperties: false,
        required: ["targetMemoryId", "kind", "reason", "evidenceRefs"],
        properties: {
          targetMemoryId: { type: "string", minLength: 1 },
          kind: { enum: ["conflict", "outdated", "relationship", "other"] },
          reason: { type: "string", minLength: 1, maxLength: 1024 },
          evidenceRefs: { type: "array", minItems: 1, maxItems: 16, items: { type: "string", minLength: 1, maxLength: 512 } }
        }
      }
    },
    futurePurgeObligations: {
      type: "array", maxItems: 100,
      items: {
        type: "object", additionalProperties: false,
        required: ["memoryId", "notBefore", "reason"],
        properties: {
          memoryId: { type: "string", minLength: 1 }, notBefore: { type: "string", format: "date-time" },
          reason: { type: "string", minLength: 1, maxLength: 1024 }
        }
      }
    },
    summaryItems: { type: "array", maxItems: 16, items: { type: "string", minLength: 1, maxLength: 240 } }
  }
} as const;

export type GovernancePageReview = z.infer<typeof governanceOutputSchema>;

export interface GovernanceMemoryInput {
  readonly memoryId: string;
  readonly revisionId: string;
  readonly authority: CanonicalMemory["authority"];
  readonly scope: CanonicalMemory["scope"];
  readonly lifecycle: CanonicalMemory["lifecycle"];
  readonly category: string;
  readonly applicability: CanonicalMemory["applicability"];
  readonly validity: CanonicalMemory["validity"];
  readonly semanticContract: CanonicalMemory["semanticContract"];
  readonly relationships: CanonicalMemory["relationships"];
  readonly provenance: readonly string[];
  readonly body: string;
  readonly revisedAt: string;
  readonly capacity?: {
    readonly eligible: boolean;
    readonly coldSince: string;
    readonly selectedCount: number;
    readonly irrelevantCount: number;
    readonly protectionReasons: readonly string[];
    readonly redundantByMemoryId?: string;
  };
}

export interface GovernanceCapacityPressure {
  readonly scope:
    | { readonly kind: "project"; readonly projectId: string }
    | { readonly kind: "global" };
  readonly activeCount: number;
  readonly target: number;
  readonly hardLimit: number;
  readonly lowWater: number;
  readonly requiredReduction: number;
}

export interface GovernanceAuditSignals {
  readonly brokenRelationshipTargets: readonly string[];
  readonly exactDuplicateGroups: readonly (readonly string[])[];
  readonly reviewedDuplicateClusters: readonly {
    readonly clusterId: string;
    readonly memoryIds: readonly [string, string];
    readonly decision: "equivalent" | "left_subsumes_right" | "right_subsumes_left" | "conflicts";
    readonly reasonCode: string;
  }[];
  readonly openVaultConflictCount: number;
  readonly persistentHighValueAnomalyCount: number;
  readonly openBadCaseCount: number;
  readonly irrelevantObservationCount: number;
  readonly retrievalReceiptCount: number;
  readonly activeIndexRevisionId: string | null;
  readonly modelHealthState: "healthy" | "degraded" | "unavailable";
  readonly lunaBacklogCount: number;
  readonly captureBacklogCount: number;
  readonly indexBuildActive: boolean;
}

export interface GovernancePageRequest {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly runKind: "weekly" | "monthly";
  readonly phase: "weekly" | "monthly";
  readonly coverage: { readonly from: string; readonly through: string };
  readonly pageOrdinal: number;
  readonly memories: readonly GovernanceMemoryInput[];
  readonly capacityPressures?: readonly GovernanceCapacityPressure[];
  readonly auditSignals?: GovernanceAuditSignals;
}

export interface GovernanceAdapter {
  reviewPage(request: GovernancePageRequest): Promise<GovernancePageReview>;
}
