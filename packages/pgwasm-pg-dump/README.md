# @pgxsinkit/pgwasm-pg-dump

[pg_dump](https://www.postgresql.org/docs/current/app-pgdump.html) for
[`@pgxsinkit/pgwasm`](https://www.npmjs.com/package/@pgxsinkit/pgwasm) databases: PostgreSQL 18's
pg_dump compiled to WebAssembly, run against a database in the same page, worker or Bun process.

```bash
bun add @pgxsinkit/pgwasm @pgxsinkit/pgwasm-c @pgxsinkit/pgwasm-pg-dump
```

```ts
import { createPgwasm } from "@pgxsinkit/pgwasm";
import { cBuild } from "@pgxsinkit/pgwasm-c";
import { pgDump } from "@pgxsinkit/pgwasm-pg-dump";

const pg = await createPgwasm({ build: cBuild });
await pg.exec("CREATE TABLE notes (id serial PRIMARY KEY, body text); INSERT INTO notes (body) VALUES ('hello');");

const dump = await pgDump({ pg }); // a File: dump.sql

// A plain dump is a script of SQL statements, which exec() runs back into an empty database.
const copy = await createPgwasm({ build: cBuild });
await copy.exec(await dump.text());
```

## Options

- `pg`: the database. Its Postgres build must reply on the wire synchronously
  (`capabilities.synchronousExchange`), as `@pgxsinkit/pgwasm-c`'s does; otherwise `pgDump` throws
  `PgDumpUnsupportedBuildError` before loading anything.
- `args`: more pg_dump arguments, such as `["--schema-only"]`, `["--table=notes"]` or
  `["--format=custom"]`. They come before the fixed ones, which win:
  `-U postgres --inserts -j 1 -f <file>` (INSERT statements, so `exec()` can restore the dump; one job;
  one output file).
- `fileName`: the returned file's name, `dump.sql` by default.

A plain dump is returned as `text/plain`. The custom and tar formats, and a plain dump compressed with
`--compress`, are returned byte for byte as `application/octet-stream`. The directory format writes
several files and is not supported.

After restoring a plain dump, the restoring session's `search_path` is empty (the dump sets it so);
set it back if the rest of the session relies on it.

## The database's session

pg_dump runs on the database's own session, which `pgDump` holds for the whole dump: queries,
transactions and backups of the same database wait until it is done, and a transaction already running
finishes first. A session left inside a transaction block by a hand-written `BEGIN` is refused with
`PgDumpSessionError`.

Afterwards the session is as it was: pg_dump's own transaction is ended, the statements it prepared are
deallocated (the database's own prepared statements, such as a live query's, stay), and every setting
it changed (`search_path`, `row_security`, the timeouts, the restriction on reading views) is restored.
A setting that cannot be restored is a `PgDumpSessionError` naming it.

## Errors

- `PgDumpError`: pg_dump failed. It carries `exitCode` (`null` if pg_dump crashed) and `stderr`.
- `PgDumpSessionError`: the session was inside a transaction block, or could not be restored.
- `PgDumpUnsupportedBuildError`: the database's build cannot run pg_dump.

All three are `PgwasmError`s from `@pgxsinkit/pgwasm`; `PgDumpUnsupportedBuildError` is also an
`UnsupportedFeatureError`.

## Bundlers

The package ships pg_dump's WebAssembly next to its code, referenced as `new URL("…", import.meta.url)`,
so bundlers copy and fingerprint it. With Vite, exclude the package from dependency pre-bundling:

```ts
// vite.config.ts
export default defineConfig({ optimizeDeps: { exclude: ["@pgxsinkit/pgwasm-pg-dump"] } });
```

Licensed under the PostgreSQL License. `NOTICE` lists the components compiled into pg_dump and
reproduces each one's notice.
