// The storage bench's default backend selection, factored out so it is unit-testable off-browser (bun) with a
// fabricated engine class; the page wires it to the real `classifyOpfsEngineClass()` result. The `opfs-ahp`
// column and its platform-aware default retired with the switch to pgwasm (ADR-0062 d4, d6).

import type { OpfsEngineClass } from "./engine-class";
import type { BenchBackend } from "./protocol";

/**
 * Warning copy shown beside `opfs-repacked-sw` off WebKit: Chromium and Firefox expose
 * `createSyncAccessHandle` in dedicated workers only, so the SharedWorker-direct column is structurally
 * unavailable there (probe-confirmed; real-device Safari grants it — ADR-0048 capability record).
 */
export const OPFS_REPACKED_SW_NON_WEBKIT_WARNING =
  "sync-access handles are dedicated-worker-only in this engine; SharedWorker-direct hosting is " +
  "WebKit-only (real-device Safari grants it)";

/**
 * The warning to show beside the `opfs-repacked-sw` checkbox, or `undefined` on `webkit-like` — the one
 * engine class whose SharedWorker scope grants sync-access handles, where the column is default-ticked.
 */
export function opfsRepackedSwWarning(engineClass: OpfsEngineClass): string | undefined {
  return engineClass === "webkit-like" ? undefined : OPFS_REPACKED_SW_NON_WEBKIT_WARNING;
}

/**
 * Whether a backend checkbox should be default-ticked for a given engine class. `idb` and the
 * constant-four-handle `opfs-repacked` backend are always default-on. `opfs-repacked-sw` is default-on exactly
 * where {@link opfsRepackedSwWarning} is silent (`webkit-like`). Every backend stays selectable (but warned)
 * either way.
 */
export function defaultBackendChecked(backend: BenchBackend, engineClass: OpfsEngineClass): boolean {
  if (backend === "opfs-repacked-sw") return opfsRepackedSwWarning(engineClass) === undefined;
  return true;
}
