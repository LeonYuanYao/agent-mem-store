---
status: accepted
---

# Register roots below the catch-all Project, and let a machine stop dreaming it

A non-Git directory resolves to the deepest registered root above it. Once a Session
starts in the home directory, the home directory becomes a registered root, and from
then on every unregistered non-Git directory below it resolves to that one catch-all
Project. Dreaming keeps only global knowledge from it (`tier.ts`), so Project
knowledge from those directories is extracted, paid for and dropped.

On one machine, 80 Sessions in three weeks resolved to the catch-all Project. At
least 47 ran in the per-instance workspaces an editor creates under its application
support directory; the rest came from a one-off experiment directory, a desktop
client's per-chat folders and an unversioned folder. Of 92 candidates dreaming
extracted from them in six nights, 73 described the editor's workflows and none was
global, at about 1.2 million tokens.

A `.memstore-project` marker cannot fix this alone: dreaming schedules a Project only
when it has a registered root, and a marker writes no Registry entry. Writing a
marker into another application's support directory is also intrusive.

Decision:

- `memstore project register --path <dir> [--name <name>] [--preview]` creates a new
  Project whose non-Git root is `<dir>`. It applies only when `<dir>` currently
  resolves through an enclosing registered root other than itself; Git directories,
  markers and directories that would register themselves anyway are refused with
  `register_not_applicable`. Descendants resolve to the new root by the existing
  deepest-root rule; nothing else changes resolution.
- `--name` sets the Project name (default: the directory name). Dream reports, the
  overview and the digest show a name only when it differs from the directory name,
  so existing Projects keep their labels and report file names.
- `[dreaming].catch_all_projects` (machine-local boolean, default `true`) decides
  whether scheduled runs are created for a catch-all Project. With `false` its
  Sessions are still captured, served injections and available to
  `memstore remember extract` and `memstore dream run`, but the nightly schedule
  skips them.

Consequences:

- Sessions already captured under the catch-all Project stay there; only new
  Sessions in a registered directory resolve to its Project.
- `relink-root` moves a registered root. Removing one is not exposed.
- Turning the catch-all off also stops the small amount of global knowledge it could
  yield; a user who works from the home directory keeps the default.
