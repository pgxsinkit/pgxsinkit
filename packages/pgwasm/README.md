# @pgxsinkit/pgwasm

The Postgres runtime of [pgxsinkit](https://pgxsinkit.github.io): queries, transactions, live
queries, `LISTEN`/`NOTIFY` and a Drizzle driver, in the browser and on Bun, over whichever
compiled Postgres build you hand it. The build is its own package; the C build is
[`@pgxsinkit/pgwasm-c`](https://www.npmjs.com/package/@pgxsinkit/pgwasm-c).

**PostgreSQL versions:** pgxsinkit 0.5.x and earlier use PostgreSQL 18; 0.6.x and later use
PostgreSQL 19 or later. This includes the 0.6 release candidates. The C build's release identifies
the exact PostgreSQL version. PG18 data directories and Store backups cannot be opened with the
PG19 build; use a fresh store and re-sync, exporting any local-only data before switching.

```bash
bun add @pgxsinkit/pgwasm @pgxsinkit/pgwasm-c
```

```ts
import { createPgwasm } from "@pgxsinkit/pgwasm";
import { cBuild } from "@pgxsinkit/pgwasm-c";
import { live } from "@pgxsinkit/pgwasm/live";

const pg = await createPgwasm({ build: cBuild, dataDir: "idb://my-app", extensions: { live } });
await pg.exec("CREATE TABLE IF NOT EXISTS todo (id serial PRIMARY KEY, title text)");
const { rows } = await pg.query<{ id: number; title: string }>("SELECT * FROM todo");
```

## Storage

`dataDir` names where the data directory lives, always with a scheme:

- `memory://` (or no `dataDir`): in memory, gone on `close()`;
- `idb://<name>`: IndexedDB, in a browser;
- `file://<path>`: a directory on disk, on Bun.

A build states which of these `dataDir` schemes it supports.

**OPFS-repacked is supported** through `createOpfsPgwasm` from `@pgxsinkit/pgwasm/opfs`, using an
OPFS directory handle instead of a `dataDir` scheme. It is the pgxsinkit client's default browser
store in a capable worker. The C build supports it; the entire Postgres data directory uses four
OPFS handles regardless of how many virtual files it contains.

`opfs-ahp://` refers to PGlite's old one-handle-per-file layout, which is not supported. That
restriction does not apply to OPFS-repacked.

A data directory records the Postgres build that created it, and opening it with a different
build fails with `BuildMismatchError` before anything is written. A store backup
(`dumpDataDir()`, restored through the `loadDataDir` option) carries the same record, so it
restores only into its own build.

### OPFS-repacked

Run this in a worker where opening synchronous OPFS access handles succeeds:

```ts
import { cBuild } from "@pgxsinkit/pgwasm-c";
import { createOpfsPgwasm } from "@pgxsinkit/pgwasm/opfs";

const root = await navigator.storage.getDirectory();
const directory = await root.getDirectoryHandle("my-app", { create: true });
const pg = await createOpfsPgwasm({ build: cBuild, directory });
try {
  await pg.exec("SELECT 1");
} finally {
  await pg.close();
}
```

Give each database its own otherwise-empty directory. The factory owns initialization, durability
and handle cleanup. For automatic browser capability detection and worker placement, use
`@pgxsinkit/client`; see the [OPFS-repacked documentation](https://pgxsinkit.github.io/packages/pgwasm/#the-opfs-repacked-store-pgxsinkitpgwasmopfs)
for worker requirements, durability options and recovery.

## Entry points

| Import                       | What it gives you                                                                       |
| ---------------------------- | --------------------------------------------------------------------------------------- |
| `@pgxsinkit/pgwasm`          | `createPgwasm`, the result and option types, the typed errors                           |
| `@pgxsinkit/pgwasm/live`     | the `live` extension: `live.query`, `live.incrementalQuery`, `live.changes`             |
| `@pgxsinkit/pgwasm/drizzle`  | a Drizzle ORM driver (`drizzle(pg)`); needs `drizzle-orm`                               |
| `@pgxsinkit/pgwasm/protocol` | `protocol(pg)`: wire-level access and an exclusive session, for tools such as `pg_dump` |
| `@pgxsinkit/pgwasm/opfs`     | the OPFS-repacked store: `createOpfsPgwasm`, `strictSync`, errors and low-level parts   |
| `@pgxsinkit/pgwasm/fs`       | the filesystem contract a custom storage implements                                     |
| `@pgxsinkit/pgwasm/build`    | the contract a Postgres build package implements                                        |

ESM only, for Bun and browsers (pages, dedicated workers, SharedWorkers and extension pages).

See the [documentation](https://pgxsinkit.github.io) for the full toolkit.

## License

MIT, except the Drizzle driver (`src/drizzle/`, `@pgxsinkit/pgwasm/drizzle`), which began as drizzle-orm's
PGlite driver and stays under the Apache License 2.0 (`LICENSE-APACHE-2.0`); the package license is
`MIT AND Apache-2.0`. `NOTICE` has every attribution.
