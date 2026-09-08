// ── The board's store-engine DROP-IN convention ──────────────────────────────────────────────────
//
// The build-time seam (`VITE_BOARD_STORE_FACTORY`, ./store-factory) bakes one engine into one build.
// This is its RUN-TIME twin: an engine that has been laid down as static files under the board's OWN
// origin can be picked from the login screen's preferences, with no rebuild — the picked module URL
// becomes the storage declaration's `engine` (ADR-0050 addendum 2026-09-08) and travels to whichever
// scope mints the store.
//
// The convention is deliberately tiny, and it is a MANIFEST, not a file-name guess:
//
//   <base>store-engine/manifest.json   { "factory": "<file>.js", "name": "<display name>" }
//   <base>store-engine/<file>.js       the store-factory module (default export, or `createPglite`)
//   <base>store-engine/…               whatever else that module loads at run time, its own business
//
// The manifest is REQUIRED, because the alternative is this repo hardcoding some engine's bundle file
// name — which is exactly the engine-specific knowledge the seam exists to keep out. A directory with
// no manifest is simply "no drop-in": the preference is not offered and the board is byte-identical to
// a board that never had one.
//
// `base` is the app's base URL (`import.meta.env.BASE_URL`), passed IN: the hosted demo builds under a
// subpath, where `public/` assets are served from `<base>` and not from `/`. Everything here stays free
// of `import.meta.env`, DOM globals and computed `import()`s for the same reason ./store-factory does —
// it is imported by a unit test that typechecks under the ROOT tsconfig, and the import-graph test
// selector (ADR-0051) force-runs whatever it cannot walk.

/** The drop-in directory's name, under the app's base URL. */
export const STORE_ENGINE_DROPIN_DIRECTORY = "store-engine";

/** The manifest file naming the drop-in's factory module and its display name. */
export const STORE_ENGINE_MANIFEST_FILE = "manifest.json";

/** A drop-in the board can offer: the module URL to declare, and the name to show for it. */
export interface StoreEngineDropIn {
  /** The origin-relative module URL of the factory — what `storage.engine.module` is set to. */
  readonly module: string;
  /** The manifest's display name, for the preference's label. */
  readonly name: string;
}

/** How the probe fetches the manifest: `globalThis.fetch` in the browser, a stub in a test. */
export type StoreEngineManifestFetch = (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

/** The drop-in directory's URL under `base` (always exactly one trailing slash). */
export function storeEngineDropInDirectory(base: string): string {
  const root = base.endsWith("/") ? base : `${base}/`;
  return `${root}${STORE_ENGINE_DROPIN_DIRECTORY}/`;
}

/** The manifest's URL under `base`. */
export function storeEngineManifestUrl(base: string): string {
  return `${storeEngineDropInDirectory(base)}${STORE_ENGINE_MANIFEST_FILE}`;
}

/**
 * Is `factory` a plain file name INSIDE the drop-in directory?
 *
 * The manifest is a file dropped into the app's public directory by whoever packaged the engine, so it
 * is treated as input, not as configuration this repo wrote: an absolute URL, a scheme, or a `..` climb
 * would let it name a module anywhere, which is not what "the drop-in's factory" means. A name that
 * fails this is a malformed drop-in — no engine is offered, and the board carries on unchanged.
 */
function isDropInFactoryName(factory: unknown): factory is string {
  return (
    typeof factory === "string" &&
    factory.trim() !== "" &&
    !factory.startsWith("/") &&
    !factory.includes("://") &&
    !factory.includes("..") &&
    !factory.includes("\\")
  );
}

/**
 * Read a fetched manifest body into a {@link StoreEngineDropIn}, or `undefined` when it is not one.
 *
 * `name` is presentation only — a missing or blank one falls back to the factory's file name, because a
 * drop-in that works should not be hidden over a cosmetic field.
 */
export function parseStoreEngineManifest(base: string, body: unknown): StoreEngineDropIn | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const { factory, name } = body as { factory?: unknown; name?: unknown };
  if (!isDropInFactoryName(factory)) return undefined;
  const trimmedName = typeof name === "string" ? name.trim() : "";
  return {
    module: `${storeEngineDropInDirectory(base)}${factory}`,
    name: trimmedName === "" ? factory : trimmedName,
  };
}

/**
 * Probe the origin for a store-engine drop-in — the ONE input the login screen's engine preference needs.
 *
 * Returns `undefined` (offer nothing) when the page is not cross-origin isolated, when there is no
 * manifest, or when the manifest is malformed. Isolation is checked first and is not negotiable here: it
 * is a property of the SERVED HEADERS (`VITE_BOARD_ISOLATED=1`, vite.config.ts), so a threaded engine
 * offered on a non-isolated page could only ever refuse to construct — offering it would be a promise the
 * page cannot keep. Every failure is swallowed: a board with no drop-in must behave exactly like a board
 * that never had one.
 *
 * It is a GET, not the HEAD a bare existence check would use, because the manifest's CONTENT is the
 * point — the factory's file name and its display name are the two things this repo refuses to guess.
 */
export async function probeStoreEngineDropIn(params: {
  readonly base: string;
  readonly isolated: boolean;
  readonly fetch: StoreEngineManifestFetch;
}): Promise<StoreEngineDropIn | undefined> {
  if (!params.isolated) return undefined;
  try {
    const response = await params.fetch(storeEngineManifestUrl(params.base));
    if (!response.ok) return undefined;
    return parseStoreEngineManifest(params.base, await response.json());
  } catch {
    // No drop-in, an offline origin, or a directory serving an HTML 404 body: all "nothing to offer".
    return undefined;
  }
}

/**
 * The label for an engine whose manifest is not (or no longer) readable — a preference persisted on an
 * isolated build and reopened on a plain one, say. The module's file name is the honest thing to show:
 * enough to recognise what is selected, and enough to decide to switch back.
 */
export function storeEngineModuleLabel(module: string): string {
  const file = module.split("/").at(-1);
  return file === undefined || file === "" ? module : file;
}
