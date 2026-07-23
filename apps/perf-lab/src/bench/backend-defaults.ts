// The PROVEN root cause of the opfs-ahp failures, established by instrumented bisection on the deployed bench
// plus fork tracing.
//
// Upstream PGlite's opfs-ahp VFS keeps one OPEN sync access handle per file: initdb creates ~970 PGDATA
// files (whose handles stay open) and a maintained pool adds ~100, so a live store holds ~1070 handles.
// Chrome's profile-wide StorageService utility process holds one OS file descriptor per handle, and ON
// LINUX it is forked from the zygote BEFORE the browser process raises its FD limit — so it inherits the
// desktop session's classic 1024 soft limit (systemd DefaultLimitNOFILE) even when the shell ulimit is
// higher and the browser process itself shows 8192. At FD exhaustion Chromium QUEUES createSyncAccessHandle
// FOREVER instead of rejecting: a catch-proof, non-recoverable, PROFILE-WIDE wedge (every later store open
// in ANY tab/worker hangs). Bisected with the deployed bench + fork tracing: ulimit 1024 → stalls at ~950
// pool files; ulimit 1500 → the complete ahp flow runs clean (1000/1000 pool, initdb consuming 970, refill,
// a second store).
//
// Compatibility matrix: Firefox works EVERYWHERE incl. Linux default limits (it raises its own FD limit
// process-wide; no zygote split); Chrome works on macOS (empirically confirmed on a real Mac — no zygote
// there) and on Windows (no POSIX FD limits); Chrome on LINUX wedges under default session limits;
// WebKit/Safari can never run opfs-ahp (handle cap ~252 << ~1070 — the reason opfs-repacked exists).
// Active feature-probing for the limit is IMPOSSIBLE by design: the failure is a catch-proof,
// non-recoverable, profile-wide wedge, so the page must rely on these platform heuristics.
//
// This is the PURE default-selection decision, factored out so it is unit-testable off-browser (bun) with a
// fabricated engine class + platform — the page wires it to the real `classifyOpfsEngineClass()` result and
// the normalized `navigator.userAgentData.platform` string.

import type { OpfsEngineClass } from "./engine-class";
import type { BenchBackend } from "./protocol";

/** The OS platform (normalized from `navigator.userAgentData.platform`) that gates the opfs-ahp default. */
export type BenchPlatform = "windows" | "macos" | "linux" | "unknown";

/**
 * Normalize a raw `navigator.userAgentData.platform` string into a {@link BenchPlatform}. Case-insensitive
 * and whitespace-trimming; anything unrecognized — including `""` and `undefined` — becomes `"unknown"`.
 * Pure and total, so the whole default decision is bun-testable without a real `navigator`.
 */
export function normalizePlatform(raw: string | null | undefined): BenchPlatform {
  switch ((raw ?? "").trim().toLowerCase()) {
    case "windows":
      return "windows";
    case "macos":
      return "macos";
    case "linux":
      return "linux";
    default:
      return "unknown";
  }
}

/**
 * Warning copy shown beside `opfs-ahp` on chromium-like/Linux (and the safe Linux-equivalent, unknown): the
 * profile-wide storage-service FD-limit wedge that hangs Chrome at exhaustion.
 */
export const OPFS_AHP_LINUX_FD_WARNING =
  "needs ~1070 file descriptors; Chrome's storage service on Linux inherits the session's 1024 FD soft " +
  "limit and hangs at exhaustion (raise your session DefaultLimitNOFILE to try it)";

/** Warning copy shown beside `opfs-ahp` on webkit-like: the ~252 sync-access-handle cap that rules it out. */
export const OPFS_AHP_WEBKIT_WARNING =
  "not supported: needs ~1070 sync-access handles, WebKit caps at ~252 (why opfs-repacked exists)";

/**
 * The warning to show beside the `opfs-ahp` checkbox, or `undefined` when it is default-ticked (no warning
 * — opfs-ahp runs there). Per the proven account (see the file header):
 *
 * - `webkit-like` (any platform) → {@link OPFS_AHP_WEBKIT_WARNING} (handle cap; never supported).
 * - `chromium-like` on `linux` OR `unknown` → {@link OPFS_AHP_LINUX_FD_WARNING}. Unknown platform is treated
 *   as LINUX-equivalent — the safe default, since the FD wedge is the non-recoverable failure mode.
 * - `firefox` (any platform) and `chromium-like` on `windows`/`macos` → `undefined` (default-ticked).
 */
export function opfsAhpWarning(engineClass: OpfsEngineClass, platform: BenchPlatform): string | undefined {
  if (engineClass === "webkit-like") return OPFS_AHP_WEBKIT_WARNING;
  if (engineClass === "chromium-like" && (platform === "linux" || platform === "unknown")) {
    return OPFS_AHP_LINUX_FD_WARNING;
  }
  return undefined;
}

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
 * Whether a backend checkbox should be default-ticked for a given engine class + platform. `idb` and the
 * constant-four-handle `opfs-repacked` backend are always default-on. `opfs-ahp` is default-on exactly where
 * it actually runs — `firefox` on any platform, and `chromium-like` on Windows or macOS — and default-OFF
 * where it wedges or is unsupported (`chromium-like` on Linux/unknown; `webkit-like` anywhere), which is
 * precisely where {@link opfsAhpWarning} returns a message. `opfs-repacked-sw` is default-on exactly where
 * {@link opfsRepackedSwWarning} is silent (`webkit-like`). Every backend stays selectable (but warned)
 * either way.
 */
export function defaultBackendChecked(
  backend: BenchBackend,
  engineClass: OpfsEngineClass,
  platform: BenchPlatform,
): boolean {
  if (backend === "opfs-ahp") return opfsAhpWarning(engineClass, platform) === undefined;
  if (backend === "opfs-repacked-sw") return opfsRepackedSwWarning(engineClass) === undefined;
  return true;
}
