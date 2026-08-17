import { mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { MemStoreCommandError } from "../contracts/envelope.js";
import { loadTransformersEmbeddingAdapter } from "../retrieval/embeddings/transformers.js";
import { approvedShadowEmbeddingProfile } from "../retrieval/shadow-profile.js";

function expectedIdentity() {
  return {
    adapterVersion: approvedShadowEmbeddingProfile.adapterVersion,
    modelIdentity: approvedShadowEmbeddingProfile.modelIdentity,
    artifactSha256: approvedShadowEmbeddingProfile.artifactSha256,
    dimensions: approvedShadowEmbeddingProfile.dimensions,
    normalization: approvedShadowEmbeddingProfile.normalization
  };
}

async function verifyDirectory(directory: string, localFilesOnly: boolean): Promise<{
  readonly artifactSha256: string;
  readonly bytes: number;
  readonly fileCount: number;
}> {
  const loaded = await loadTransformersEmbeddingAdapter({
    modelIdentity: approvedShadowEmbeddingProfile.modelIdentity,
    cacheDirectory: directory,
    dtype: approvedShadowEmbeddingProfile.dtype,
    queryPrefix: approvedShadowEmbeddingProfile.queryPrefix,
    documentPrefix: approvedShadowEmbeddingProfile.documentPrefix,
    batchSize: approvedShadowEmbeddingProfile.batchSize,
    localFilesOnly
  });
  try {
    if (JSON.stringify(loaded.adapter.identity) !== JSON.stringify(expectedIdentity())) {
      throw new MemStoreCommandError(
        "embedding_artifact_mismatch",
        "Downloaded embedding files do not match the Gate 5 approved artifact."
      );
    }
    return {
      artifactSha256: loaded.artifact.sha256,
      bytes: loaded.artifact.bytes,
      fileCount: loaded.artifact.fileCount
    };
  } finally {
    await loaded.dispose();
  }
}

export async function prepareShadowEmbedding(request: {
  readonly destination: string;
  readonly preview?: boolean;
}): Promise<{
  readonly state: "preview" | "installed" | "verified";
  readonly destination: string;
  readonly artifactSha256: string;
  readonly networkRequired: boolean;
  readonly bytes?: number;
  readonly fileCount?: number;
}> {
  const destination = resolve(request.destination);
  if (request.preview === true) {
    return {
      state: "preview",
      destination,
      artifactSha256: approvedShadowEmbeddingProfile.artifactSha256,
      networkRequired: true
    };
  }
  const destinationExists = await stat(destination).then(() => true).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  });
  if (destinationExists) {
    const verified = await verifyDirectory(destination, true);
    return { state: "verified", destination, networkRequired: false, ...verified };
  }

  const parent = dirname(destination);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(resolve(parent, ".embedding-staging-"));
  let published = false;
  try {
    const verified = await verifyDirectory(staging, false);
    await rename(staging, destination);
    published = true;
    return { state: "installed", destination, networkRequired: true, ...verified };
  } finally {
    if (!published) await rm(staging, { recursive: true, force: true });
  }
}
