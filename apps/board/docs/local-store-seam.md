# Local store seam — apps/board

The board's local store is normally the toolkit's own: `createClientPGlite`, i.e.
PGlite, opened by whichever engine home the browser gives us (the per-store
SharedWorker of [ADR-0032](../../../docs/adr/0032-sync-engine-in-shared-worker.md), or
the in-process fallback where `SharedWorker` is missing).

This seam lets a **different PostgreSQL-shaped engine — one that lives outside this
repo — answer for that store instead**. It exists so the board can be driven against
another engine without a line of engine-specific code landing here: nothing in this
repo knows, names, or imports any particular engine. It is the browser-side twin of
the unit suite's store seam (`PGXSINKIT_TEST_STORE_FACTORY`,
`tests/support/pglite.ts`).

There are **two ways in**, and they take the same module:

|                                 | who chooses                   | when                              |
| ------------------------------- | ----------------------------- | --------------------------------- |
| `VITE_BOARD_STORE_FACTORY`      | the build                     | baked at build / dev-server start |
| the **Store engine** preference | the user, on the login screen | per browser profile, at run time  |

The build-time variable is for a lane that certifies one engine. The preference is for
a person who wants to switch — it needs a **drop-in** under the app's own origin (below)
and rides the storage declaration, so no rebuild is involved. When the preference names
an engine it WINS over the baked variable, being both later and more explicit.

Everything is off by default. With no drop-in, no preference and no variable, the board
is byte-identical to what it was before the seam existed.

| Variable                   | Value                  | Effect                                                      |
| -------------------------- | ---------------------- | ----------------------------------------------------------- |
| `VITE_BOARD_STORE_FACTORY` | an absolute module URL | that module mints every local store the board opens         |
| `VITE_BOARD_ISOLATED`      | `1`                    | vite dev + preview serve the cross-origin-isolation headers |

## The contract

`VITE_BOARD_STORE_FACTORY` holds an **absolute module URL**. The board `import()`s it
and takes its **default export**, or failing that a named **`createPglite`**:

```ts
export default function createPglite(storePath: string, backendOverride?: "memory"): Promise<ClientPGlite>;
```

That is the toolkit's own `createPglite` option ([ADR-0036](../../../docs/adr/0036-store-path-contract.md)),
unchanged and unextended — one function, no options bag.

- `storePath` is a plain store **name**, never a storage URL.
- `backendOverride` is the internal memory selection a test lane can ask for.
- The resolved handle is used exactly as a `createClientPGlite` one is, so it must
  carry the whole `ClientPGlite` surface the engine touches — **`live` included**
  (the worker's live-query manager subscribes through `pglite.live`).

The module owns everything the seam does not pass:

- **its own assets** — wasm/data locations are its business, derivable from its own
  URL (`import.meta.url`). There is no `assetBase` parameter and there will not be
  one;
- **its own storage layout** — it answers for the store-directory convention a store
  path implies (`pgxsinkit/stores/<identity>` under OPFS) and for its own persistence
  and durability behaviour;
- **its own isolation needs** — a threaded engine only constructs on a
  cross-origin-isolated page (see below).

The **backend** axis is untouched either way
([ADR-0049](../../../docs/adr/0049-capability-driven-engine-placement.md) /
[ADR-0050](../../../docs/adr/0050-storage-declaration-transport.md)): the preference
stays `opfs | idbfs` and still travels as the wire declaration. This seam decides the
**factory**, never the declared backend — there is no third backend value.

## The run-time preference: a drop-in

The login screen's **Store engine** control switches the local store between `Built-in`
and `External (<name>)` with no rebuild. It is the third storage preference, next to
durability and backend, and it works exactly as those two do: the choice lives in
`localStorage` and travels as the wire storage declaration —
`storage.engine = { module }` (ADR-0050's addendum) — to whichever scope mints the
store.

Because a store's declaration is **immutable**, changing the engine does what changing
the backend does: Apply obsoletes every current binding, writes the preference, and
reloads, so fresh stores mint under the new declaration and the old paths are destroyed
in the background. That is not a policy choice here but a fact — a datadir belongs to the
engine that wrote it, and the other engine will not (and must not) open it.

### The drop-in convention

The external option appears only when **both** hold: the page is `crossOriginIsolated`,
and the origin serves a drop-in. A drop-in is a directory under the app's base URL:

```
<base>store-engine/manifest.json      { "factory": "<file>.js", "name": "<display name>" }
<base>store-engine/<file>.js          the store-factory module — default export, the contract above
<base>store-engine/…                  whatever else that module loads at run time; its own business
```

For this board that is `apps/board/public/store-engine/`, which is **gitignored**: an
engine's build output is somebody else's, and it is laid down locally, never committed.

The `manifest.json` is **required**. Probing for some known bundle file name would mean
this repo knowing an engine's file layout, which is the whole thing the seam exists to
avoid — so the manifest is how a drop-in names itself, and a directory without one is
simply not a drop-in. `factory` must be a plain file name inside the directory (no
absolute path, no scheme, no `..`); `name` is the label the preference shows and falls
back to the file name when it is missing.

The board reads the manifest once per login-screen mount, swallowing every failure, and
declares `<base>store-engine/<factory>` as the module. Serving it from the app's **own
origin** is what makes this simple: the module needs no CORS, and neither do the workers
an engine builds from URLs it computes (`new Worker(url)` refuses a cross-origin script).

The convention lives in `src/board/store-engine-dropin.ts`, unit-tested in
`tests/unit/board-store-engine-dropin.test.ts`; the preference itself is in
`src/board/storage-preference.ts` beside the other two.

### Where it is wired

Both engine homes resolve both routes, so a chosen engine can never be silently
bypassed:

- `src/board/board-sync.worker.ts` — the worker entry. The **declared** engine is
  resolved inside the toolkit, off the bound declaration
  (`defineSyncWorker`'s mint seam), so it covers the spare `provision` (initdb,
  pre-login) and the boot create alike, in both worker scopes the entry runs in: the
  SharedWorker itself, and the elected dedicated engine worker that runs the same module
  under [ADR-0049](../../../docs/adr/0049-capability-driven-engine-placement.md)
  placement. The build-time variable is passed as the `createPglite` option beneath it.
- `src/board/store-registry-default.ts` — the in-process fallback's tab-side store,
  which resolves the same declaration with the toolkit's own generic loader
  (`createStoreEngineResolver`) and falls through to the variable, then to PGlite. It
  passes the store path and nothing else: the main-thread refusal a threaded engine owes
  belongs to the **module**, not to the board.

The build-time resolution lives in `src/board/store-factory.ts`
(`tests/unit/board-store-factory.test.ts`); the declared-engine one is the toolkit's
`packages/client/src/store-engine.ts` (`tests/unit/store-engine-module.test.ts`), driven
from the worker in `tests/unit/worker-provision-offline.test.ts`.

### Failure modes

The variable is read from Vite's env, so it is **baked at build time** (or at
dev-server start), never per request. The preference is read from `localStorage` on
every declaration the tab sends. Either way the module is imported lazily, on the first
mint, and memoized — and both ways of getting it wrong fail **loudly**, because a silent
fallback to PGlite would report a green board for an engine that never ran:

- the URL will not import → `… could not be imported…` (with the underlying failure as
  `cause`);
- the module has no callable export → `… exports no store factory…`.

A failed load stays failed: every later mint reports the same error.

The preference is honoured even where the drop-in is no longer OFFERED — a preference
set on an isolated build and reopened on a plain one still declares its engine, and the
module's own refusal ("this page is not cross-origin isolated") is the error you get.
Quietly reading it back as `Built-in` would be worse: PGlite would be pointed at a
datadir it did not write. The login screen keeps the control visible whenever a
preference is persisted, labelled with the module's file name, so switching back is
always one Apply away.

## Cross-origin isolation

An engine that runs on threads (`SharedArrayBuffer` + `Atomics.wait`) is only
constructible on a **cross-origin-isolated** page, and isolation is a property of the
served headers, not of the app. `VITE_BOARD_ISOLATED=1` makes `vite.config.ts` serve,
on **dev and preview** alike:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

`headers` applies to every response, which is what the engine home needs: a
SharedWorker takes its embedder policy from its **own script response**, so
`crossOriginIsolated` is true inside the worker only because the worker chunk is
served with these too.

It is opt-in because COEP `require-corp` makes every **no-cors** cross-origin
subresource fail closed. The board loads none — its own assets are same-origin, and
its backend traffic (Supabase auth, the control plane, the stream edge, writes) is
`fetch` with CORS, which COEP does not gate. The one thing to watch is the store
factory module itself: if it is served from **another origin** it needs CORS _and_
`Cross-Origin-Resource-Policy: cross-origin`. Serving it same-origin (e.g. under
`apps/board/public/`) sidesteps that entirely.

The default board is PGlite, single-threaded, and neither needs nor wants these
headers — so unset, nothing is served and nothing changes.

## Running it

The run-time route — nothing baked, the user chooses:

```bash
# lay the engine's files down (the packaging step is the ENGINE's, in its own repo),
# then hand-write the manifest that names its factory:
#   apps/board/public/store-engine/manifest.json
#   { "factory": "<file>.js", "name": "<display name>" }

# built artifact under vite preview (5173), isolated, NO factory variable
cd apps/board && VITE_BOARD_ISOLATED=1 bun run build && VITE_BOARD_ISOLATED=1 bun run preview
```

Then pick **Store engine → External** on the login screen and Apply. `VITE_BOARD_ISOLATED`
is still required, because isolation is server configuration, not a run-time choice.

The build-time route — one engine, baked, for a lane that certifies it:

```bash
# dev server (5660), isolated, on an external engine
VITE_BOARD_ISOLATED=1 VITE_BOARD_STORE_FACTORY=http://localhost:5660/engine/factory.js \
  bun run dev:board

# or the built artifact under vite preview (5173)
cd apps/board && VITE_BOARD_ISOLATED=1 VITE_BOARD_STORE_FACTORY=… bun run build \
  && VITE_BOARD_ISOLATED=1 bun run preview
```

Confirm the headers are actually being served (and that they are absent without the
flag):

```bash
curl -sI http://localhost:5173/ | grep -i cross-origin
```

Confirm the engine is actually the configured one from the browser: `crossOriginIsolated`
must be `true` in the page **and** in the engine home, and the factory module must be
the thing that minted the store. Have the factory announce itself — a `console.log`
(a dedicated engine worker's reaches the page's console; a SharedWorker's does not)
plus a `BroadcastChannel` message the page can read, which works from either scope.
