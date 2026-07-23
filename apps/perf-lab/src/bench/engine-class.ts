// Engine-class detection for the storage bench's default backend selection. Lives locally in the bench (the
// idb-only client no longer performs any OPFS storage selection, so it does not export this): the bench is
// the only consumer, and it needs the class to decide where the `opfs-ahp` column is default-ticked.

/**
 * The engine CLASS the bench keys its `opfs-ahp` default on. Every AMBIGUOUS case folds into `"webkit-like"`
 * — the safe resolution, since that is where `opfs-ahp` is known unsupported (its ~252 sync-access-handle cap).
 */
export type OpfsEngineClass = "chromium-like" | "firefox" | "webkit-like";

/**
 * The `navigator`-shaped seam {@link classifyOpfsEngineClass} reads — factored out so the classification is
 * fakeable in a unit test (there is no real `navigator` there). `userAgentData` is the STRUCTURAL Chromium-line
 * signal (a Chromium-only API, present in tab and worker scopes); `userAgent` is the string a worker scope
 * still exposes, matched for `"Firefox"`.
 */
export interface OpfsEngineNav {
  userAgentData?: unknown;
  userAgent?: string;
}

/** Read the classification-relevant `navigator` fields off `globalThis`. */
function detectOpfsEngineNav(): OpfsEngineNav {
  const nav = (globalThis as { navigator?: { userAgentData?: unknown; userAgent?: unknown } }).navigator;
  return {
    userAgentData: nav?.userAgentData,
    ...(typeof nav?.userAgent === "string" ? { userAgent: nav.userAgent } : {}),
  };
}

/**
 * Classify the current engine into an {@link OpfsEngineClass}. Injectable — the pure decision reads only its
 * `nav` argument; the default reads globals.
 *
 * - Chromium-line → `"chromium-like"`: `navigator.userAgentData` is present (a Chromium-only API, in tab AND
 *   worker scopes) — a STRUCTURAL signal, not a UA-string sniff.
 * - Firefox → `"firefox"`: `navigator.userAgent` contains `"Firefox"` (a worker scope still exposes `userAgent`).
 * - Everything else, INCLUDING every ambiguity → `"webkit-like"`: the safe resolution for the `opfs-ahp` default.
 */
export function classifyOpfsEngineClass(nav: OpfsEngineNav = detectOpfsEngineNav()): OpfsEngineClass {
  if (nav.userAgentData != null) return "chromium-like";
  if (typeof nav.userAgent === "string" && nav.userAgent.includes("Firefox")) return "firefox";
  return "webkit-like";
}
