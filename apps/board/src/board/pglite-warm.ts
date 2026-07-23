import initdbWasmUrl from "pglite-boot-asset/initdb.wasm?url";
import fsBundleUrl from "pglite-boot-asset/pglite.data?url";
// PGlite boot-asset pre-warm (board optimisation A). A cold `PGlite.create` spends ~2.5s fetching and
// compiling the Postgres WASM (`pglite.wasm`), the initdb WASM (`initdb.wasm`) and the filesystem bundle
// (`pglite.data`) before it can open a store. That cost is otherwise paid AFTER the user has picked an
// identity — squarely on the critical path to first paint. This module fetches+compiles those exact
// assets ahead of time, during the login screen's think-time, and hands them to `PGlite.create` via the
// library's `pgliteBootAssets` option so the create skips its own lazy asset load.
//
// Vite owns the asset URLs: the `?url` imports below resolve to the same bytes PGlite would otherwise
// fetch itself — served straight from `node_modules` under `vite dev`, and copied+hashed into the build
// output by `vite build` (verified compiling via `bun run demo:build`). So the warm always points at the
// deployment's real assets, in dev and in the hosted `/demo` build alike. The `pglite-boot-asset/*`
// prefix is a resolve alias onto PGlite's dist directory (see apps/board/vite.config.ts) — PGlite's
// package `exports` does not expose `./dist/*`, so a bare deep specifier would be rejected.
import pgliteWasmUrl from "pglite-boot-asset/pglite.wasm?url";

import { syncDebug, timeAsync } from "@pgxsinkit/client";

/** The pre-warmed assets in the exact shape `PGlite.create` (v0.5.x) consumes them (`PGliteOptions`). */
export interface PgliteBootAssets {
  pgliteWasmModule?: WebAssembly.Module;
  initdbWasmModule?: WebAssembly.Module;
  fsBundle?: Blob;
}

// Module-singleton: one warm per page load, shared by the login-screen prime (fire-and-forget) and the
// client boot (which passes the resolved promise through). A rejected warm clears the cache so a later
// boot can retry rather than caching the failure forever.
let warmPromise: Promise<PgliteBootAssets> | undefined;

/**
 * Compile a WASM module from `url`, preferring the streaming compiler (no full-buffer allocation) and
 * falling back to buffered compile when the host rejects streaming — e.g. a static host that serves
 * `.wasm` with a non-`application/wasm` content-type, which `compileStreaming` refuses.
 */
async function compileWasm(url: string): Promise<WebAssembly.Module> {
  try {
    return await WebAssembly.compileStreaming(fetch(url));
  } catch {
    const bytes = await (await fetch(url)).arrayBuffer();
    return WebAssembly.compile(bytes);
  }
}

/**
 * Fetch + compile PGlite's boot assets, memoised (idempotent) for the page. Call it fire-and-forget on
 * the login screen to warm during think-time, then again at client-boot to await the cached result. A
 * failure resolves to an empty set (and drops the cache) so the boot silently falls back to PGlite's own
 * asset loading — the warm is a pure accelerator, never a boot dependency.
 */
export function warmPgliteBootAssets(): Promise<PgliteBootAssets> {
  if (!warmPromise) {
    warmPromise = timeAsync("boot pglite assets warm", async () => {
      const [pgliteWasmModule, initdbWasmModule, fsBundle] = await Promise.all([
        compileWasm(pgliteWasmUrl),
        compileWasm(initdbWasmUrl),
        fetch(fsBundleUrl).then((response) => response.blob()),
      ]);
      return { pgliteWasmModule, initdbWasmModule, fsBundle };
    }).catch(() => {
      // Drop the cached rejection so a later boot re-attempts the warm, and resolve empty → PGlite loads
      // its own assets on `create`. The warm never wedges the boot.
      warmPromise = undefined;
      syncDebug("boot pglite assets warm skipped (fallback to lazy load)");
      return {};
    });
  }
  return warmPromise;
}
