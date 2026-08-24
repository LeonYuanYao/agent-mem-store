import { expect, test } from "vitest";

import { admittedOutput } from "../../src/admission/audit.js";
import type { DistillationOutput } from "../../src/luna/index.js";
import { makeLongTermCandidateDurability } from "../helpers/candidate-durability.js";

test("admission reports an explicit diagnostic instead of accepting more than 64 durable candidates", () => {
  const output: DistillationOutput = {
    schemaVersion: 1,
    kind: "distillation",
    candidates: Array.from({ length: 65 }, (_, index) => ({
      statement: `Durable clause ${String(index)}.`,
      primaryCategory: "durable_reference",
      categoryTags: ["durable_reference"],
      applicabilitySummary: "future project work",
      conditions: [],
      exclusions: [],
      preservedNegations: [],
      certainty: "asserted",
      sensitivity: "normal",
      evidenceIds: ["evidence-1"],
      retentionDecision: "long_term",
      durability: makeLongTermCandidateDurability(),
      importanceTags: [],
      importanceReasons: []
    }))
  };

  let failure: unknown;
  try {
    admittedOutput(output);
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({
    category: "schema_invalid",
    retryable: true,
    diagnostic: {
      stage: "retention_validation",
      code: "admitted_candidate_limit_exceeded"
    }
  });
});
