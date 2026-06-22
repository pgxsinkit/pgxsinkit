# @pgxsinkit/client

The [pgxsinkit](https://pgxsinkit.github.io) client: `createSyncClient` stages writes
into a local PGlite overlay and a durable mutation journal, flushes them to the write
API, and subscribes to Electric shapes that land in local PGlite.

```bash
bun add @pgxsinkit/client @pgxsinkit/contracts
```

See the [documentation](https://pgxsinkit.github.io) for the read and write paths.
