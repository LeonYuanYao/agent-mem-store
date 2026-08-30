import { Temporal } from "@js-temporal/polyfill";
import { z } from "zod";

import { loadConfiguration } from "../configuration/index.js";
import type { CanonicalMemory } from "../vault/index.js";

export const DEFAULT_ARCHIVE_RETENTION_MONTHS = 3;

export function archivePurgeAfter(archivedAt: string, months: number): string {
  const retentionMonths = z.number().int().positive().parse(months);
  return Temporal.Instant.from(z.iso.datetime().parse(archivedAt))
    .toZonedDateTimeISO("UTC")
    .add({ months: retentionMonths })
    .toInstant()
    .toString({ smallestUnit: "millisecond" });
}

export function archiveLifecycleDetails(request: {
  readonly previous: CanonicalMemory["lifecycleDetails"];
  readonly archivedAt: string;
  readonly reason: string;
  readonly archiveRetentionMonths: number;
}): CanonicalMemory["lifecycleDetails"] {
  const archivedAt = z.iso.datetime().parse(request.archivedAt);
  const explicitPurgeAfter = request.previous.purgeAfter;
  const protectedFromAutomaticPurge = explicitPurgeAfter === undefined && (
    request.previous.retainForever === true || request.previous.pinned === true
  );
  return {
    archivedAt,
    reason: z.string().min(1).parse(request.reason),
    ...(request.previous.retainForever === true ? { retainForever: true } : {}),
    ...(request.previous.pinned === true ? { pinned: true } : {}),
    ...(protectedFromAutomaticPurge
      ? {}
      : {
          purgeAfter: explicitPurgeAfter ?? archivePurgeAfter(
            archivedAt,
            request.archiveRetentionMonths
          )
        })
  };
}

export async function loadArchiveRetentionMonths(request: {
  readonly runtimeRoot: string;
  readonly vaultRoot: string;
}): Promise<number> {
  let configuration: Awaited<ReturnType<typeof loadConfiguration>>;
  try {
    configuration = await loadConfiguration(request);
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? error.code
      : undefined;
    if (code === "ENOENT") return DEFAULT_ARCHIVE_RETENTION_MONTHS;
    throw error;
  }
  if (configuration.mode !== "read_write") {
    throw new Error("Archive retention requires writable configuration.");
  }
  return configuration.policy.archiveRetentionMonths;
}
