# Local store seam — apps/board

The board's local store is normally the toolkit's own: `createClientPGlite`, i.e.
PGlite, opened by whichever engine home the browser gives us (the per-store
SharedWorker of [ADR-0032](../../../docs/adr/0032-sync-engine-in-shared-worker.md), or
the in-process fallback where `SharedWorker` is missing).

This seam lets a **different PostgreSQL-shaped engine — one that lives outside this
repo — answer for that store instead**, selected at build time by an env var. It
exists so the board can be driven against another engine without a line of
engine-specific code landing here: nothing in this repo knows, names, or imports any
particular engine. It is the browser-side twin of the unit suite's store seam
(`PGXSINKIT_TEST_STORE_FACTORY`, `tests/support/pglite.ts`).

Two variables, both off by default. With neither set, the board is byte-identical to
what it was before the seam existed.

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

What the seam does **not** touch is the board's declared storage
([ADR-0049](../../../docs/adr/0049-capability-driven-engine-placement.md) /
[ADR-0050](../../../docs/adr/0050-storage-declaration-transport.md)): the backend
preference stays `opfs | idbfs` and still travels as the wire declaration. The seam
decides the **factory**, never the declared backend — there is no third backend
value.

### Where it is wired

Both engine homes resolve the same seam, so a configured engine can never be
silently bypassed:

- `src/board/board-sync.worker.ts` — the worker entry. One `createPglite` option
  covers both the spare `provision` (initdb, pre-login) and the boot create, and it
  covers both worker scopes the entry runs in: the SharedWorker itself, and the
  elected dedicated engine worker that runs the same module under
  [ADR-0049](../../../docs/adr/0049-capability-driven-engine-placement.md) placement.
- `src/board/store-registry-default.ts` — the in-process fallback's tab-side store.

The resolution itself lives in `src/board/store-factory.ts` and is unit-tested in
`tests/unit/board-store-factory.test.ts`.

### Failure modes

The variable is read from Vite's env, so it is **baked at build time** (or at
dev-server start), never per request. The module is imported lazily, on the first
mint, and memoized. Both ways of getting it wrong fail **loudly**, because a silent
fallback to PGlite would report a green board for an engine that never ran:

- the URL will not import → `VITE_BOARD_STORE_FACTORY=<url> could not be imported…`
  (with the underlying failure as `cause`);
- the module has no callable export →
  `VITE_BOARD_STORE_FACTORY=<url> exports no store factory…`.

A failed load stays failed: every later mint reports the same error.

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
