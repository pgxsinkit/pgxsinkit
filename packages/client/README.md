# @pgxsinkit/client

The [pgxsinkit](https://pgxsinkit.github.io) client: `createSyncClient` stages writes
into a local pgwasm overlay and a durable mutation journal, flushes them to the write
API, and subscribes through the read path's control plane to read durable-streams into
local pgwasm store.

```bash
bun add @pgxsinkit/client @pgxsinkit/contracts
```

See the [documentation](https://pgxsinkit.github.io) for the read and write paths.

## Browser storage and worker placement

`createSyncClient` is the in-process client. For browser apps, worker mode moves pgwasm off the
main thread with capability-driven placement (ADR-0049) as the default:

- real macOS/iOS Safari grants synchronous OPFS handles in a `SharedWorker`, so the engine runs there
  on the constant-four-handle `opfs-repacked` backend;
- Chromium and Firefox deny those handles in a `SharedWorker`, so Web Locks elect one tab-spawned
  dedicated engine worker (constructed automatically from the SharedWorker's own script URL);
- a missing `SharedWorker`, a platform with no OPFS capability in any home, or a registry that
  declares `storage: { backend: "idbfs" }` uses IndexedDB.

Pass `attachSyncClient` a SharedWorker factory (`worker: () => SharedWorker`) so SharedWorker-death
recovery is guaranteed; `createEngineWorker` is only an override for entries that cannot be
reconstructed from their URL. Storage is declared on the registry
(`storage: { backend, durability }`, defaults `opfs`/`relaxed`). Inspect
`bootReport().storageBackend`, `engineHome`, and `storageFallbackReason` instead of inferring
placement from the browser name.

See [Worker mode](https://pgxsinkit.github.io/concepts/worker-mode/) for the complete factory,
relocation, adoption, destruction, and durability contract.

## License

MIT, except the parts of the read-path sync engine that began as ElectricSQL's
`@electric-sql/pglite-sync`, which stay under the Apache License 2.0 (`LICENSE-APACHE-2.0`); the
package license is `MIT AND Apache-2.0`. The COPY serializer ports two PostgreSQL routines and keeps
PostgreSQL's notice. `NOTICE` lists those files and has every attribution.
