import { randomUUID } from "node:crypto";
import { access, realpath, rename } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";

import { MemStoreCommandError } from "../contracts/envelope.js";
import {
  configureProjectMarker,
  inspectProject,
  resolveProject
} from "../projects/index.js";

const projectIdSchema = z.string().regex(
  /^msproj_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
);

async function runtimeDatabasePath(runtimeRoot: string): Promise<string | undefined> {
  const path = join(runtimeRoot, "state", "memstore.sqlite");
  try {
    await access(path);
    return path;
  } catch {
    return undefined;
  }
}

export async function projectStatus(request: { readonly runtimeRoot: string; readonly path: string }) {
  return inspectProject(request);
}

export async function projectList(runtimeRoot: string): Promise<readonly unknown[]> {
  const path = await runtimeDatabasePath(runtimeRoot);
  if (path === undefined) return [];
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return database.prepare(
      `SELECT p.project_id, p.display_name, p.created_at, p.last_used_at,
              COUNT(r.canonical_root) AS root_count
       FROM projects p LEFT JOIN project_roots r ON r.project_id = p.project_id
       GROUP BY p.project_id ORDER BY p.display_name, p.project_id`
    ).all().map((row) => ({
      project_id: z.string().parse(row.project_id),
      display_name: z.string().parse(row.display_name),
      created_at: z.string().parse(row.created_at),
      last_used_at: z.string().parse(row.last_used_at),
      root_count: z.number().int().nonnegative().parse(row.root_count)
    }));
  } finally {
    database.close();
  }
}

export async function projectCollisions(runtimeRoot: string): Promise<readonly unknown[]> {
  const path = await runtimeDatabasePath(runtimeRoot);
  if (path === undefined) return [];
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return database.prepare(
      `SELECT c.collision_id, c.basename_key, c.first_project_id,
              e.project_id AS second_project_id, c.state, c.created_at
       FROM project_collisions c
       JOIN project_git_evidence e ON e.evidence_key = c.second_evidence_key
       ORDER BY c.created_at`
    ).all();
  } finally {
    database.close();
  }
}

async function resolveLinkTarget(request: {
  readonly runtimeRoot: string;
  readonly target: string;
}): Promise<string> {
  const parsed = projectIdSchema.safeParse(request.target);
  if (parsed.success) return parsed.data;
  const target = await resolveProject({
    path: resolve(request.target),
    runtimeRoot: request.runtimeRoot
  });
  if (target.status !== "resolved") {
    throw new MemStoreCommandError("link_target_unresolved", "The Project link target is unresolved.");
  }
  return target.projectId;
}

export async function projectLink(request: {
  readonly runtimeRoot: string;
  readonly path: string;
  readonly target: string;
  readonly preview: boolean;
}) {
  const root = await realpath(resolve(request.path));
  const before = await inspectProject({ path: root, runtimeRoot: request.runtimeRoot });
  const directProjectId = projectIdSchema.safeParse(request.target);
  if (request.preview && !directProjectId.success) {
    const targetResolution = await inspectProject({
      path: resolve(request.target),
      runtimeRoot: request.runtimeRoot
    });
    if (targetResolution.status !== "resolved") {
      return {
        dry_run: true,
        would_accept: targetResolution.reason === "unregistered_project",
        old_resolution: before,
        target_resolution: targetResolution,
        would_change: targetResolution.reason === "unregistered_project"
          ? ["target_project_registry_entry", "project_marker"]
          : [],
        warnings: targetResolution.reason === "unregistered_project"
          ? []
          : [{ code: "link_target_unresolved", reason: targetResolution.reason }]
      };
    }
    const markerPreview = await configureProjectMarker({
      root,
      projectId: targetResolution.projectId,
      preview: true
    });
    return {
      dry_run: true,
      would_accept: true,
      old_resolution: before,
      target_resolution: targetResolution,
      proposed_project_id: targetResolution.projectId,
      marker_effect: markerPreview
    };
  }
  const projectId = await resolveLinkTarget(request);
  const markerPreview = await configureProjectMarker({
    root,
    projectId,
    preview: true
  });
  if (request.preview) {
    return {
      dry_run: true,
      old_resolution: before,
      proposed_project_id: projectId,
      marker_effect: markerPreview
    };
  }
  const marker = await configureProjectMarker({
    root,
    projectId,
    preview: false,
    expectedContentIdentity: markerPreview.currentContentIdentity
  });
  return {
    dry_run: false,
    old_resolution: before,
    project_id: projectId,
    marker_effect: marker,
    resolution: await inspectProject({ path: root, runtimeRoot: request.runtimeRoot })
  };
}

export async function projectUnlink(request: {
  readonly runtimeRoot: string;
  readonly path: string;
  readonly preview: boolean;
  readonly now: string;
}) {
  const root = await realpath(resolve(request.path));
  const markerPath = join(root, ".memstore-project");
  try {
    await access(markerPath);
  } catch {
    throw new MemStoreCommandError("marker_not_found", "No Project marker exists at the selected root.");
  }
  const disabledPath = `${markerPath}.disabled.${request.now.replaceAll(/[:.]/gu, "-")}`;
  if (request.preview) {
    return { dry_run: true, would_rename: { from: markerPath, to: disabledPath } };
  }
  await rename(markerPath, disabledPath);
  return {
    dry_run: false,
    renamed: { from: markerPath, to: disabledPath },
    fallback_resolution: await inspectProject({ path: root, runtimeRoot: request.runtimeRoot })
  };
}

export async function projectRelinkRoot(request: {
  readonly runtimeRoot: string;
  readonly from: string;
  readonly to: string;
  readonly preview: boolean;
}) {
  const from = resolve(request.from);
  const to = await realpath(resolve(request.to));
  const databasePath = await runtimeDatabasePath(request.runtimeRoot);
  if (databasePath === undefined) throw new MemStoreCommandError("registry_unavailable", "Project Registry is unavailable.");
  const database = new DatabaseSync(databasePath);
  try {
    const row = database.prepare(
      "SELECT project_id, root_kind FROM project_roots WHERE canonical_root = ?"
    ).get(from);
    if (row === undefined || row.root_kind !== "non_git") {
      throw new MemStoreCommandError("non_git_root_not_found", "The old path is not a registered non-Git root.");
    }
    const result = {
      from,
      to,
      project_id: z.string().parse(row.project_id)
    };
    if (request.preview) return { dry_run: true, would_change: result };
    database.prepare(
      "UPDATE project_roots SET canonical_root = ?, last_used_at = ? WHERE canonical_root = ?"
    ).run(to, new Date().toISOString(), from);
    return { dry_run: false, changed: result };
  } finally {
    database.close();
  }
}

export async function projectResolveCollision(request: {
  readonly runtimeRoot: string;
  readonly path: string;
  readonly useProjectId?: string;
  readonly separate: boolean;
  readonly preview: boolean;
}) {
  if ((request.useProjectId === undefined) === !request.separate) {
    throw new MemStoreCommandError("collision_choice_required", "Choose exactly one of --use or --separate.");
  }
  const selectedProjectId = request.separate
    ? `msproj_${randomUUID()}`
    : projectIdSchema.parse(request.useProjectId);
  const linked = await projectLink({
    runtimeRoot: request.runtimeRoot,
    path: request.path,
    target: selectedProjectId,
    preview: request.preview
  });
  if (!request.preview) {
    const databasePath = await runtimeDatabasePath(request.runtimeRoot);
    if (databasePath !== undefined) {
      const database = new DatabaseSync(databasePath);
      try {
        database.prepare(
          `UPDATE project_collisions SET state = 'resolved', resolved_at = ?
           WHERE basename_key = ? AND state = 'unresolved'`
        ).run(new Date().toISOString(), basename(await realpath(resolve(request.path))));
      } finally {
        database.close();
      }
    }
  }
  return linked;
}
