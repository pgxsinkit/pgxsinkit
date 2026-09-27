// PGlite boot-asset pre-warm (board optimisation A). A cold `PGlite.create` spends ~2.5s fetching and
// compiling the Postgres WASM (`pglite.wasm`), the initdb WASM (`initdb.wasm`) and the filesystem bundle
// (`pglite.data`) before it can open a store. That cost is otherwise paid AFTER the user has picked an
// identity — squarely on the critical path to first paint. This module fetches+compiles those exact
// assets ahead of time, during the login screen's think-time, and hands them to the store's C build via the
// library's `pgliteBootAssets` option (`createCBuild({ assets })`) so the create skips its own lazy asset load.
//
// The URLs are the C build's own (`cBuildArtefacts`), the same bytes the build would otherwise fetch itself:
// Vite resolves each `new URL(…, import.meta.url)` to the served asset under `vite dev` and copies+hashes it
// into the build output under `vite build`, so the warm always points at the deployment's real assets.

import { syncDebug, timeAsync } from "@pgxsinkit/client";
import { cBuildArtefacts } from "@pgxsinkit/pgwasm-c";

/** The pre-warmed assets in the shape the client's `pgliteBootAssets` option takes (handed on to `createCBuild`). */
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
        compileWasm(cBuildArtefacts.postgresWasm.href),
        compileWasm(cBuildArtefacts.initdbWasm.href),
        fetch(cBuildArtefacts.fsBundle).then((response) => response.blob()),
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
