import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

const observedBatchSizes = vi.hoisted(() => [] as number[]);
const observedModelReferences = vi.hoisted(() => [] as string[]);

vi.mock("@huggingface/transformers", () => ({
  pipeline: vi.fn((_task: string, modelReference: string) => {
    observedModelReferences.push(modelReference);
    return Promise.resolve(Object.assign(
    (input: string | readonly string[]) => {
      const count = typeof input === "string" ? 1 : input.length;
      if (typeof input !== "string") observedBatchSizes.push(count);
      return Promise.resolve({
        tolist: () => Array.from({ length: count }, () => [1, 0, 0])
      });
    },
    { dispose: () => Promise.resolve() }
    ));
  })
}));

import { loadTransformersEmbeddingAdapter } from "../../src/retrieval/embeddings/transformers.js";

const roots: string[] = [];

afterEach(async () => {
  observedBatchSizes.splice(0);
  observedModelReferences.splice(0);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("the local-only Transformers adapter loads the installed model without a remote lookup", async () => {
  const cacheDirectory = await mkdtemp(join(tmpdir(), "memstore-embedding-local-"));
  roots.push(cacheDirectory);

  const loaded = await loadTransformersEmbeddingAdapter({
    modelIdentity: "onnx-community/fixture-e5",
    cacheDirectory,
    dtype: "q8",
    localFilesOnly: true
  });

  expect(observedModelReferences).toEqual([
    resolve(cacheDirectory, "onnx-community/fixture-e5")
  ]);
  await loaded.dispose();
});

test("the Transformers adapter keeps every document embedding request within its configured batch", async () => {
  const cacheDirectory = await mkdtemp(join(tmpdir(), "memstore-embedding-batch-"));
  roots.push(cacheDirectory);
  const loaded = await loadTransformersEmbeddingAdapter({
    modelIdentity: "fixture-e5",
    cacheDirectory,
    dtype: "q8",
    batchSize: 4,
    localFilesOnly: true
  });

  const vectors = await loaded.adapter.embedDocuments?.(
    Array.from({ length: 9 }, (_, index) => `document ${String(index)}`)
  );

  expect(loaded.adapter.identity.adapterVersion)
    .toBe("transformers-4.2.0:q8:mean-l2:batch4:v2");
  expect(vectors).toHaveLength(9);
  expect(observedBatchSizes).toEqual([4, 4, 1]);
  await loaded.dispose();
});
