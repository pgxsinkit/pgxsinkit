# Build permanence and `storage.build`

Status: accepted (2026-09-26). Amends [ADR-0049](0049-capability-driven-engine-placement.md)
decisions 7 and 9 (a store's build is fixed like its backend, and declared like its durability) and
[ADR-0050](0050-storage-declaration-transport.md) (the declaration carries one more field).

[ADR-0062](0062-absorb-pglite-as-pgwasm.md) makes the Postgres build a choice: the C build now, and
the pgrust build as an experimental opt-in later. The two cannot open each other's data
directories. Both are PostgreSQL 18 with the same catalog version (202506291), but the C build is
32-bit and compiled without `USE_FLOAT8_BYVAL`, while pgrust uses 8-byte values; Postgres' own
control-file check refuses the mismatch at boot (measured both ways on 2026-09-07,
`pglite-v-pgrust` `docs/results/2026-09-07-datadir-portability.md`). A Store backup is a data
directory image, so the same holds for restoring one. pgrust also has no IndexedDB backend.

## Decision

1. **Build permanence.** A store's Postgres build is fixed when the store is created, for the
   store's whole life. `pgwasm` writes the build's identity (its name and an on-disk compatibility
   version) into every data directory it creates. The marker lives in the data directory itself, so
   it works on every backend, including IndexedDB stores, which have no Store meta record by design.
   A directory without a marker was created by the C build, the only build that existed before.
   Opening a directory with any other build fails with a typed error before the engine touches a
   file. The check lives in `pgwasm`, so anyone using it directly is protected, not only
   pgxsinkit's client.

2. **The one route to another build** is the one ADR-0049 decision 7 gives for another backend: a
   deliberate, app-mediated destroy, then a fresh boot that re-syncs from the server. Nothing is
   carried across. A Data export remains the portable way out; a Store backup restores only into a
   store of the same build.

3. **`storage.build` is registry-declared.** The Storage declaration gains `build`: `c` by default,
   or `pgrust`. Like `backend` and `durability`, it follows the data, binds every open of every store
   minted from that registry, and is immutable: changing it mints a fresh store under a fresh path.
   It travels in the declaration message ADR-0050 defines.

4. **Code is supplied where stores are created.** Each place that creates stores (a worker entry,
   Bun code creating stores) passes in the build it runs. The client checks the supplied build
   against the declaration at boot and refuses a mismatch with a typed error. The declaration never
   causes a build to be loaded: a declared string resolved by dynamic import would force every app
   to install every build (a bundler fails on an import it cannot resolve), and Vite's default
   classic-script worker build would inline all of them. `@pgxsinkit/pgwasm-c` stays a dependency
   of the client, so apps on the C build change nothing.

## Considered options

- **Open across builds when the formats match.** They do not match today, and a failure would be
  silent corruption, not an error.
- **Record nothing and leave build switches to apps.** A mismatch would surface as an arbitrary
  engine failure.
- **Let each creation site decide alone, with no declaration.** Two sites creating stores for the
  same registry (a Bun server building a bootstrap store, the browser worker) could silently
  disagree, and the failure would appear only when a backup does not restore.

## Consequences

- A device that can only use the IndexedDB fallback can never move to pgrust. That is a documented
  requirement of the pgrust opt-in.
- Opening a store with a different build than it was created with can become a later, deliberate
  decision if the bench proves it safe on real stores. It is not implied by this ADR.
