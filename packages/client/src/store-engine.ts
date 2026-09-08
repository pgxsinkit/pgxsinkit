import type { ClientPGlite } from "./index";

// ── The DECLARED store engine (ADR-0050 addendum 2026-09-08) ─────────────────────────────────────
//
// A store's storage declaration may name an ENGINE: `storage.engine = { module: <module URL> }`. When it
// does, THAT module mints the store instead of the toolkit's own `createClientPGlite` — so an application
// can drive a different PostgreSQL-shaped engine, one that lives outside this repo, without a line of
// engine-specific code in the toolkit. Nothing here knows, names or imports any particular engine: the
// module URL is the entire surface.
//
// The contract is the toolkit's own `createPglite` seam (ADR-0036), unchanged and unextended — the module's
// DEFAULT export, or failing that a named `createPglite`:
//
//   (storePath: string, backendOverride?: "memory") => Promise<ClientPGlite>
//
// `storePath` is a plain store NAME, never a storage URL. The handle comes back and is used exactly as a
// `createClientPGlite` one is, so it must carry the whole `ClientPGlite` surface the engine touches — `live`
// included. Everything the seam does not pass, the module owns: its own assets (derivable from
// `import.meta.url`; there is no asset base and there will not be one), its own storage layout under the
// store path, and its own environment requirements (a threaded engine that needs a cross-origin-isolated
// page, or a scope with no main thread, refuses to construct from inside the module, loudly).
//
// Both failure modes are LOUD and specific — an unloadable URL and a module with no callable export are the
// two ways a declared module goes wrong, and either one silently falling back to the built-in store would
// report a healthy engine for one that never ran.

/** The one function the declared engine trades in — the toolkit's `createPglite` option (ADR-0036). */
export type StoreEngineFactory = (storePath: string, backendOverride?: "memory") => Promise<ClientPGlite>;

/** How a scope loads a module URL: the dynamic `import()` in a browser scope, a stub in a unit test. */
export type StoreEngineModuleLoader = (url: string) => Promise<unknown>;

/**
 * The default loader: a runtime-valued dynamic `import()`.
 *
 * `@vite-ignore` because the URL is a value, naming a module OUTSIDE any bundle — a bundler that tried to
 * resolve or pre-bundle it would either fail the build or, worse, inline a stale copy.
 */
const importStoreEngineModule: StoreEngineModuleLoader = (url) => import(/* @vite-ignore */ url);

/**
 * Import one store-engine module URL and take its factory: the default export, else a named `createPglite`.
 *
 * @param module the declared `storage.engine.module` — an absolute or origin-relative module URL.
 * @param load how to import it; defaults to a dynamic `import()` in the calling scope.
 */
export async function loadStoreEngineFactory(
  module: string,
  load: StoreEngineModuleLoader = importStoreEngineModule,
): Promise<StoreEngineFactory> {
  let loaded: unknown;
  try {
    loaded = await load(module);
  } catch (cause) {
    throw new Error(
      `[pgxsinkit] the declared store engine "${module}" could not be imported. \`storage.engine.module\` ` +
        `must be a module URL THIS scope can import — same-origin, or cross-origin with CORS and (under ` +
        `cross-origin isolation) Cross-Origin-Resource-Policy: cross-origin.`,
      { cause },
    );
  }
  const exports = (loaded ?? {}) as { default?: unknown; createPglite?: unknown };
  const factory = typeof exports.default === "function" ? exports.default : exports.createPglite;
  if (typeof factory !== "function") {
    throw new Error(
      `[pgxsinkit] the declared store engine "${module}" exports no store factory. Expected a default ` +
        `export (or a named \`createPglite\`) of ` +
        `\`(storePath: string, backendOverride?: "memory") => Promise<ClientPGlite>\`.`,
    );
  }
  return factory as StoreEngineFactory;
}

/**
 * A per-scope resolver that loads each declared engine module ONCE and reuses it for every later mint.
 *
 * The memo keeps the REJECTION too: a failed load stays failed for the scope's lifetime, so every later
 * mint reports the same loud error instead of quietly succeeding on the built-in engine (a declared engine
 * that half-ran is a worse outcome than one that never started). Keyed by module URL, so a scope that is
 * somehow asked for two engines gets two loads and no cross-talk.
 */
export function createStoreEngineResolver(
  load: StoreEngineModuleLoader = importStoreEngineModule,
): (module: string) => Promise<StoreEngineFactory> {
  const loading = new Map<string, Promise<StoreEngineFactory>>();
  return (module) => {
    let pending = loading.get(module);
    if (pending === undefined) {
      pending = loadStoreEngineFactory(module, load);
      loading.set(module, pending);
    }
    return pending;
  };
}
