# MemStore agent guide

## Start here

- Read [src/README.md](src/README.md) and the README for each module you will change. Read nested module guides when applicable; do not assume your host automatically loads them.
- Use [CONTEXT.md](CONTEXT.md) for terminology, [SPEC.md](SPEC.md) for product contracts and [docs/adr/](docs/adr/) for design history. Read relevant sections rather than loading every document into context.
- Inspect the current checkout and preserve existing work. These instructions do not grant permission to commit, push, install, migrate or modify a user's live knowledge.

## Implementation boundaries

- Keep code, canonical Vault data and machine-local runtime state separate. Never use an installed Vault/runtime as test fixtures.
- Preserve Human authority, project scope, provenance, revision checks and preview/apply boundaries. Model confidence does not override these rules.
- Keep hook startup lightweight. Background model extraction and index construction must not become synchronous hook work.
- Preserve durable queue idempotency, leases and recoverable failure state. Successful coverage must follow persisted completion.
- Treat canonical Markdown writes, schema migrations, host configuration changes and physical deletion as distinct side effects. Use the owning module's supported operations.
- Preserve configured model, reasoning and service-tier choices unless the task explicitly changes them. Tests with mocked models do not establish semantic quality.
- Prefer small modules and existing dependencies. Do not duplicate domain policy in CLI, MCP or host adapters.

## Checks

Use the Node and pnpm versions declared in [package.json](package.json). From the repository root:

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Run focused tests from the module guide while iterating. Evidence tests are a separate `pnpm test:evidence` suite; inspect its fixtures and prerequisites before using it. Do not run live model experiments, installation or destructive maintenance solely to verify a documentation change.

## Documentation maintenance

- Update a module README when its responsibilities, entry points, data ownership, invariants or validation paths change.
- Keep architecture explanations in module READMEs and behavioral instructions here. Add nested AGENTS.md only for genuinely different local working rules.
- Link to source and decisions; avoid copying entire schemas, policies or function listings.
- Use repository-relative links and portable example paths. Do not record credentials, local account details, machine-specific paths or transient runtime statistics.
- Keep temporary work in the enclosing workspace's designated temporary directory; do not commit experimental artifacts.
