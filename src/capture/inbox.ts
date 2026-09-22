import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { access, mkdir, open, readFile, readdir, rename, rm, stat, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

import { writeFileAtomicallyExclusive } from "../contracts/atomic-file.js";
import {
  captureEventSchema,
  prepareCaptureEventForPersistence,
  recordBodyFreeSensitivityDisposition,
  type CaptureEvent
} from "./index.js";
import {
  captureInboxFileMaximumPendingBytes,
  captureInboxFileMaximumPendingEntries,
  prepareCaptureInboxEventWrite,
  importNextCaptureInboxEventFile,
  inspectCaptureInboxFiles
} from "./inbox-files.js";
import { CaptureFailure, type CaptureProgress } from "./deadline.js";

export const captureInboxMaximumPendingEntries = captureInboxFileMaximumPendingEntries;
export const captureInboxMaximumPendingBytes = captureInboxFileMaximumPendingBytes;
const captureInboxCapacityLockTimeoutMilliseconds = 750;
const captureInboxCapacityLockStaleMilliseconds = 2_000;

const bodyFreeEventSchema = captureEventSchema.omit({ payload: true });
const bodyFreeDispositionContentSchema = z.object({
  schemaVersion: z.literal(1),
  dispositionId: z.string().regex(/^msdisposition_[0-9a-f-]+$/u),
  capturedAt: z.iso.datetime(),
  projectPath: z.string().min(1),
  state: z.enum(["blocked_secret", "quarantined"]),
  event: bodyFreeEventSchema,
  finding: z.object({
    findingId: z.string().regex(/^msfinding_[0-9a-f-]+$/u),
    category: z.enum([
      "authorization_header",
      "private_key",
      "credential_field",
      "contextual_credential"
    ]),
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
    sourceIdentity: z.string().regex(/^[0-9a-f]{64}$/u)
  })
});
const bodyFreeDispositionFileSchema = bodyFreeDispositionContentSchema.extend({
  contentSha256: z.string().regex(/^[0-9a-f]{64}$/u)
});

type BodyFreeCaptureDisposition = Pick<
  z.infer<typeof bodyFreeDispositionContentSchema>,
  "state" | "event" | "finding"
>;

export type CaptureDisposition =
  | { readonly state: "event"; readonly event: CaptureEvent }
  | BodyFreeCaptureDisposition;

async function fingerprintKey(runtimeRoot: string): Promise<Buffer> {
  const directory = join(runtimeRoot, "state");
  const path = join(directory, "fingerprint.key");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    const key = randomBytes(32);
    const file = await open(path, "wx", 0o600);
    try {
      await file.writeFile(key);
      await file.sync();
    } finally {
      await file.close();
    }
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return readFile(path);
  }
}

export async function prepareCaptureDisposition(request: {
  readonly runtimeRoot: string;
  readonly event: CaptureEvent;
}): Promise<CaptureDisposition> {
  const prepared = prepareCaptureEventForPersistence(request.event);
  if (prepared.state === "normal") {
    const retainedPayload = JSON.parse(prepared.retainedPayload.toString("utf8")) as unknown;
    return { state: "event", event: { ...prepared.event, payload: retainedPayload } };
  }
  const key = await fingerprintKey(request.runtimeRoot);
  const fingerprint = createHmac("sha256", key)
    .update(prepared.finding.category)
    .update("\0")
    .update(prepared.finding.matchedValue)
    .digest("hex");
  const sourceIdentity = createHmac("sha256", key)
    .update(prepared.event.deduplicationKey)
    .digest("hex");
  const { payload: _payload, ...event } = prepared.event;
  void _payload;
  return bodyFreeDispositionContentSchema.pick({ state: true, event: true, finding: true }).parse({
    state: prepared.state === "secret" ? "blocked_secret" : "quarantined",
    event,
    finding: {
      findingId: `msfinding_${randomUUID()}`,
      category: prepared.finding.category,
      fingerprint,
      sourceIdentity
    }
  });
}

function dispositionRoot(runtimeRoot: string): string {
  return join(runtimeRoot, "spool", "capture", "dispositions");
}

function pendingRoot(runtimeRoot: string): string {
  return join(runtimeRoot, "spool", "capture", "pending");
}

function quarantineRoot(runtimeRoot: string): string {
  return join(runtimeRoot, "spool", "capture", "quarantine");
}

function capacityLockPath(runtimeRoot: string): string {
  return join(runtimeRoot, "spool", "capture", ".capacity-lock");
}

function dispositionIdentity(content: z.infer<typeof bodyFreeDispositionContentSchema>): string {
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

async function dispositionFileNames(runtimeRoot: string): Promise<readonly string[]> {
  try {
    return (await readdir(dispositionRoot(runtimeRoot))).filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function jsonFileNames(directory: string): Promise<readonly string[]> {
  try {
    return (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function fileBytes(directory: string, fileNames: readonly string[]): Promise<number> {
  return (await Promise.all(fileNames.map(async (name) =>
    (await stat(join(directory, name))).size
  ))).reduce((total, bytes) => total + bytes, 0);
}

async function pendingCapacity(runtimeRoot: string): Promise<{
  readonly normalCount: number;
  readonly dispositionCount: number;
  readonly normalBytes: number;
  readonly dispositionBytes: number;
}> {
  const [normalFiles, dispositionFiles] = await Promise.all([
    jsonFileNames(pendingRoot(runtimeRoot)),
    dispositionFileNames(runtimeRoot)
  ]);
  const [normalBytes, dispositionBytes] = await Promise.all([
    fileBytes(pendingRoot(runtimeRoot), normalFiles),
    fileBytes(dispositionRoot(runtimeRoot), dispositionFiles)
  ]);
  return {
    normalCount: normalFiles.length,
    dispositionCount: dispositionFiles.length,
    normalBytes,
    dispositionBytes
  };
}

async function withCapacityLock<T>(runtimeRoot: string, action: () => Promise<T>, progress?: CaptureProgress): Promise<T> {
  progress?.enter("inbox_lock");
  const lockPath = capacityLockPath(runtimeRoot);
  await mkdir(join(runtimeRoot, "spool", "capture"), { recursive: true, mode: 0o700 });
  const deadline = progress !== undefined && Number.isFinite(progress.deadlineAt)
    ? progress.deadlineAt - 100
    : performance.now() + captureInboxCapacityLockTimeoutMilliseconds;
  for (;;) {
    if (performance.now() >= deadline) throw new CaptureFailure("inbox_lock_timeout");
    try {
      await mkdir(lockPath, { mode: 0o700 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const metadata = await stat(lockPath);
        if (Date.now() - metadata.mtimeMs >= captureInboxCapacityLockStaleMilliseconds) {
          await rm(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch (inspectionError) {
        if ((inspectionError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw inspectionError;
      }
      if (performance.now() >= deadline) {
        throw new CaptureFailure("inbox_lock_timeout");
      }
      await delay(5);
    }
  }
  try {
    return await action();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

async function importNextBodyFreeDisposition(request: {
  readonly runtimeRoot: string;
}): Promise<"empty" | "imported" | "quarantined" | "deferred"> {
  const fileName = (await dispositionFileNames(request.runtimeRoot))[0];
  if (fileName === undefined) return "empty";
  const path = join(dispositionRoot(request.runtimeRoot), fileName);
  try {
    const parsed = bodyFreeDispositionFileSchema.parse(
      JSON.parse(await readFile(path, "utf8")) as unknown
    );
    const { contentSha256, ...content } = parsed;
    if (dispositionIdentity(content) !== contentSha256) {
      throw new Error("Capture disposition content identity does not match.");
    }
    await recordBodyFreeSensitivityDisposition({
      runtimeRoot: request.runtimeRoot,
      findingId: parsed.finding.findingId,
      fingerprint: parsed.finding.fingerprint,
      sourceIdentity: parsed.finding.sourceIdentity,
      state: parsed.state,
      category: parsed.finding.category,
      observedAt: parsed.event.occurredAt,
      sourceKind: `${parsed.event.agent}:${parsed.event.eventKind}`
    });
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? error.code
      : undefined;
    const message = error instanceof Error ? error.message : "";
    if (code === "SQLITE_BUSY" || /database is locked|SQLITE_BUSY/iu.test(message)) return "deferred";
    await mkdir(quarantineRoot(request.runtimeRoot), { recursive: true, mode: 0o700 });
    await rename(
      path,
      join(
        quarantineRoot(request.runtimeRoot),
        `disposition-${basename(fileName, ".json")}-${randomUUID()}.json`
      )
    );
    return "quarantined";
  }
  await unlink(path);
  return "imported";
}

export async function appendCaptureDisposition(request: {
  readonly runtimeRoot: string;
  readonly projectPath: string;
  readonly capturedAt: string;
  readonly disposition: CaptureDisposition;
  readonly progress?: CaptureProgress;
}): Promise<{
  readonly state: "durable";
  readonly eventId: string;
}> {
  if (request.disposition.state === "event") {
    const event = request.disposition.event;
    const persist = prepareCaptureInboxEventWrite({
      runtimeRoot: request.runtimeRoot, projectPath: request.projectPath,
      spooledAt: request.capturedAt, event
    });
    return withCapacityLock(request.runtimeRoot, async () => {
      request.progress?.enter("inbox_scan");
      const dispositions = await dispositionFileNames(request.runtimeRoot);
      const dispositionBytes = await fileBytes(dispositionRoot(request.runtimeRoot), dispositions);
      const result = await persist({
        reservedPendingEntries: dispositions.length,
        reservedPendingBytes: dispositionBytes,
        ...(request.progress === undefined ? {} : { progress: request.progress })
      });
      return { state: "durable" as const, eventId: result.eventId };
    }, request.progress);
  }
  const content = bodyFreeDispositionContentSchema.parse({
    schemaVersion: 1,
    dispositionId: `msdisposition_${randomUUID()}`,
    capturedAt: request.capturedAt,
    projectPath: request.projectPath,
    ...request.disposition
  });
  const file = bodyFreeDispositionFileSchema.parse({
    ...content,
    contentSha256: dispositionIdentity(content)
  });
  return withCapacityLock(request.runtimeRoot, async () => {
    request.progress?.enter("inbox_scan");
    const directory = dispositionRoot(request.runtimeRoot);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(
      directory,
      `${createHash("sha256").update(content.event.eventId).digest("hex")}.json`
    );
    try {
      await access(path);
      const existing = bodyFreeDispositionFileSchema.parse(
        JSON.parse(await readFile(path, "utf8")) as unknown
      );
      const { contentSha256, ...existingContent } = existing;
      if (
        dispositionIdentity(existingContent) !== contentSha256 ||
        existing.event.eventId !== content.event.eventId
      ) {
        throw new Error("Existing Capture disposition is invalid.");
      }
      return { state: "durable" as const, eventId: content.event.eventId };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const capacity = await pendingCapacity(request.runtimeRoot);
    const serializedFile = `${JSON.stringify(file)}\n`;
    if (
      capacity.normalCount + capacity.dispositionCount >= captureInboxMaximumPendingEntries
    ) {
      throw new CaptureFailure("inbox_capacity_exceeded");
    }
    if (
      capacity.normalBytes + capacity.dispositionBytes +
        Buffer.byteLength(serializedFile, "utf8") > captureInboxMaximumPendingBytes
    ) {
      throw new CaptureFailure("inbox_capacity_exceeded");
    }
    request.progress?.enter("inbox_write");
    if (request.progress !== undefined) request.progress.persistence = "unconfirmed";
    await writeFileAtomicallyExclusive(path, serializedFile, 0o600);
    return { state: "durable" as const, eventId: content.event.eventId };
  }, request.progress);
}

export async function inspectCaptureInbox(runtimeRoot: string): Promise<{
  readonly pendingCount: number;
  readonly normalEventCount: number;
  readonly dispositionCount: number;
  readonly quarantineCount: number;
  readonly maximumPendingCount: number;
  readonly maximumPendingBytes: number;
  readonly capacityState: "available" | "warning" | "critical" | "full";
  readonly pendingBytes: number;
  readonly totalBytes: number;
  readonly oldestPendingAt: string | null;
}> {
  const summary = await inspectCaptureInboxFiles(runtimeRoot);
  const dispositionFiles = await dispositionFileNames(runtimeRoot);
  const dispositionMetadata = await Promise.all(dispositionFiles.map(async (name) => {
    const path = join(dispositionRoot(runtimeRoot), name);
    const metadata = await stat(path);
    let capturedAt = metadata.mtime.toISOString();
    try {
      capturedAt = bodyFreeDispositionFileSchema.parse(
        JSON.parse(await readFile(path, "utf8")) as unknown
      ).capturedAt;
    } catch {
      // Invalid entries remain visible and are quarantined by the importer.
    }
    return { bytes: metadata.size, capturedAt };
  }));
  const dispositionBytes = dispositionMetadata.reduce((total, item) => total + item.bytes, 0);
  const capacity = await pendingCapacity(runtimeRoot);
  const pendingCount = capacity.normalCount + capacity.dispositionCount;
  const pendingBytes = capacity.normalBytes + capacity.dispositionBytes;
  const utilization = Math.max(
    pendingCount / captureInboxMaximumPendingEntries,
    pendingBytes / captureInboxMaximumPendingBytes
  );
  return {
    pendingCount,
    normalEventCount: summary.pendingCount,
    dispositionCount: dispositionFiles.length,
    quarantineCount: summary.quarantineCount,
    maximumPendingCount: captureInboxMaximumPendingEntries,
    maximumPendingBytes: captureInboxMaximumPendingBytes,
    capacityState: utilization >= 1
      ? "full"
      : utilization >= 0.9
        ? "critical"
        : utilization >= 0.75
          ? "warning"
          : "available",
    pendingBytes,
    totalBytes: summary.totalBytes + dispositionBytes,
    oldestPendingAt: [
      summary.oldestPendingAt,
      ...dispositionMetadata.map((item) => item.capturedAt)
    ].filter((value): value is string => value !== null).sort()[0] ?? null
  };
}

export async function importCaptureInboxBatch(request: {
  readonly runtimeRoot: string;
  readonly importedAt: string;
  readonly maximumEntries: number;
  readonly maximumMilliseconds: number;
}): Promise<{
  readonly state: "empty" | "imported" | "quarantined" | "deferred";
  readonly importedCount: number;
  readonly quarantinedCount: number;
  readonly remainingCount: number;
}> {
  if (!Number.isInteger(request.maximumEntries) || request.maximumEntries <= 0) {
    throw new Error("Capture Inbox batch size must be a positive integer.");
  }
  if (!Number.isFinite(request.maximumMilliseconds) || request.maximumMilliseconds <= 0) {
    throw new Error("Capture Inbox time budget must be positive.");
  }
  const started = performance.now();
  let importedCount = 0;
  let quarantinedCount = 0;
  let deferred = false;
  for (let index = 0; index < request.maximumEntries; index += 1) {
    if (index > 0 && performance.now() - started >= request.maximumMilliseconds) break;
    const result = await importNextCaptureInboxEventFile({
      runtimeRoot: request.runtimeRoot,
      importedAt: request.importedAt
    });
    if (result.state === "empty") {
      const disposition = await importNextBodyFreeDisposition({ runtimeRoot: request.runtimeRoot });
      if (disposition === "empty") break;
      if (disposition === "deferred") {
        deferred = true;
        break;
      }
      if (disposition === "imported") importedCount += 1;
      else quarantinedCount += 1;
      continue;
    }
    if (result.state === "deferred") {
      deferred = true;
      break;
    }
    if (result.state === "imported") importedCount += 1;
    else quarantinedCount += 1;
  }
  const remainingCount = (await inspectCaptureInbox(request.runtimeRoot)).pendingCount;
  return {
    state: importedCount > 0
      ? "imported"
      : quarantinedCount > 0
        ? "quarantined"
        : deferred
          ? "deferred"
          : "empty",
    importedCount,
    quarantinedCount,
    remainingCount
  };
}
