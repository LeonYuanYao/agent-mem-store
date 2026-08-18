import { access } from "node:fs/promises";
import { resolve } from "node:path";

import { approvedShadowEmbeddingProfile } from "../shadow-profile.js";
import { loadTransformersEmbeddingAdapter } from "./transformers.js";

export class EmbeddingArtifactMismatchError extends Error {
  public constructor() {
    super("The installed Shadow embedding artifact does not match the approved Gate 5 profile.");
    this.name = "EmbeddingArtifactMismatchError";
  }
}

export async function loadConfiguredEmbeddingAdapter(runtimeRoot?: string): Promise<
  Awaited<ReturnType<typeof loadTransformersEmbeddingAdapter>> | undefined
> {
  const modelDirectory = process.env.MEMSTORE_EMBEDDING_MODEL_DIR ?? (
    runtimeRoot === undefined ? undefined : resolve(runtimeRoot, "models", "e5-base-q8")
  );
  if (modelDirectory === undefined) return undefined;
  const available = await access(modelDirectory).then(() => true).catch(() => false);
  if (!available) return undefined;
  const loaded = await loadTransformersEmbeddingAdapter({
    modelIdentity: approvedShadowEmbeddingProfile.modelIdentity,
    cacheDirectory: resolve(modelDirectory),
    dtype: approvedShadowEmbeddingProfile.dtype,
    queryPrefix: approvedShadowEmbeddingProfile.queryPrefix,
    documentPrefix: approvedShadowEmbeddingProfile.documentPrefix,
    batchSize: approvedShadowEmbeddingProfile.batchSize,
    localFilesOnly: true
  });
  const approvedIdentity = {
    adapterVersion: approvedShadowEmbeddingProfile.adapterVersion,
    modelIdentity: approvedShadowEmbeddingProfile.modelIdentity,
    artifactSha256: approvedShadowEmbeddingProfile.artifactSha256,
    dimensions: approvedShadowEmbeddingProfile.dimensions,
    normalization: approvedShadowEmbeddingProfile.normalization
  };
  if (JSON.stringify(loaded.adapter.identity) === JSON.stringify(approvedIdentity)) {
    return loaded;
  }
  await loaded.dispose();
  throw new EmbeddingArtifactMismatchError();
}
