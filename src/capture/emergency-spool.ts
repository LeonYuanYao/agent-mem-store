import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod";

import { classifyLocalSensitivity } from "../contracts/sensitivity.js";
import { writeFileAtomicallyExclusive } from "../contracts/atomic-file.js";
import { resolveProject } from "../projects/index.js";
import {
  captureRecoveredEvent,
  captureEventSchema,
  prepareCaptureEventForPersistence,
  type CaptureEvent
} from "./index.js";

const spoolEntryContentSchema = z.object({
  schemaVersion: z.literal(1),
  spoolId: z.string().regex(/^msspool_[0-9a-f-]+$/u),
  spooledAt: z.iso.datetime(),
  projectPath: z.string().min(1),
  event: captureEventSchema,
  originalSourceBytes: z.number().int().nonnegative(),
  sourceTruncated: z.boolean()
});

const spoolEntrySchema = spoolEntryContentSchema.extend({
  contentSha256: z.string().regex(/^[0-9a-f]{64}$/u)
});

type SpoolEntryContent = z.infer<typeof spoolEntryContentSchema>;

export const emergencySpoolMaximumPendingEntries = 256;

function captureSpoolRoot(runtimeRoot: string): string {
  return join(runtimeRoot, "spool", "capture");
}

function pendingRoot(runtimeRoot: string): string {
  return join(captureSpoolRoot(runtimeRoot), "pending");
}

function quarantineRoot(runtimeRoot: string): string {
  return join(captureSpoolRoot(runtimeRoot), "quarantine");
}

function contentIdentity(content: SpoolEntryContent): string {
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

function spoolFileName(eventId: string): string {
  const identity = createHash("sha256").update(eventId).digest("hex");
  return `${identity}.json`;
}

function sqliteIsBusy(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error
    ? error.code
    : undefined;
  const message = error instanceof Error ? error.message : "";
  return code === "SQLITE_BUSY" || /database is locked|SQLITE_BUSY/iu.test(message);
}

async function validateExistingSpoolEntry(path: string, eventId: string): Promise<boolean> {
  try {
    const parsed = spoolEntrySchema.parse(JSON.parse(await readFile(path, "utf8")));
    const { contentSha256, ...content } = parsed;
    if (contentIdentity(content) !== contentSha256 || parsed.event.eventId !== eventId) {
      throw new Error("Existing emergency spool entry is invalid.");
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function spoolCaptureEvent(request: {
  readonly runtimeRoot: string;
  readonly projectPath: string;
  readonly spooledAt: string;
  readonly event: CaptureEvent;
}): Promise<{ readonly state: "spooled"; readonly eventId: string }> {
  const event = captureEventSchema.parse(request.event);
  const prepared = prepareCaptureEventForPersistence(event);
  if (prepared.state !== "normal") {
    throw new Error("Emergency spool refuses sensitive or uncertain content.");
  }
  const retainedPayload = JSON.parse(prepared.retainedPayload.toString("utf8")) as unknown;
  if (classifyLocalSensitivity(JSON.stringify(retainedPayload)).state !== "normal") {
    throw new Error("Emergency spool bounded content did not pass sensitivity classification.");
  }
  const content = spoolEntryContentSchema.parse({
    schemaVersion: 1,
    spoolId: `msspool_${randomUUID()}`,
    spooledAt: request.spooledAt,
    projectPath: request.projectPath,
    event: { ...event, payload: retainedPayload },
    originalSourceBytes: prepared.sourceBytes,
    sourceTruncated: prepared.sourceTruncated
  });
  const entry = spoolEntrySchema.parse({
    ...content,
    contentSha256: contentIdentity(content)
  });
  const directory = pendingRoot(request.runtimeRoot);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const targetPath = join(directory, spoolFileName(event.eventId));
  if (await validateExistingSpoolEntry(targetPath, event.eventId)) {
    return { state: "spooled", eventId: event.eventId };
  }
  if ((await jsonFileNames(directory)).length >= emergencySpoolMaximumPendingEntries) {
    throw new Error(
      `Emergency spool capacity exceeded (${String(emergencySpoolMaximumPendingEntries)} pending events).`
    );
  }
  try {
    await writeFileAtomicallyExclusive(
      targetPath,
      `${JSON.stringify(entry)}\n`,
      0o600
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    await validateExistingSpoolEntry(targetPath, event.eventId);
  }
  return { state: "spooled", eventId: event.eventId };
}

export type EmergencySpoolImportResult =
  | { readonly state: "empty" }
  | { readonly state: "imported"; readonly eventId: string }
  | { readonly state: "deferred" }
  | { readonly state: "quarantined"; readonly fileName: string };

export interface EmergencySpoolSummary {
  readonly pendingCount: number;
  readonly maximumPendingCount: number;
  readonly capacityState: "available" | "full";
  readonly oldestPendingAt: string | null;
  readonly quarantineCount: number;
  readonly totalBytes: number;
}

async function jsonFileNames(directory: string): Promise<readonly string[]> {
  try {
    return (await readdir(directory))
      .filter((fileName) => fileName.endsWith(".json"))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function inspectEmergencySpool(
  runtimeRoot: string
): Promise<EmergencySpoolSummary> {
  const pendingDirectory = pendingRoot(runtimeRoot);
  const quarantineDirectory = quarantineRoot(runtimeRoot);
  const [pendingFiles, quarantineFiles] = await Promise.all([
    jsonFileNames(pendingDirectory),
    jsonFileNames(quarantineDirectory)
  ]);
  const pendingMetadata = await Promise.all(pendingFiles.map(async (fileName) => {
    const path = join(pendingDirectory, fileName);
    const fileStat = await stat(path);
    let spooledAt = fileStat.mtime.toISOString();
    try {
      const parsed = spoolEntrySchema.parse(JSON.parse(await readFile(path, "utf8")));
      spooledAt = parsed.spooledAt;
    } catch {
      // Invalid entries remain visible and will be quarantined by the Worker.
    }
    return { bytes: fileStat.size, spooledAt };
  }));
  const quarantineBytes = await Promise.all(quarantineFiles.map(async (fileName) =>
    (await stat(join(quarantineDirectory, fileName))).size
  ));
  return {
    pendingCount: pendingFiles.length,
    maximumPendingCount: emergencySpoolMaximumPendingEntries,
    capacityState: pendingFiles.length >= emergencySpoolMaximumPendingEntries
      ? "full"
      : "available",
    oldestPendingAt: pendingMetadata
      .map((item) => item.spooledAt)
      .sort()[0] ?? null,
    quarantineCount: quarantineFiles.length,
    totalBytes:
      pendingMetadata.reduce((total, item) => total + item.bytes, 0) +
      quarantineBytes.reduce((total, bytes) => total + bytes, 0)
  };
}

export async function importNextEmergencySpoolEvent(request: {
  readonly runtimeRoot: string;
  readonly importedAt: string;
}): Promise<EmergencySpoolImportResult> {
  const directory = pendingRoot(request.runtimeRoot);
  let files: string[];
  try {
    files = [...await jsonFileNames(directory)];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "empty" };
    throw error;
  }
  const fileName = files[0];
  if (fileName === undefined) return { state: "empty" };
  const sourcePath = join(directory, fileName);
  try {
    const parsed = spoolEntrySchema.parse(JSON.parse(await readFile(sourcePath, "utf8")));
    const { contentSha256, ...content } = parsed;
    if (contentIdentity(content) !== contentSha256) {
      throw new Error("Emergency spool content identity does not match.");
    }
    const project = parsed.event.projectId === undefined
      ? await resolveProject({
          path: parsed.projectPath,
          runtimeRoot: request.runtimeRoot
        })
      : undefined;
    const event = captureEventSchema.parse({
      ...parsed.event,
      ...(parsed.event.projectId === undefined && project?.status === "resolved"
        ? { projectId: project.projectId }
        : {})
    });
    const captured = await captureRecoveredEvent({
      runtimeRoot: request.runtimeRoot,
      event,
      originalSourceBytes: parsed.originalSourceBytes,
      sourceTruncated: parsed.sourceTruncated
    });
    if (captured.state !== "captured" && captured.state !== "duplicate") {
      throw new Error(`Emergency spool import was rejected with state ${captured.state}.`);
    }
    await unlink(sourcePath);
    return { state: "imported", eventId: captured.eventId };
  } catch (error) {
    if (sqliteIsBusy(error)) return { state: "deferred" };
    const quarantineDirectory = quarantineRoot(request.runtimeRoot);
    await mkdir(quarantineDirectory, { recursive: true, mode: 0o700 });
    await rename(
      sourcePath,
      join(quarantineDirectory, `${basename(fileName, ".json")}-${randomUUID()}.json`)
    );
    return { state: "quarantined", fileName };
  }
}
