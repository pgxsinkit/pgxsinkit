# @pgxsinkit/pgwasm-c

The C Postgres build for [`@pgxsinkit/pgwasm`](https://www.npmjs.com/package/@pgxsinkit/pgwasm):
PostgreSQL 18 compiled to WebAssembly with Emscripten, single-threaded, with the memory,
IndexedDB (`idb://`) and file (`file://`, Bun) filesystems.

```bash
bun add @pgxsinkit/pgwasm @pgxsinkit/pgwasm-c
```

```ts
import { createPgwasm } from "@pgxsinkit/pgwasm";
import { cBuild } from "@pgxsinkit/pgwasm-c";

const pg = await createPgwasm({ build: cBuild, dataDir: "idb://my-app" });
```

The package ships its WebAssembly module, filesystem bundle and initdb as files next to its code,
referenced as `new URL("…", import.meta.url)`, so bundlers copy and fingerprint them.

## Bundlers

Vite: exclude the package from dependency pre-bundling, which would move the module away from its
files:

```ts
// vite.config.ts
export default defineConfig({ optimizeDeps: { exclude: ["@pgxsinkit/pgwasm-c"] } });
```

## Warming the artefacts early

`cBuildArtefacts` holds the URLs of the files the build loads. A page can fetch and compile them
early and hand them over:

```ts
import { cBuildArtefacts, createCBuild } from "@pgxsinkit/pgwasm-c";

const build = createCBuild({
  postgresWasmModule: WebAssembly.compileStreaming(fetch(cBuildArtefacts.postgresWasm)),
  initdbWasmModule: WebAssembly.compileStreaming(fetch(cBuildArtefacts.initdbWasm)),
  fsBundle: fetch(cBuildArtefacts.fsBundle).then((response) => response.blob()),
});
```

## Starting from the prepopulated data directory

A new database normally runs initdb. The package also ships a freshly initialised data directory as
a Store backup, which starts faster:

```ts
import { createPgwasm } from "@pgxsinkit/pgwasm";
import { cBuild } from "@pgxsinkit/pgwasm-c";
import { prepopulatedDataDir } from "@pgxsinkit/pgwasm-c/prepopulated";

const pg = await createPgwasm({ build: cBuild, loadDataDir: await prepopulatedDataDir() });
```

`loadDataDir` restores only into an empty data directory, so pass it when creating a store, not when
reopening one. Every database created from it is marked as the C build's.

## Extensions

`amcheck` is included:

```ts
import { amcheck } from "@pgxsinkit/pgwasm-c/contrib/amcheck";

const pg = await createPgwasm({ build: cBuild, extensions: { amcheck } });
await pg.exec("CREATE EXTENSION amcheck");
```

Licensed under the PostgreSQL License. `NOTICE` lists the components compiled into the artefacts and
reproduces each one's notice.
