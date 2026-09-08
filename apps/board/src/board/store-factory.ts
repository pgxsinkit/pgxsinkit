import type { ClientPGlite } from "@pgxsinkit/client";

// ── The board's LOCAL STORE seam ──────────────────────────────────────────────────────────────────
//
// Every store the board opens is minted by ONE of two paths:
//
//   * unset `VITE_BOARD_STORE_FACTORY` (the default — every lane, every dev run, the hosted demo):
//     the toolkit's own `createClientPGlite`, exactly as before. Nothing on this path changes: the
//     option below is not even passed, so the engine keeps the factory it has always built (declared
//     durability, the placement decision's OPFS grant, PGlite's own boot assets).
//   * `VITE_BOARD_STORE_FACTORY=<absolute module URL>`: THAT module mints the stores instead, so the
//     same board app can drive another PostgreSQL-shaped engine — one that lives OUTSIDE this repo —
//     without a line of engine-specific code in it. Nothing here knows or names any particular engine.
//
// **The contract.** The module's default export, or its named `createPglite`, is a
// {@link BoardStoreFactory}: `(storePath, backendOverride?) => Promise<ClientPGlite>` — the toolkit's
// own `createPglite` option (ADR-0036), unchanged and unextended. `storePath` is a plain store NAME,
// never a storage URL; `backendOverride` is the internal memory selection a test lane can ask for. The
// resolved handle is used exactly as a `createClientPGlite` one is, so it must carry the whole
// `ClientPGlite` surface the engine touches — `live` included (the worker's live-query manager
// subscribes through `pglite.live`).
//
// What the module owns, because the seam deliberately passes nothing else:
//
//   * **Its own assets.** Wasm/data locations are the module's business; it can derive them from its
//     own URL (`import.meta.url`). The seam has no `assetBase` and will not grow one.
//   * **Its own storage layout.** It answers for the store-directory convention a store path implies
//     (`pgxsinkit/stores/<identity>` under OPFS) and for its own persistence/durability behaviour.
//   * **Its own isolation needs.** A threaded engine needs a cross-origin-isolated page: see
//     `VITE_BOARD_ISOLATED` in vite.config.ts and apps/board/docs/local-store-seam.md.
//
// What it does NOT change: the board's declared storage (ADR-0049/0050). The backend preference stays
// `opfs` | `idbfs` and still travels as the wire declaration; this seam decides the FACTORY, never the
// declared backend — there is no third backend value.
//
// The seam is read from Vite's env, so the URL is baked at BUILD time (or at dev-server start), never
// per request. Loading is DEFERRED to the first mint and memoized: a worker chunk must not top-level
// await, and a board that never opens a store never imports the module. A load that fails stays failed
// — the memo keeps the rejection, so every later mint reports the same loud error rather than silently
// falling back to PGlite (the whole point of setting the variable is to run on the other engine).
//
// Keep this module free of `import.meta.env`, DOM globals and computed `import()`s: it is imported by a
// unit test that typechecks under the ROOT tsconfig (no vite/DOM types) and is fingerprinted by the
// import-graph test selector (ADR-0051), which force-runs anything it cannot walk. The env object and
// the module loader are therefore passed IN, by the two engine homes below.

/** The env slice this seam reads. `import.meta.env` satisfies it; so does a plain object in a test. */
export interface StoreFactoryEnv {
  readonly [key: string]: unknown;
}

/** The one function the seam trades in — the toolkit's `createPglite` option (ADR-0036), unchanged. */
export type BoardStoreFactory = (storePath: string, backendOverride?: "memory") => Promise<ClientPGlite>;

/** How a scope loads a module URL: `(url) => import(url)` in the browser, a stub in the unit test. */
export type StoreFactoryModuleLoader = (url: string) => Promise<unknown>;

/** The single env var naming the external store-factory module. Absent/blank ⇒ the built-in default. */
export const BOARD_STORE_FACTORY_ENV = "VITE_BOARD_STORE_FACTORY";

/** The configured module URL, or `undefined` when the seam is unset (a blank value reads as unset). */
export function readBoardStoreFactoryUrl(env: StoreFactoryEnv): string | undefined {
  const configured = env[BOARD_STORE_FACTORY_ENV];
  if (typeof configured !== "string") return undefined;
  const url = configured.trim();
  return url === "" ? undefined : url;
}

/**
 * Import one module URL and take its store factory: the default export, else a named `createPglite`.
 *
 * Both failure modes are LOUD and specific — an unloadable URL and a module with no callable export are
 * the two ways a hand-typed URL goes wrong, and either one silently falling back to the built-in store
 * would report a green board for an engine that never ran.
 */
export async function loadBoardStoreFactory(url: string, load: StoreFactoryModuleLoader): Promise<BoardStoreFactory> {
  let loaded: unknown;
  try {
    loaded = await load(url);
  } catch (cause) {
    throw new Error(
      `${BOARD_STORE_FACTORY_ENV}=${url} could not be imported. It must be an ABSOLUTE module URL this scope ` +
        `can import — same-origin, or cross-origin with CORS and (under the isolation headers) ` +
        `Cross-Origin-Resource-Policy: cross-origin.`,
      { cause },
    );
  }
  const exports = (loaded ?? {}) as { default?: unknown; createPglite?: unknown };
  const factory = typeof exports.default === "function" ? exports.default : exports.createPglite;
  if (typeof factory !== "function") {
    throw new Error(
      `${BOARD_STORE_FACTORY_ENV}=${url} exports no store factory. Expected a default export (or a named ` +
        `\`createPglite\`) of \`(storePath: string, backendOverride?: "memory") => Promise<ClientPGlite>\`.`,
    );
  }
  return factory as BoardStoreFactory;
}

/**
 * The seam's whole resolution, as an engine home performs it once at module scope: `undefined` when the
 * variable is unset (mint through the toolkit's own factory — today's behaviour, untouched), otherwise a
 * {@link BoardStoreFactory} that loads the configured module on the FIRST mint and reuses it after.
 */
export function resolveBoardStoreFactory(
  env: StoreFactoryEnv,
  load: StoreFactoryModuleLoader,
): BoardStoreFactory | undefined {
  const url = readBoardStoreFactoryUrl(env);
  if (url === undefined) return undefined;
  let loading: Promise<BoardStoreFactory> | undefined;
  return async (storePath, backendOverride) => {
    loading ??= loadBoardStoreFactory(url, load);
    const factory = await loading;
    return await factory(storePath, backendOverride);
  };
}
