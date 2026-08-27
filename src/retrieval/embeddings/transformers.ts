import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import {
  pipeline,
  type FeatureExtractionPipeline
} from "@huggingface/transformers";
import { z } from "zod";

import type { EmbeddingAdapter } from "../index.js";

async function listFiles(root: string, directory = root): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? listFiles(root, path) : entry.isFile() ? [path] : [];
  }));
  return nested.flat().sort();
}

export async function fingerprintArtifactDirectory(directory: string): Promise<{
  readonly sha256: string;
  readonly bytes: number;
  readonly fileCount: number;
}> {
  const root = resolve(directory);
  const files = await listFiles(root);
  const hash = createHash("sha256");
  let bytes = 0;
  for (const path of files) {
    hash.update(relative(root, path));
    const metadata = await stat(path);
    bytes += metadata.size;
    for await (const chunk of createReadStream(path)) {
      hash.update(z.instanceof(Buffer).parse(chunk));
    }
  }
  return { sha256: hash.digest("hex"), bytes, fileCount: files.length };
}

function tensorRows(value: unknown): readonly (readonly number[])[] {
  return z.array(z.array(z.number())).parse(value);
}

export async function loadTransformersEmbeddingAdapter(request: {
  readonly modelIdentity: string;
  readonly cacheDirectory: string;
  readonly dtype: "q8" | "fp32";
  readonly queryPrefix?: string;
  readonly documentPrefix?: string;
  readonly batchSize?: number;
  readonly localFilesOnly?: boolean;
}): Promise<{
  readonly adapter: EmbeddingAdapter;
  readonly pipelineLoadMilliseconds: number;
  readonly artifactFingerprintMilliseconds: number;
  readonly artifact: {
    readonly sha256: string;
    readonly bytes: number;
    readonly fileCount: number;
  };
  dispose(): Promise<void>;
}> {
  const started = performance.now();
  const modelReference = request.localFilesOnly === true
    ? resolve(request.cacheDirectory, request.modelIdentity)
    : request.modelIdentity;
  const extractor: FeatureExtractionPipeline = await pipeline(
    "feature-extraction",
    modelReference,
    {
      cache_dir: resolve(request.cacheDirectory),
      local_files_only: request.localFilesOnly ?? false,
      device: "cpu",
      dtype: request.dtype
    }
  );
  const probeRaw: unknown = (await extractor("dimension probe", {
    pooling: "mean",
    normalize: true
  })).tolist();
  const probe = tensorRows(probeRaw);
  const dimensions = probe[0]?.length ?? 0;
  if (dimensions <= 0) {
    await extractor.dispose();
    throw new Error("Embedding model returned no dimensions.");
  }
  const pipelineLoadedAt = performance.now();
  const artifact = await fingerprintArtifactDirectory(request.cacheDirectory);
  const artifactFingerprintedAt = performance.now();
  const batchSize = z.number().int().positive().max(256).default(16).parse(request.batchSize);
  const embedWithPrefix = async (
    texts: readonly string[],
    prefix: string
  ): Promise<readonly (readonly number[])[]> => {
    if (texts.length === 0) return [];
    const rows: (readonly number[])[] = [];
    for (let offset = 0; offset < texts.length; offset += batchSize) {
      const batch = texts.slice(offset, offset + batchSize);
      const output = await extractor(batch.map((text) => `${prefix}${text}`), {
        pooling: "mean",
        normalize: true
      });
      const raw: unknown = output.tolist();
      const batchRows = tensorRows(raw);
      if (batchRows.length !== batch.length || batchRows.some((row) => row.length !== dimensions)) {
        throw new Error("Embedding model returned an unexpected tensor shape.");
      }
      rows.push(...batchRows);
    }
    return rows;
  };
  const queryPrefix = request.queryPrefix ?? "";
  const documentPrefix = request.documentPrefix ?? "";
  const adapter: EmbeddingAdapter = {
    identity: {
      adapterVersion: `transformers-4.2.0:${request.dtype}:mean-l2:batch${String(batchSize)}:v2`,
      modelIdentity: request.modelIdentity,
      artifactSha256: artifact.sha256,
      dimensions,
      normalization: "l2"
    },
    embed: (texts) => embedWithPrefix(texts, documentPrefix),
    embedDocuments: (texts) => embedWithPrefix(texts, documentPrefix),
    embedQuery: (texts) => embedWithPrefix(texts, queryPrefix)
  };
  return {
    adapter,
    pipelineLoadMilliseconds: Math.max(0, pipelineLoadedAt - started),
    artifactFingerprintMilliseconds: Math.max(0, artifactFingerprintedAt - pipelineLoadedAt),
    artifact,
    dispose: () => extractor.dispose()
  };
}
