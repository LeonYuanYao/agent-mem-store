# Canonical Markdown schema

Current notes use these identity-stable paths:

```text
Memories/Global/<memory-id>.md
Memories/Projects/<project-id>/<memory-id>.md
```

Immutable revisions use:

```text
_MemStore/Revisions/<memory-id>/<revision-id>.md
```

Each file is UTF-8 Markdown with YAML frontmatter. MemStore owns only the
top-level `memstore` object and preserves other top-level properties byte for
byte when it rewrites a compatible note. Compatible unknown fields are also
preserved recursively inside `memstore`, including inside known nested objects.
The exception is conversion to a Tombstone: unknown fields inside `memstore`
are dropped because a future or legacy excerpt field could retain deleted
knowledge. Unowned top-level Human frontmatter remains untouched, and any Secret
there causes the final rendered write to stop rather than deleting Human data.

The owned object records:

- schema, Memory identity, revision identity, content identity, policy version,
  creation time, and revision time;
- Project or Global scope, Human-authored or Agent-derived authority, origin,
  normal/private sensitivity, one controlled primary category, validated
  controlled category tags, importance tags, and startup policy;
- lifecycle state and archive/tombstone time plus reason where required;
- applicability summary and conditions, validity state and optional interval;
- a versioned Semantic Contract containing claims, conditions, exclusions, and
  preserved negations;
- compact and standard representations with validation state, generator
  identity, source revision identity, and rendered token count;
- portable provenance, Injection Receipt references, typed relationships, and
  optional predecessor/successor Memory or revision identities.

The Markdown body is the human-readable Canonical statement. Direct body edits
reconcile to a new `human_authored` / `manual_edit` revision. Existing compact
and standard representations become unvalidated until later processing. An
unreconciled Human edit prevents an Agent revision from mutating the note. The
core write request also names its Human or Agent actor: actor and declared
authority must agree, and an Agent actor cannot revise Human-authored Memory.
Every non-initial revision names the prior revision in portable frontmatter;
manual reconciliation and rebuild generate that link automatically.
Scope is identity-bearing and immutable through ordinary writes or Obsidian
reconciliation. Moving knowledge between Projects or between Project and Global
requires a future explicit migration operation; changing frontmatter alone is
rejected without creating a second Canonical file.

`content_identity` is computed from normalized owned `memstore` metadata (apart
from the identity field itself) and the Markdown body. It does not change for
formatting or properties outside the owned namespace. The raw whole-file hash
is a separate internal atomic-write precondition and is not portable Canonical
metadata.

Secret is not a representable Canonical sensitivity. Archived and tombstone
states require an explicit time and reason. A Tombstone carries no body,
representation text, applicability text, importance tags, relationship edges,
or Semantic Contract content; its structural representation envelopes remain
empty and unvalidated. Destructive purge is outside the Gate 3 implementation.
