# @pgxsinkit/pgwasm

The Postgres runtime of [pgxsinkit](https://pgxsinkit.github.io): queries, transactions, live
queries, `LISTEN`/`NOTIFY` and a Drizzle driver, in the browser and on Bun, over whichever
compiled Postgres build you hand it. The build is its own package; the C build is
[`@pgxsinkit/pgwasm-c`](https://www.npmjs.com/package/@pgxsinkit/pgwasm-c).

```bash
bun add @pgxsinkit/pgwasm @pgxsinkit/pgwasm-c
```

```ts
import { createPgwasm } from "@pgxsinkit/pgwasm";
import { live } from "@pgxsinkit/pgwasm/live";
import { cBuild } from "@pgxsinkit/pgwasm-c";

const pg = await createPgwasm({ build: cBuild, dataDir: "idb://my-app", extensions: { live } });
await pg.exec("CREATE TABLE IF NOT EXISTS todo (id serial PRIMARY KEY, title text)");
const { rows } = await pg.query<{ id: number; title: string }>("SELECT * FROM todo");
```

## Storage

`dataDir` names where the data directory lives, always with a scheme:

- `memory://` (or no `dataDir`): in memory, gone on `close()`;
- `idb://<name>`: IndexedDB, in a browser;
- `file://<path>`: a directory on disk, on Bun.

A build states which of these it supports. `opfs-ahp://` is not supported.

A data directory records the Postgres build that created it, and opening it with a different
build fails with `BuildMismatchError` before anything is written. A store backup
(`dumpDataDir()`, restored through the `loadDataDir` option) carries the same record, so it
restores only into its own build.

## Entry points

| Import                       | What it gives you                                                            |
| ---------------------------- | ---------------------------------------------------------------------------- |
| `@pgxsinkit/pgwasm`          | `createPgwasm`, the result and option types, the typed errors                |
| `@pgxsinkit/pgwasm/live`     | the `live` extension: `live.query`, `live.incrementalQuery`, `live.changes`  |
| `@pgxsinkit/pgwasm/drizzle`  | a Drizzle ORM driver (`drizzle(pg)`); needs `drizzle-orm`                    |
| `@pgxsinkit/pgwasm/protocol` | wire-level access (`protocol(pg).execProtocol…`) for tools such as `pg_dump` |
| `@pgxsinkit/pgwasm/fs`       | the filesystem contract a custom storage implements                          |
| `@pgxsinkit/pgwasm/build`    | the contract a Postgres build package implements                             |

ESM only, for Bun and browsers (pages, dedicated workers, SharedWorkers and extension pages).

See the [documentation](https://pgxsinkit.github.io) for the full toolkit.
