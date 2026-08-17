import { expect, test } from "vitest";

import { approvedShadowEmbeddingProfile } from "../../src/retrieval/shadow-profile.js";

test("the reviewed E5-base q8 Shadow candidate is frozen without activating it", () => {
  expect(approvedShadowEmbeddingProfile).toEqual({
    schemaVersion: 1,
    state: "approved_shadow_candidate",
    activated: false,
    modelIdentity: "onnx-community/multilingual-e5-base-ONNX",
    dtype: "q8",
    artifactSha256: "b17da479f058a2cd4dd677c0f50c7cb9ba87d274fe2a94a31c136ef465830cc2",
    dimensions: 768,
    normalization: "l2",
    batchSize: 16,
    adapterVersion: "transformers-4.2.0:q8:mean-l2:batch16:v2",
    queryPrefix: "query: ",
    documentPrefix: "passage: ",
    semanticOnlyMinimumScore: 0.82,
    semanticOnlyMinimumTop1Margin: 0.02
  });
});
