import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

import { writeFileAtomically } from "../contracts/atomic-file.js";
import { openRuntimeDatabaseReadOnly } from "../runtime/database.js";

const routeSchema = z.object({
  schemaVersion: z.literal(1),
  sessionId: z.string().min(1),
  projectId: z.string().regex(/^msproj_[0-9a-f-]{36}$/u),
  displayName: z.string().min(1),
  updatedAt: z.iso.datetime()
});

function routePath(runtimeRoot: string, sessionId: string): string {
  const key = createHash("sha256").update(sessionId).digest("hex");
  return join(runtimeRoot, "state", "session-projects", `${key}.json`);
}

/** Exact thread identity only: never inherit a parent thread or process environment. */
export async function readSessionProjectRoute(runtimeRoot: string, sessionId: string) {
  let source: string;
  try {
    source = await readFile(routePath(runtimeRoot, sessionId), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  const route = routeSchema.parse(JSON.parse(source));
  if (route.sessionId !== sessionId) throw new Error("Session route identity mismatch.");
  return route;
}

export async function setSessionProjectRoute(request: {
  readonly runtimeRoot: string;
  readonly sessionId: string;
  readonly projectId: string;
}) {
  const database = await openRuntimeDatabaseReadOnly(request.runtimeRoot);
  let displayName: string;
  try {
    const project = z.object({ display_name: z.string().min(1) }).parse(database.prepare(
      "SELECT display_name FROM projects WHERE project_id = ?"
    ).get(request.projectId));
    displayName = project.display_name;
  } finally {
    database.close();
  }
  const route = routeSchema.parse({
    schemaVersion: 1, sessionId: request.sessionId, projectId: request.projectId,
    displayName, updatedAt: new Date().toISOString()
  });
  const path = routePath(request.runtimeRoot, request.sessionId);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFileAtomically(path, `${JSON.stringify(route, null, 2)}\n`, 0o600);
  return route;
}
