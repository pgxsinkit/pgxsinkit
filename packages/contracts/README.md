# @pgxsinkit/contracts

Shared contracts for [pgxsinkit](https://pgxsinkit.github.io): the sync registry
(`defineSyncTable` / `defineSyncRegistry`), the transport DTOs both the read and write
paths use, the registry fingerprint and diff gate, and the SQL identifier resolver.

Install it always — every other `@pgxsinkit/*` package builds on it.

```bash
bun add @pgxsinkit/contracts
```

See the [documentation](https://pgxsinkit.github.io) for the full model and API.
