# Store path contract: derived storage backend, no client-visible memory stores

Status: accepted (2026-07-10)

pgxsinkit's durability semantics assume a persisted store. `retention: "persistent"` means "survives
a restart"; the optimistic Mutation journal is the correctness backstop that lets a background flush
be safe — lose the store, lose acked-but-unobserved work. On a memory-backed PGlite both promises
quietly dissolve: everything is session-scoped, so "persistent" means nothing and an optimistic
write's durability window is exactly the tab's lifetime. Yet nothing stopped a consumer landing
there: the client took a raw PGlite dataDir URL (`idb://…`, `memory://…`, `file://…`) and passed it
through unvalidated, and PGlite's *own* documented default (`new PGlite()`) is in-memory — one
copy-pasted example away from handing the BYO-instance seam a store that silently forgets. Memory
stores are genuinely needed in exactly two places, and both are ours: the unit-test lane (speed and
isolation) and the export machinery's throwaway clone (ADR-0035 addendum). The contract must make a
memory-backed store impossible to reach *unintentionally*, while keeping our own sanctioned uses
frictionless.

## Decision

1. **The public contract takes a `storePath`, never a storage URL.** Every seam that previously
   accepted a `dataDir` (`createSyncClient`, `createClientPGlite`, the worker attach/provision
   messages, the board's store registry) now takes `storePath: string` — a plain path/name. A
   scheme-bearing string (anything containing `://`) is **rejected with a typed error**: the old
   contract fails loudly at the boundary, never silently re-interpreted (no-legacy rule; there are
   no deployed consumers to migrate).

2. **The storage backend is derived from the environment, not chosen.** Browser → `idb://<storePath>`;
   Bun/Node → `file://<storePath>` (relative paths resolve against the working directory, exactly as
   PGlite's filesystem backend does; consumers who care pass an absolute path). The resolved URL is
   internal — it never appears in config, results, reports, or errors as something to imitate. OPFS
   is deliberately unsupported until the dedicated-worker story exists (OPFS sync access handles are
   unavailable in the SharedWorker the engine runs in); reopen trigger: pgxsinkit gains a
   dedicated-worker execution mode, or the platform grants `createSyncAccessHandle` to shared
   workers.

3. **Memory stores exist only behind an explicit testing acknowledgment.** A new subpath export,
   `@pgxsinkit/client/testing`, provides `memoryStoreForTests(storePath)`: it mints store options
   carrying a **symbol-keyed internal backend override** (resolved internally to a scheme-selected
   `memory://<storePath>`). The main entry point exports neither the symbol nor any backend option;
   no public type mentions memory; app bundles tree-shake the testing module away. Using a memory
   store is therefore always a visible, deliberate act — an import whose name says what it is — and
   the helper's JSDoc carries the durability caveat (persistent retention and optimistic journal
   guarantees are void). The repo's own unit tests consume this same public helper: no privileged
   internal door for the test lane.

4. **The BYO-instance seam refuses provably non-persistent stores.** `pgliteInstance` /
   `precreatedPglite` accept a caller-owned PGlite — the seam a copy-pasted `new PGlite()` reaches.
   At adoption the client inspects the instance's `dataDir`: `undefined` or a `memory://` prefix ⇒
   refused with a typed error naming both the why (durability semantics) and the two exits (persist
   it, or acknowledge a test store via the testing helper's override). Anything else present —
   including exotic custom-VFS configurations we cannot classify — **passes**: the guard exists to
   catch the two provably non-persistent shapes a consumer lands on unintentionally, not to
   whitelist storage backends. Feet and guns beyond that line are the caller's own.

5. **Internals stay unceremonied.** The export machinery's throwaway clone, provision, and any
   future engine-internal ephemeral store are constructed directly (scheme-selected `memory://`)
   without passing the public seam — "us, under the covers" pays no acknowledgment tax. One standing
   rule for internals, probed on PGlite 0.5.4: always scheme-selected memory (`memory://x`), never
   the explicit `fs: new MemoryFS()` option — `dumpDataDir` from an explicit-`fs` instance silently
   omits relation files created after initdb (`/base/5/<oid>` absent even after `CHECKPOINT`; a
   restored clone raises `relation "…" does not exist`). Upstream report drafted in `tmp/agents/`;
   until fixed upstream, the explicit `fs` option is forbidden in this repo.

## Alternatives considered

- **A client-visible `backend: "memory"` option.** Rejected: it puts the foot-gun in every
  consumer's autocomplete. The whole point is that production API surface cannot express a memory
  store.
- **A `test` flag on the registry.** The registry is the shared data contract — the server consumes
  it too. A client-storage concern does not belong in `packages/contracts`, and a flag there would
  still be visible API, just mislocated.
- **Env-var / build-time switches.** Unverifiable theater; the type system plus a named import is
  the honest enforcement.
- **Console warnings instead of (or on top of) refusals.** A typed, thrown, documented error is the
  strong form; a warning that fires alongside it is noise that trains consumers to ignore pgxsinkit
  output.
- **Classifying custom VFS configurations at the BYO seam.** Refusing what we cannot classify
  punishes legitimate exotic setups and turns the guard into a whitelist we must maintain; the
  narrow undefined-or-`memory://` predicate catches the actual accident.

## Consequences

- Breaking rename across the client package and the board app: `dataDir` → `storePath`, with the
  scheme-rejection guard at every entry. The board's store registry maps store ids to plain names;
  its PGlite-internal `idb://` knowledge (IndexedDB naming for orphan GC) moves behind the same
  internal resolution seam.
- The whole unit-test lane migrates from `dataDir: "memory://x"` to
  `memoryStoreForTests("x")` — mechanical, and afterwards the string `memory://` appears only in
  pgxsinkit-internal resolution code and its tests.
- `deriveStoreId` (ADR-0035 backup filenames) simplifies: the store id *is* the store path's last
  segment; no scheme stripping.
- Export tests and the throwaway clone dodge the upstream explicit-`fs` dump bug by construction;
  if a future PGlite fixes it, only ADR text and the upstream-report status change.
- A consumer determined to hand us a memory store via a custom VFS with a fabricated `dataDir`
  string still can. That is accepted: the contract's promise is "never unintentionally", not
  "never".
