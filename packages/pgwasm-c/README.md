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

## Extensions

`amcheck` is included:

```ts
import { amcheck } from "@pgxsinkit/pgwasm-c/contrib/amcheck";

const pg = await createPgwasm({ build: cBuild, extensions: { amcheck } });
await pg.exec("CREATE EXTENSION amcheck");
```

Licensed under the PostgreSQL License. `NOTICE` lists the components compiled into the artefacts and
reproduces each one's notice.
