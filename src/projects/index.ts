import { access, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { DatabaseSync } from "node:sqlite";

import { openRuntimeDatabase } from "../runtime/database.js";
import { readSessionProjectRoute } from "./session-route.js";
import {
  writeFileAtomically,
  writeFileAtomicallyExclusive
} from "../contracts/atomic-file.js";

const execFileAsync = promisify(execFile);

const projectId = z.string().regex(
  /^msproj_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
);

const markerSchema = z.object({
  schema_version: z.literal(1),
  project_id: projectId,
  display_name: z.string().min(1).optional()
});

export interface ProjectResolutionRequest {
  readonly sessionId?: string;
  readonly path: string;
  readonly runtimeRoot: string;
  readonly busyTimeoutMilliseconds?: number;
}

export interface SubmoduleProjectOverrideNotice {
  readonly kind: "submodule_project_override";
  readonly selectedProjectId: string;
  readonly inheritedProjectId: string;
  readonly markerPath: string;
}

export type ProjectNotice = SubmoduleProjectOverrideNotice;

export type ProjectResolution =
  | {
      readonly status: "resolved";
      readonly projectId: string;
      readonly displayName: string;
      readonly source:
        | "marker"
        | "session_override"
        | "registered_root"
        | "git"
        | "inherited_submodule";
      readonly root: string;
      readonly notices: readonly ProjectNotice[];
    }
  | {
      readonly status: "unresolved";
      readonly reason: "invalid_marker";
      readonly markerPath: string;
      readonly globalMemoryAvailable: true;
    }
  | {
      readonly status: "unresolved";
      readonly reason: "ambiguous_git_collision";
      readonly basenameKey: string;
      readonly globalMemoryAvailable: true;
    }
  | {
      readonly status: "unresolved";
      readonly reason: "unregistered_project";
      readonly root: string;
      readonly globalMemoryAvailable: true;
    };

export interface ProjectCollision {
  readonly basenameKey: string;
  readonly firstProjectId: string;
  readonly secondProjectId: string;
  readonly state: "unresolved" | "resolved";
}

export interface ConfigureProjectMarkerRequest {
  readonly root: string;
  readonly projectId: string;
  readonly displayName?: string;
  readonly preview: boolean;
  readonly expectedContentIdentity?: string | null;
}

export interface ConfigureProjectMarkerResult {
  readonly state: "preview" | "applied";
  readonly targetPath: string;
  readonly projectId: string;
  readonly currentContentIdentity: string | null;
  readonly nextContentIdentity: string;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export async function configureProjectMarker(
  request: ConfigureProjectMarkerRequest
): Promise<ConfigureProjectMarkerResult> {
  const canonicalRoot = await realpath(request.root);
  const targetPath = join(canonicalRoot, ".memstore-project");
  const currentSource = (await isFile(targetPath))
    ? await readFile(targetPath, "utf8")
    : undefined;
  const currentDocument = currentSource === undefined
    ? {}
    : z.record(z.string(), z.unknown()).parse(JSON.parse(currentSource) as unknown);
  const marker = markerSchema.loose().parse({
    ...currentDocument,
    schema_version: 1,
    project_id: request.projectId,
    ...(request.displayName === undefined
      ? {}
      : { display_name: request.displayName })
  });
  const source = `${JSON.stringify(marker, null, 2)}\n`;
  const currentContentIdentity =
    currentSource === undefined
      ? null
      : createHash("sha256").update(currentSource).digest("hex");
  const nextContentIdentity = createHash("sha256").update(source).digest("hex");

  if (request.preview) {
    return {
      state: "preview",
      targetPath,
      projectId: marker.project_id,
      currentContentIdentity,
      nextContentIdentity
    };
  }
  if (
    request.expectedContentIdentity === undefined ||
    request.expectedContentIdentity !== currentContentIdentity
  ) {
    throw new Error("Project marker changed after preview.");
  }
  if (currentContentIdentity === null) {
    await writeFileAtomicallyExclusive(targetPath, source, 0o600);
  } else {
    await writeFileAtomically(targetPath, source, 0o600, currentContentIdentity);
  }
  return {
    state: "applied",
    targetPath,
    projectId: marker.project_id,
    currentContentIdentity,
    nextContentIdentity
  };
}

async function gitValue(path: string, arguments_: readonly string[], signal?: AbortSignal): Promise<string | undefined> {
  signal?.throwIfAborted();
  try {
    const result = await execFileAsync("git", ["-C", path, ...arguments_], {
      encoding: "utf8",
      ...(signal === undefined ? {} : { signal, killSignal: "SIGKILL" })
    });
    const value = result.stdout.trim();
    return value.length === 0 ? undefined : value;
  } catch {
    signal?.throwIfAborted();
    return undefined;
  }
}

async function normalizeOrigin(
  origin: string | undefined,
  repositoryRoot: string
): Promise<string | undefined> {
  if (origin === undefined) {
    return undefined;
  }

  if (isAbsolute(origin) || origin.startsWith("./") || origin.startsWith("../")) {
    const localPath = isAbsolute(origin) ? origin : resolve(repositoryRoot, origin);
    try {
      return `file://${await realpath(localPath)}`;
    } catch {
      return `file://${resolve(localPath)}`;
    }
  }

  const scpMatch = /^(?:[^@]+@)?([^:]+):(.+)$/u.exec(origin);
  const candidate =
    scpMatch?.[1] === undefined || scpMatch[2] === undefined
      ? origin
      : `ssh://${scpMatch[1]}/${scpMatch[2]}`;
  try {
    const url = new URL(candidate);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    if (
      (url.protocol === "ssh:" && url.port === "22") ||
      (url.protocol === "https:" && url.port === "443") ||
      (url.protocol === "http:" && url.port === "80")
    ) {
      url.port = "";
    }
    url.pathname = url.pathname.replace(/\/$/u, "").replace(/\.git$/u, "");
    return url.toString().replace(/\/$/u, "");
  } catch {
    return undefined;
  }
}

interface GitEvidence {
  readonly repositoryRoot: string;
  readonly commonDirectory: string;
  readonly originIdentity: string | undefined;
  readonly basenameKey: string;
  readonly evidenceKey: string;
  readonly inheritedSubmodule: boolean;
}

async function inspectGit(path: string, signal?: AbortSignal): Promise<GitEvidence | undefined> {
  const topLevel = await gitValue(path, ["rev-parse", "--show-toplevel"], signal);
  if (topLevel === undefined) {
    return undefined;
  }
  const initialRoot = await realpath(topLevel);
  let repositoryRoot = initialRoot;
  let superproject = await gitValue(repositoryRoot, [
    "rev-parse",
    "--show-superproject-working-tree"
  ], signal);
  while (superproject !== undefined) {
    repositoryRoot = await realpath(superproject);
    superproject = await gitValue(repositoryRoot, [
      "rev-parse",
      "--show-superproject-working-tree"
    ], signal);
  }
  const commonDirectoryValue = await gitValue(repositoryRoot, [
    "rev-parse",
    "--git-common-dir"
  ], signal);
  if (commonDirectoryValue === undefined) {
    return undefined;
  }
  const commonDirectory = await realpath(
    isAbsolute(commonDirectoryValue)
      ? commonDirectoryValue
      : join(repositoryRoot, commonDirectoryValue)
  );
  const originIdentity = await normalizeOrigin(
    await gitValue(repositoryRoot, ["remote", "get-url", "origin"], signal),
    repositoryRoot
  );
  const basenameKey = basename(repositoryRoot).normalize("NFC");
  const evidenceKey = createHash("sha256")
    .update(`${commonDirectory}\0${originIdentity ?? ""}\0${basenameKey}`)
    .digest("hex");
  return {
    repositoryRoot,
    commonDirectory,
    originIdentity,
    basenameKey,
    evidenceKey,
    inheritedSubmodule: repositoryRoot !== initialRoot
  };
}

async function existingRuntimeDatabasePath(runtimeRoot: string): Promise<string | undefined> {
  const path = join(runtimeRoot, "state", "memstore.sqlite");
  try {
    await access(path);
    return path;
  } catch {
    return undefined;
  }
}

async function inspectSessionRoute(request: ProjectResolutionRequest): Promise<ProjectResolution | undefined> {
  if (request.sessionId === undefined) return undefined;
  const route = await readSessionProjectRoute(request.runtimeRoot, request.sessionId);
  if (route === undefined) return undefined;
  return {
    status: "resolved", projectId: route.projectId, displayName: route.displayName,
    source: "session_override", root: resolve(request.path), notices: []
  };
}

/** Resolve Project identity without creating or updating Registry state. */
export async function inspectProject(
  request: ProjectResolutionRequest & { readonly signal?: AbortSignal }
): Promise<ProjectResolution> {
  request.signal?.throwIfAborted();
  const routed = await inspectSessionRoute(request);
  request.signal?.throwIfAborted();
  if (routed !== undefined) return routed;
  const resolvedPath = await realpath(request.path);
  let markerSearchPath = resolvedPath;
  const filesystemRoot = parse(markerSearchPath).root;

  let searchingForMarker = true;
  while (searchingForMarker) {
    request.signal?.throwIfAborted();
    const markerPath = join(markerSearchPath, ".memstore-project");
    if (await isFile(markerPath)) {
      try {
        const marker = markerSchema.parse(
          JSON.parse(await readFile(markerPath, "utf8")) as unknown
        );
        const git = await inspectGit(markerSearchPath, request.signal);
        const notices: ProjectNotice[] = [];
        if (git?.inheritedSubmodule === true) {
          const inherited = await inspectProject({
            path: git.repositoryRoot,
            runtimeRoot: request.runtimeRoot,
            ...(request.signal === undefined ? {} : { signal: request.signal })
          });
          if (inherited.status === "resolved") {
            notices.push({
              kind: "submodule_project_override",
              selectedProjectId: marker.project_id,
              inheritedProjectId: inherited.projectId,
              markerPath
            });
          }
        }
        return {
          status: "resolved",
          projectId: marker.project_id,
          displayName: marker.display_name ?? (basename(markerSearchPath) || markerSearchPath),
          source: "marker",
          root: markerSearchPath,
          notices
        };
      } catch {
        request.signal?.throwIfAborted();
        return {
          status: "unresolved",
          reason: "invalid_marker",
          markerPath,
          globalMemoryAvailable: true
        };
      }
    }
    if (markerSearchPath === filesystemRoot) {
      searchingForMarker = false;
    } else {
      markerSearchPath = dirname(markerSearchPath);
    }
  }

  const databasePath = await existingRuntimeDatabasePath(request.runtimeRoot);
  request.signal?.throwIfAborted();
  if (databasePath === undefined) {
    return {
      status: "unresolved",
      reason: "unregistered_project",
      root: resolvedPath,
      globalMemoryAvailable: true
    };
  }

  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const git = await inspectGit(resolvedPath, request.signal);
    request.signal?.throwIfAborted();
    if (git !== undefined) {
      const match = database.prepare(
        `SELECT p.project_id, p.display_name
         FROM project_git_evidence e
         JOIN projects p ON p.project_id = e.project_id
         WHERE e.common_directory = ?
            OR (? IS NOT NULL AND e.origin_identity = ? AND e.basename_key = ?)
         ORDER BY e.last_used_at DESC LIMIT 1`
      ).get(
        git.commonDirectory,
        git.originIdentity ?? null,
        git.originIdentity ?? null,
        git.basenameKey
      );
      if (match !== undefined) {
        return {
          status: "resolved",
          projectId: z.string().parse(match.project_id),
          displayName: z.string().parse(match.display_name),
          source: git.inheritedSubmodule ? "inherited_submodule" : "git",
          root: git.repositoryRoot,
          notices: []
        };
      }
      const sameBasename = database.prepare(
        `SELECT origin_identity FROM project_git_evidence
         WHERE basename_key = ? ORDER BY created_at ASC LIMIT 1`
      ).get(git.basenameKey);
      if (
        sameBasename !== undefined &&
        (typeof sameBasename.origin_identity !== "string" || git.originIdentity === undefined)
      ) {
        return {
          status: "unresolved",
          reason: "ambiguous_git_collision",
          basenameKey: git.basenameKey,
          globalMemoryAvailable: true
        };
      }
      return {
        status: "unresolved",
        reason: "unregistered_project",
        root: git.repositoryRoot,
        globalMemoryAvailable: true
      };
    }

    const registered = database.prepare(
      `SELECT r.canonical_root, p.project_id, p.display_name
       FROM project_roots r JOIN projects p ON p.project_id = r.project_id
       ORDER BY length(r.canonical_root) DESC`
    ).all().find((row) =>
      typeof row.canonical_root === "string" &&
      (resolvedPath === row.canonical_root || resolvedPath.startsWith(`${row.canonical_root}${sep}`))
    );
    if (registered !== undefined) {
      return {
        status: "resolved",
        projectId: z.string().parse(registered.project_id),
        displayName: z.string().parse(registered.display_name),
        source: "registered_root",
        root: z.string().parse(registered.canonical_root),
        notices: []
      };
    }
    return {
      status: "unresolved",
      reason: "unregistered_project",
      root: resolvedPath,
      globalMemoryAvailable: true
    };
  } finally {
    database.close();
  }
}

export async function resolveProject(
  request: ProjectResolutionRequest
): Promise<ProjectResolution> {
  const routed = await inspectSessionRoute(request);
  if (routed !== undefined) return routed;
  const resolvedPath = await realpath(request.path);
  let markerSearchPath = resolvedPath;
  const filesystemRoot = parse(markerSearchPath).root;

  let searchingForMarker = true;
  while (searchingForMarker) {
    const markerPath = join(markerSearchPath, ".memstore-project");
    if (await isFile(markerPath)) {
      try {
        const markerDocument = JSON.parse(
          await readFile(markerPath, "utf8")
        ) as unknown;
        const marker = markerSchema.parse(markerDocument);
        const git = await inspectGit(markerSearchPath);
        const notices: ProjectNotice[] = [];
        if (git?.inheritedSubmodule === true) {
          const inherited = await resolveProject({
            path: git.repositoryRoot,
            runtimeRoot: request.runtimeRoot,
            ...(request.busyTimeoutMilliseconds === undefined
              ? {}
              : { busyTimeoutMilliseconds: request.busyTimeoutMilliseconds })
          });
          if (inherited.status === "resolved") {
            notices.push({
              kind: "submodule_project_override",
              selectedProjectId: marker.project_id,
              inheritedProjectId: inherited.projectId,
              markerPath
            });
          }
        }
        return {
          status: "resolved",
          projectId: marker.project_id,
          displayName:
            marker.display_name ?? (basename(markerSearchPath) || markerSearchPath),
          source: "marker",
          root: markerSearchPath,
          notices
        };
      } catch {
        return {
          status: "unresolved",
          reason: "invalid_marker",
          markerPath,
          globalMemoryAvailable: true
        };
      }
    }

    if (markerSearchPath === filesystemRoot) {
      searchingForMarker = false;
    } else {
      markerSearchPath = dirname(markerSearchPath);
    }
  }

  const database = await openRuntimeDatabase(
    request.runtimeRoot,
    request.busyTimeoutMilliseconds === undefined
      ? {}
      : { busyTimeoutMilliseconds: request.busyTimeoutMilliseconds }
  );
  try {
    const git = await inspectGit(resolvedPath);
    if (git !== undefined) {
      const match = database
        .prepare(
          `SELECT p.project_id, p.display_name, e.common_directory
           FROM project_git_evidence e
           JOIN projects p ON p.project_id = e.project_id
           WHERE e.common_directory = ?
              OR (? IS NOT NULL AND e.origin_identity = ? AND e.basename_key = ?)
           ORDER BY CASE WHEN e.common_directory = ? THEN 0 ELSE 1 END,
                    e.last_used_at DESC
           LIMIT 1`
        )
        .get(
          git.commonDirectory,
          git.originIdentity ?? null,
          git.originIdentity ?? null,
          git.basenameKey,
          git.commonDirectory
        );
      if (match?.common_directory === git.commonDirectory) {
        const projectId = z.string().parse(match.project_id);
        const displayName = z.string().parse(match.display_name);
        return {
          status: "resolved",
          projectId,
          displayName,
          source: git.inheritedSubmodule ? "inherited_submodule" : "git",
          root: git.repositoryRoot,
          notices: []
        };
      }
      const sameBasename = database
        .prepare(
          `SELECT project_id, origin_identity
           FROM project_git_evidence
           WHERE basename_key = ?
           ORDER BY created_at ASC
           LIMIT 1`
        )
        .get(git.basenameKey);
      const now = new Date().toISOString();
      let selectedProjectId: string;
      let selectedDisplayName: string;

      if (match === undefined && sameBasename !== undefined) {
        const registeredOrigin = sameBasename.origin_identity;
        if (
          typeof registeredOrigin !== "string" ||
          git.originIdentity === undefined
        ) {
          return {
            status: "unresolved",
            reason: "ambiguous_git_collision",
            basenameKey: git.basenameKey,
            globalMemoryAvailable: true
          };
        }
      }

      database.exec("BEGIN IMMEDIATE");
      try {
        if (match === undefined) {
          selectedProjectId = `msproj_${randomUUID()}`;
          selectedDisplayName = git.basenameKey;
          database
            .prepare(
              `INSERT INTO projects(project_id, display_name, created_at, last_used_at)
               VALUES (?, ?, ?, ?)`
            )
            .run(selectedProjectId, selectedDisplayName, now, now);
        } else {
          const matchedProjectId = match.project_id;
          const matchedDisplayName = match.display_name;
          if (
            typeof matchedProjectId !== "string" ||
            typeof matchedDisplayName !== "string"
          ) {
            throw new Error("Git Project Registry contains invalid data.");
          }
          selectedProjectId = matchedProjectId;
          selectedDisplayName = matchedDisplayName;
          database
            .prepare("UPDATE projects SET last_used_at = ? WHERE project_id = ?")
            .run(now, selectedProjectId);
        }

        database
          .prepare(
            `INSERT INTO project_roots(
               canonical_root, project_id, root_kind, created_at, last_used_at
             ) VALUES (?, ?, 'git', ?, ?)
             ON CONFLICT(canonical_root) DO UPDATE SET
               project_id = excluded.project_id,
               root_kind = 'git',
               last_used_at = excluded.last_used_at`
          )
          .run(git.repositoryRoot, selectedProjectId, now, now);
        database
          .prepare(
            `INSERT INTO project_git_evidence(
               evidence_key, project_id, common_directory, origin_identity,
               basename_key, created_at, last_used_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(evidence_key) DO UPDATE SET
               project_id = excluded.project_id,
               last_used_at = excluded.last_used_at`
          )
          .run(
            git.evidenceKey,
            selectedProjectId,
            git.commonDirectory,
            git.originIdentity ?? null,
            git.basenameKey,
            now,
            now
          );
        if (match === undefined && sameBasename !== undefined) {
          const firstProjectId = sameBasename.project_id;
          const firstOriginIdentity = sameBasename.origin_identity;
          if (
            typeof firstProjectId === "string" &&
            typeof firstOriginIdentity === "string" &&
            git.originIdentity !== undefined &&
            firstOriginIdentity !== git.originIdentity
          ) {
            database
              .prepare(
                `INSERT INTO project_collisions(
                   collision_id, basename_key, first_project_id,
                   second_evidence_key, state, created_at
                 ) VALUES (?, ?, ?, ?, 'unresolved', ?)`
              )
              .run(
                `mscollision_${randomUUID()}`,
                git.basenameKey,
                firstProjectId,
                git.evidenceKey,
                now
              );
          }
        }
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }

      return {
        status: "resolved",
        projectId: selectedProjectId,
        displayName: selectedDisplayName,
        source: git.inheritedSubmodule ? "inherited_submodule" : "git",
        root: git.repositoryRoot,
        notices: []
      };
    }

    const roots = database
      .prepare(
        `SELECT r.canonical_root, p.project_id, p.display_name
         FROM project_roots r
         JOIN projects p ON p.project_id = r.project_id
         ORDER BY length(r.canonical_root) DESC`
      )
      .all();
    const registered = roots.find((row) => {
      const root = row.canonical_root;
      return (
        typeof root === "string" &&
        (resolvedPath === root || resolvedPath.startsWith(`${root}${sep}`))
      );
    });

    if (registered !== undefined) {
      const registeredRoot = registered.canonical_root;
      const registeredProjectId = registered.project_id;
      const registeredDisplayName = registered.display_name;
      if (
        typeof registeredRoot !== "string" ||
        typeof registeredProjectId !== "string" ||
        typeof registeredDisplayName !== "string"
      ) {
        throw new Error("Project Registry contains invalid data.");
      }
      database
        .prepare("UPDATE projects SET last_used_at = ? WHERE project_id = ?")
        .run(new Date().toISOString(), registeredProjectId);
      return {
        status: "resolved",
        projectId: registeredProjectId,
        displayName: registeredDisplayName,
        source: "registered_root",
        root: registeredRoot,
        notices: []
      };
    }

    const now = new Date().toISOString();
    const generatedProjectId = `msproj_${randomUUID()}`;
    const displayName = basename(resolvedPath);
    database.exec("BEGIN IMMEDIATE");
    try {
      database
        .prepare(
          `INSERT INTO projects(project_id, display_name, created_at, last_used_at)
           VALUES (?, ?, ?, ?)`
        )
        .run(generatedProjectId, displayName, now, now);
      database
        .prepare(
          `INSERT INTO project_roots(
             canonical_root, project_id, root_kind, created_at, last_used_at
           ) VALUES (?, ?, 'non_git', ?, ?)`
        )
        .run(resolvedPath, generatedProjectId, now, now);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }

    return {
      status: "resolved",
      projectId: generatedProjectId,
      displayName,
      source: "registered_root",
      root: resolvedPath,
      notices: []
    };
  } finally {
    database.close();
  }
}

export async function listProjectCollisions(
  runtimeRoot: string
): Promise<readonly ProjectCollision[]> {
  const database = await openRuntimeDatabase(runtimeRoot);
  try {
    return database
      .prepare(
        `SELECT c.basename_key, c.first_project_id,
                e.project_id AS second_project_id, c.state
         FROM project_collisions c
         JOIN project_git_evidence e ON e.evidence_key = c.second_evidence_key
         ORDER BY c.created_at ASC`
      )
      .all()
      .map((row) => {
        if (
          typeof row.basename_key !== "string" ||
          typeof row.first_project_id !== "string" ||
          typeof row.second_project_id !== "string" ||
          (row.state !== "unresolved" && row.state !== "resolved")
        ) {
          throw new Error("Project collision Registry contains invalid data.");
        }
        return {
          basenameKey: row.basename_key,
          firstProjectId: row.first_project_id,
          secondProjectId: row.second_project_id,
          state: row.state
        };
      });
  } finally {
    database.close();
  }
}
