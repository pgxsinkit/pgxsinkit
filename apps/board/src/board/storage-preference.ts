import type { StorageBackend, StorageDurability, SyncStorageDeclaration } from "@pgxsinkit/contracts";

/**
 * The board's demo durability axis, a {@link StorageDurability} (ADR-0047). Durability is registry-declared;
 * the board's demo affordance is to pick the value at boot and STAMP it onto the registry
 * (`attachSyncRegistryStorage`) before handing it to `createSyncClient`/`defineSyncWorker`, so the toolkit's
 * single mint seam resolves it exactly as if the registry had declared it statically.
 */
export type DurabilityPreference = StorageDurability;

/**
 * The board's demo BACKEND axis, a {@link StorageBackend} (ADR-0049 decision 1). Like durability it is
 * registry-declared and STAMPED at boot, but its two values are asymmetric: `"idbfs"` FORCES the
 * in-SharedWorker idbfs engine with no capability probe/election, while `"opfs"` (the default) is the
 * capability default — the toolkit probes for an opfs sync-access home and falls back to idbfs when none
 * exists. Only an explicit `"idbfs"` is stamped onto the registry (see {@link boardStorageDeclaration}); the
 * `"opfs"` default stamps NOTHING, leaving the toolkit to resolve the ADR-0047 capability default. This is
 * the board's "force idbfs" demo control — the twin of the durability control.
 */
export type BackendPreference = StorageBackend;

// The board's demo surface for the storage preferences. Both axes are threaded into the engine via the worker
// NAME (a SharedWorker has no localStorage), read once at boot, and applied by reload — a demo affordance,
// never a boot dependency.
//
// ── Durability preference ─────────────────────────────────────────────────────────────────────────────
// "Relaxed" (`relaxed`, the DEFAULT) or "Strict" (`strict`). Relaxed returns a query before the datadir flush
// and schedules the flush asynchronously; strict keeps PGlite's synchronous end-of-query flush (on IndexedDB
// ~100ms+ PER write). The value the board reads here is stamped onto the registry's storage contract at boot
// and transported into the worker scope via the worker NAME (a SharedWorker has no localStorage) — see the
// identity caveat below.
//
// ── Backend preference (ADR-0049 decision 1) ────────────────────────────────────────────────────────────
// "OPFS (default)" (`opfs`, the DEFAULT) or "Force idbfs" (`idbfs`). `opfs` is the capability default: the
// toolkit probes for an opfs sync-access home and elects `opfs-repacked`, falling back to idbfs where no home
// exists. `idbfs` opts out of that machinery entirely — no probe, no election, the engine boots on idb. Read
// and transported exactly like durability (worker NAME), and stamped onto the registry storage contract at
// boot — but only `idbfs` stamps `backend` (the `opfs` default omits it, so both sides declare the same
// contract in the default case; see {@link boardStorageDeclaration} and the identity caveat below).
//
// ── SharedWorker identity caveat (ADR-0032) ─────────────────────────────────────────────────────────────
// A SharedWorker is deduped by the pair (name, script URL). The board threads BOTH preferences through the
// worker NAME as `<storePath>?durability=<dur>&backend=<backend>` (see ./store-registry-default) — the URL
// cannot carry them: Vite only bundles the worker chunk when the `new URL(...)` literal sits INLINE in the
// `new SharedWorker(...)` constructor, so appending a query to a hoisted URL silently ships the raw TS source
// as an asset in the build. The name participates in dedup identity exactly as the URL would, so a DIFFERENT
// value is a DIFFERENT worker — two tabs reading different values would each spawn their own engine on the ONE
// store. To keep every tab converged on a single engine per store the values are read from localStorage
// EXACTLY ONCE, at worker-construction time. A CHANGE first retires the workers constructed by this tab, then
// writes localStorage and RELOADS the page ({@link applyStoragePreferences}); retirement matters when
// `extendedLifetime` would otherwise keep the old-name worker's database handle open across reload. Tabs
// constructed after the reload agree on the new values; this is demo-grade convergence, not live re-hosting of
// every peer tab. Durability and backend are runtime attributes a fresh boot simply re-applies.

/** The single localStorage key holding the board's durability preference. */
export const DURABILITY_PREFERENCE_KEY = "board:durability-preference";

/** The single localStorage key holding the board's backend preference. */
export const BACKEND_PREFERENCE_KEY = "board:backend-preference";

const DEFAULT_DURABILITY: DurabilityPreference = "relaxed";

const DEFAULT_BACKEND: BackendPreference = "opfs";

/** Coerce an untrusted value (localStorage / a URL query param) to a valid {@link DurabilityPreference}, default `"relaxed"`. */
export function parseDurabilityPreference(value: string | null | undefined): DurabilityPreference {
  return value === "strict" ? "strict" : DEFAULT_DURABILITY;
}

/** Coerce an untrusted value (localStorage / a URL query param) to a valid {@link BackendPreference}, default `"opfs"`. */
export function parseBackendPreference(value: string | null | undefined): BackendPreference {
  return value === "idbfs" ? "idbfs" : DEFAULT_BACKEND;
}

/**
 * Read the persisted durability preference (default `"relaxed"`). Resilient to an unavailable localStorage
 * (privacy mode, disabled storage) — never a boot dependency, so any access failure falls back to the default.
 */
export function readDurabilityPreference(): DurabilityPreference {
  try {
    return parseDurabilityPreference(globalThis.localStorage.getItem(DURABILITY_PREFERENCE_KEY));
  } catch {
    return DEFAULT_DURABILITY;
  }
}

/**
 * Read the persisted backend preference (default `"opfs"`, the capability default). Resilient to an unavailable
 * localStorage (privacy mode, disabled storage) — never a boot dependency, so any access failure falls back to
 * the default.
 */
export function readBackendPreference(): BackendPreference {
  try {
    return parseBackendPreference(globalThis.localStorage.getItem(BACKEND_PREFERENCE_KEY));
  } catch {
    return DEFAULT_BACKEND;
  }
}

/**
 * The board's storage declaration ({@link SyncStorageDeclaration}) for a (durability, backend) pair — the SINGLE
 * stamp shape BOTH the tab (in-process fallback, board-client) and the worker (board-sync.worker) attach onto
 * the registry via `attachSyncRegistryStorage`, so the two sides declare BYTE-IDENTICAL contracts (the stamp is
 * idempotent for an equal re-declaration and THROWS on a conflicting one). `durability` is ALWAYS present
 * (default `"relaxed"`); `backend` is present ONLY when the demo explicitly forces idbfs — the `"opfs"` default
 * OMITS the key, leaving the toolkit to resolve the ADR-0047 capability default. Omission (not `backend: "opfs"`)
 * is what "capability default" means, and it is what keeps the default-case stamp equal on both sides.
 */
export function boardStorageDeclaration(
  durability: DurabilityPreference,
  backend: BackendPreference,
): SyncStorageDeclaration {
  return { durability, ...(backend === "idbfs" ? { backend } : {}) };
}

/**
 * The SharedWorker name for a store under the storage preferences — `<storePath>?durability=<dur>&backend=<backend>`.
 * The name is the TRANSPORT of both axes into the worker scope (see the identity caveat above): the worker reads
 * them back off `globalThis.name` via {@link durabilityPreferenceFromWorkerName} /
 * {@link backendPreferenceFromWorkerName}, and because the name is part of the worker dedup identity, every tab on
 * one store agrees on the values by construction. The name still embeds the store path, so the browser dedupes N
 * tabs onto ONE engine per store.
 */
export function workerNameForStore(
  storePath: string,
  durability: DurabilityPreference,
  backend: BackendPreference,
): string {
  return `${storePath}?durability=${durability}&backend=${backend}`;
}

/** Recover the durability preference a tab embedded in the worker name (default `"relaxed"`). */
export function durabilityPreferenceFromWorkerName(name: string): DurabilityPreference {
  return parseDurabilityPreference(workerNameQuery(name).get("durability"));
}

/** Recover the backend preference a tab embedded in the worker name (default `"opfs"`). */
export function backendPreferenceFromWorkerName(name: string): BackendPreference {
  return parseBackendPreference(workerNameQuery(name).get("backend"));
}

/** The query params a worker name carries (`<storePath>?durability=…&backend=…`), or empty for a bare name. */
function workerNameQuery(name: string): URLSearchParams {
  const queryIndex = name.indexOf("?");
  return new URLSearchParams(queryIndex >= 0 ? name.slice(queryIndex + 1) : "");
}

/** Persist the durability preference (best-effort — a genuinely unavailable localStorage leaves it at the default). */
export function writeDurabilityPreference(preference: DurabilityPreference): void {
  try {
    globalThis.localStorage.setItem(DURABILITY_PREFERENCE_KEY, preference);
  } catch {
    // Storage unavailable — the preference simply stays at its default; this is never a boot dependency.
  }
}

/** Persist the backend preference (best-effort — a genuinely unavailable localStorage leaves it at the default). */
export function writeBackendPreference(preference: BackendPreference): void {
  try {
    globalThis.localStorage.setItem(BACKEND_PREFERENCE_KEY, preference);
  } catch {
    // Storage unavailable — the preference simply stays at its default; this is never a boot dependency.
  }
}

/**
 * Apply a storage-preference CHANGE after the caller has retired this tab's constructed workers: persist BOTH
 * axes, then reload the page. The reload is REQUIRED, not cosmetic — the engine's worker was deduped under the
 * OLD name (`<storePath>?durability=<dur>&backend=<backend>`, see the identity caveat above), so only a fresh
 * page load reconstructs the worker under the new name. After the reload every newly opened tab agrees.
 */
export function applyStoragePreferences(durability: DurabilityPreference, backend: BackendPreference): void {
  writeDurabilityPreference(durability);
  writeBackendPreference(backend);
  globalThis.location.reload();
}
