# Bind the managed CLI to installed machine roots

The global MemStore Skills invoke the managed `memstore` CLI from arbitrary
working directories. Codex MCP and Hook environment variables are scoped to
their own child processes, so they cannot configure a separate CLI invocation.

The managed CLI wrapper now supplies the installation's machine-local Runtime
and Vault roots when the corresponding environment variables are empty. A
caller can still override either root with a non-empty environment variable,
and explicit CLI flags retain their existing highest precedence. The portable
Skill therefore remains free of machine-specific absolute paths.

Install writes the configured wrapper. Repair and reviewed upgrade replace an
older wrapper recipe only while the current file still matches the ownership
manifest; a user-modified wrapper remains a divergence that MemStore refuses to
overwrite. The manifest is updated to the new expected identity after repair or
upgrade, so subsequent repair is idempotently healthy.

This configuration binding does not move or copy Canonical Memory Data. It only
connects the installed command surface to the already configured machine-local
paths.

---
status: accepted
---
