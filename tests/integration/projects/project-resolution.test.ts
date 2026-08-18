import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { afterEach, expect, test } from "vitest";

import {
  configureProjectMarker,
  listProjectCollisions,
  resolveProject
} from "../../../src/projects/index.js";
import { openRuntimeDatabase } from "../../../src/runtime/database.js";

const temporaryDirectories: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

test("the nearest valid marker defines Project identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-project-marker-"));
  temporaryDirectories.push(root);
  const projectRoot = join(root, "project");
  const workingDirectory = join(projectRoot, "src", "feature");
  const runtimeRoot = join(root, "runtime");
  await mkdir(workingDirectory, { recursive: true });
  await writeFile(
    join(projectRoot, ".memstore-project"),
    JSON.stringify({
      schema_version: 1,
      project_id: "msproj_123e4567-e89b-42d3-a456-426614174000",
      display_name: "Shared Project"
    }),
    "utf8"
  );

  const result = await resolveProject({ path: workingDirectory, runtimeRoot });
  const canonicalProjectRoot = await realpath(projectRoot);

  expect(result).toEqual({
    status: "resolved",
    projectId: "msproj_123e4567-e89b-42d3-a456-426614174000",
    displayName: "Shared Project",
    source: "marker",
    root: canonicalProjectRoot,
    notices: []
  });
});

test("an explicit Project marker operation previews without mutation and applies with CAS", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-project-marker-operation-"));
  temporaryDirectories.push(root);
  const projectRoot = join(root, "workspace");
  await mkdir(projectRoot, { recursive: true });
  const markerPath = join(await realpath(projectRoot), ".memstore-project");
  const selectedProjectId = "msproj_123e4567-e89b-42d3-a456-426614174099";

  const preview = await configureProjectMarker({
    root: projectRoot,
    projectId: selectedProjectId,
    displayName: "Shared Workspace",
    preview: true
  });
  await expect(access(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
  const applied = await configureProjectMarker({
    root: projectRoot,
    projectId: selectedProjectId,
    displayName: "Shared Workspace",
    preview: false,
    expectedContentIdentity: preview.currentContentIdentity
  });

  expect(preview).toMatchObject({ state: "preview", targetPath: markerPath });
  expect(applied).toMatchObject({ state: "applied", targetPath: markerPath });
  expect(JSON.parse(await readFile(markerPath, "utf8"))).toEqual({
    schema_version: 1,
    project_id: selectedProjectId,
    display_name: "Shared Workspace"
  });
});

test("an explicit Project marker update preserves unknown future fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-project-marker-future-"));
  temporaryDirectories.push(root);
  const projectRoot = join(root, "workspace");
  await mkdir(projectRoot, { recursive: true });
  const markerPath = join(projectRoot, ".memstore-project");
  await writeFile(markerPath, JSON.stringify({
    schema_version: 1,
    project_id: "msproj_123e4567-e89b-42d3-a456-426614174000",
    future_adapter: { enabled: true }
  }));
  const preview = await configureProjectMarker({
    root: projectRoot,
    projectId: "msproj_123e4567-e89b-42d3-a456-426614174099",
    preview: true
  });
  await configureProjectMarker({
    root: projectRoot,
    projectId: "msproj_123e4567-e89b-42d3-a456-426614174099",
    preview: false,
    expectedContentIdentity: preview.currentContentIdentity
  });

  expect(JSON.parse(await readFile(markerPath, "utf8"))).toMatchObject({
    project_id: "msproj_123e4567-e89b-42d3-a456-426614174099",
    future_adapter: { enabled: true }
  });
});

test("an invalid nearest marker blocks guessed Project memory", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-project-invalid-"));
  temporaryDirectories.push(root);
  const workingDirectory = join(root, "project", "src");
  const markerPath = join(root, "project", ".memstore-project");
  await mkdir(workingDirectory, { recursive: true });
  await writeFile(markerPath, "not-json", "utf8");

  const result = await resolveProject({
    path: workingDirectory,
    runtimeRoot: join(root, "runtime")
  });
  const canonicalMarkerPath = join(await realpath(join(root, "project")), ".memstore-project");

  expect(result).toEqual({
    status: "unresolved",
    reason: "invalid_marker",
    markerPath: canonicalMarkerPath,
    globalMemoryAvailable: true
  });
});

test("a non-Git directory registers once and descendants reuse the deepest root", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-project-nongit-"));
  temporaryDirectories.push(root);
  const projectRoot = join(root, "notes");
  const descendant = join(projectRoot, "area", "topic");
  const runtimeRoot = join(root, "runtime");
  await mkdir(descendant, { recursive: true });

  const first = await resolveProject({ path: projectRoot, runtimeRoot });
  const second = await resolveProject({ path: descendant, runtimeRoot });
  const canonicalProjectRoot = await realpath(projectRoot);

  expect(first).toMatchObject({
    status: "resolved",
    source: "registered_root",
    root: canonicalProjectRoot,
    displayName: "notes"
  });
  expect(first.status).toBe("resolved");
  expect(second).toEqual(first);
  if (first.status === "resolved") {
    expect(first.projectId).toMatch(
      /^msproj_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
    );
  }
});

test("same-basename non-Git roots remain different Projects", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-project-nongit-collision-"));
  temporaryDirectories.push(root);
  const firstRoot = join(root, "one", "workspace");
  const secondRoot = join(root, "two", "workspace");
  const runtimeRoot = join(root, "runtime");
  await Promise.all([
    mkdir(firstRoot, { recursive: true }),
    mkdir(secondRoot, { recursive: true })
  ]);

  const first = await resolveProject({ path: firstRoot, runtimeRoot });
  const second = await resolveProject({ path: secondRoot, runtimeRoot });

  expect(first.status).toBe("resolved");
  expect(second.status).toBe("resolved");
  if (first.status === "resolved" && second.status === "resolved") {
    expect(first.projectId).not.toBe(second.projectId);
  }
});

test("same-basename Git checkouts with the same origin share one Project", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-project-git-shared-"));
  temporaryDirectories.push(root);
  const remote = join(root, "remote.git");
  const firstRoot = join(root, "one", "workspace");
  const secondRoot = join(root, "two", "workspace");
  const runtimeRoot = join(root, "runtime");
  await execFileAsync("git", ["init", "--bare", remote]);
  await Promise.all([
    execFileAsync("git", ["clone", remote, firstRoot]),
    execFileAsync("git", ["clone", remote, secondRoot])
  ]);

  const first = await resolveProject({ path: firstRoot, runtimeRoot });
  const second = await resolveProject({ path: secondRoot, runtimeRoot });

  expect(first).toMatchObject({
    status: "resolved",
    source: "git",
    displayName: "workspace"
  });
  expect(second).toMatchObject({
    status: "resolved",
    source: "git",
    displayName: "workspace"
  });
  if (first.status === "resolved" && second.status === "resolved") {
    expect(second.projectId).toBe(first.projectId);
  }
});

test("an already registered Git root resolves without competing for the writer lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-project-git-read-fast-path-"));
  temporaryDirectories.push(root);
  const projectRoot = join(root, "workspace");
  const runtimeRoot = join(root, "runtime");
  await execFileAsync("git", ["init", projectRoot]);
  const first = await resolveProject({ path: projectRoot, runtimeRoot });

  const writer = await openRuntimeDatabase(runtimeRoot);
  try {
    writer.exec("BEGIN IMMEDIATE");
    await expect(resolveProject({
      path: projectRoot,
      runtimeRoot,
      busyTimeoutMilliseconds: 25
    })).resolves.toEqual(first);
    writer.exec("ROLLBACK");
  } finally {
    if (writer.isTransaction) writer.exec("ROLLBACK");
    writer.close();
  }
});

test("same-basename Git checkouts with different origins stay separate and record a collision", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-project-git-separate-"));
  temporaryDirectories.push(root);
  const firstRemote = join(root, "first.git");
  const secondRemote = join(root, "second.git");
  const firstRoot = join(root, "one", "workspace");
  const secondRoot = join(root, "two", "workspace");
  const runtimeRoot = join(root, "runtime");
  await Promise.all([
    execFileAsync("git", ["init", "--bare", firstRemote]),
    execFileAsync("git", ["init", "--bare", secondRemote])
  ]);
  await Promise.all([
    execFileAsync("git", ["clone", firstRemote, firstRoot]),
    execFileAsync("git", ["clone", secondRemote, secondRoot])
  ]);

  const first = await resolveProject({ path: firstRoot, runtimeRoot });
  const second = await resolveProject({ path: secondRoot, runtimeRoot });
  const collisions = await listProjectCollisions(runtimeRoot);

  expect(first.status).toBe("resolved");
  expect(second.status).toBe("resolved");
  if (first.status === "resolved" && second.status === "resolved") {
    expect(second.projectId).not.toBe(first.projectId);
    expect(collisions).toEqual([
      {
        basenameKey: "workspace",
        firstProjectId: first.projectId,
        secondProjectId: second.projectId,
        state: "unresolved"
      }
    ]);
  }
});

test("same-basename Git repositories without origins require an explicit marker", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-project-git-ambiguous-"));
  temporaryDirectories.push(root);
  const firstRoot = join(root, "one", "workspace");
  const secondRoot = join(root, "two", "workspace");
  const runtimeRoot = join(root, "runtime");
  await Promise.all([
    execFileAsync("git", ["init", firstRoot]),
    execFileAsync("git", ["init", secondRoot])
  ]);

  const first = await resolveProject({ path: firstRoot, runtimeRoot });
  const second = await resolveProject({ path: secondRoot, runtimeRoot });

  expect(first.status).toBe("resolved");
  expect(second).toEqual({
    status: "unresolved",
    reason: "ambiguous_git_collision",
    basenameKey: "workspace",
    globalMemoryAvailable: true
  });
});

test("a Git submodule inherits its parent until an explicit marker selects another Project", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-project-submodule-"));
  temporaryDirectories.push(root);
  const dependency = join(root, "dependency");
  const parent = join(root, "parent");
  const submodule = join(parent, "vendor", "dependency");
  const runtimeRoot = join(root, "runtime");
  await execFileAsync("git", ["init", dependency]);
  await writeFile(join(dependency, "README.md"), "dependency\n", "utf8");
  await execFileAsync(
    "git",
    [
      "-C",
      dependency,
      "-c",
      "user.name=MemStore Test",
      "-c",
      "user.email=memstore@example.invalid",
      "add",
      "README.md"
    ]
  );
  await execFileAsync(
    "git",
    [
      "-C",
      dependency,
      "-c",
      "user.name=MemStore Test",
      "-c",
      "user.email=memstore@example.invalid",
      "commit",
      "-m",
      "initial"
    ]
  );
  await execFileAsync("git", ["init", parent]);
  await execFileAsync("git", [
    "-c",
    "protocol.file.allow=always",
    "-C",
    parent,
    "submodule",
    "add",
    dependency,
    "vendor/dependency"
  ]);

  const parentResolution = await resolveProject({ path: parent, runtimeRoot });
  const submoduleResolution = await resolveProject({ path: submodule, runtimeRoot });

  expect(parentResolution.status).toBe("resolved");
  expect(submoduleResolution).toMatchObject({
    status: "resolved",
    source: "inherited_submodule",
    root: await realpath(parent),
    notices: []
  });
  if (
    parentResolution.status === "resolved" &&
    submoduleResolution.status === "resolved"
  ) {
    expect(submoduleResolution.projectId).toBe(parentResolution.projectId);
  }

  const selectedProjectId = "msproj_123e4567-e89b-42d3-a456-426614174001";
  const markerPath = join(submodule, ".memstore-project");
  await writeFile(
    markerPath,
    JSON.stringify({ schema_version: 1, project_id: selectedProjectId }),
    "utf8"
  );
  const overridden = await resolveProject({ path: submodule, runtimeRoot });

  expect(parentResolution.status).toBe("resolved");
  if (parentResolution.status === "resolved") {
    expect(overridden).toEqual({
      status: "resolved",
      projectId: selectedProjectId,
      displayName: "dependency",
      source: "marker",
      root: await realpath(submodule),
      notices: [
        {
          kind: "submodule_project_override",
          selectedProjectId,
          inheritedProjectId: parentResolution.projectId,
          markerPath: join(await realpath(submodule), ".memstore-project")
        }
      ]
    });
  }
});
