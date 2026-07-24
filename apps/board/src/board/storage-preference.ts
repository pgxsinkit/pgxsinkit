import type { StorageBackend, StorageDurability, SyncStorageDeclaration } from "@pgxsinkit/contracts";

/**
 * The board's demo durability axis, a {@link StorageDurability} (ADR-0047). Durability is part of the store's
 * Storage declaration; the board's demo affordance is to pick the value in localStorage and send it as the
 * WIRE declaration (ADR-0050) on every worker port and provision/attach payload — the board's registries stay
 * storage-silent, because a dynamic toggle must not be pinned by the static, authoritative registry seam.
 */
export type DurabilityPreference = StorageDurability;

/**
 * The board's demo BACKEND axis, a {@link StorageBackend} (ADR-0049 decision 1). Like durability it travels
 * in the wire declaration, but its two values are asymmetric: `"idbfs"` FORCES the in-SharedWorker idbfs
 * engine with no capability probe/election, while `"opfs"` (the default) is the capability default — the
 * toolkit probes for an opfs sync-access home and falls back to idbfs when none exists. Only an explicit
 * `"idbfs"` is declared (see {@link boardStorageDeclaration}); the `"opfs"` default declares NOTHING for the
 * backend field, leaving the toolkit to resolve the capability default.
 */
export type BackendPreference = StorageBackend;

// The board's demo surface for the storage preferences (ADR-0050). Both axes live in localStorage, are read
// at boot, and reach the engine as the WIRE storage declaration: `attachSyncClient`/`provisionSyncWorker`
// post it on every worker port before the placement query (so `idbfs` can skip the probe), and carry it on
// the provision/attach payloads (so the engine's mint binds the durability). The worker NAME carries the
// store path only — configuration in the name made preference changes replace the worker under a live
// extended-lifetime predecessor, which is exactly the fault ADR-0050 removed.
//
// A store's declaration is IMMUTABLE (first arrival binds; explicit conflicts are typed refusals), so a
// preference CHANGE never redeclares an existing store: Apply obsoletes the current bindings (fresh stores
// mint under fresh paths on the next boot), then writes the new values and reloads — see
// {@link applyStoragePreferences} and store-registry's `obsoleteAllStores`.

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
 * The board's storage declaration ({@link SyncStorageDeclaration}) for a (durability, backend) pair — the
 * WIRE declaration (ADR-0050) the tab sends on every worker port and provision/attach payload, and the shape
 * the in-process fallback stamps onto its (single-scope) registry. `durability` is ALWAYS present (default
 * `"relaxed"`); `backend` is present ONLY when the demo explicitly forces idbfs — the `"opfs"` default OMITS
 * the key ("no opinion"), leaving the toolkit to resolve the capability default. Omission (not
 * `backend: "opfs"`) is what "capability default" means.
 */
export function boardStorageDeclaration(
  durability: DurabilityPreference,
  backend: BackendPreference,
): SyncStorageDeclaration {
  return { durability, ...(backend === "idbfs" ? { backend } : {}) };
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
 * Apply a storage-preference CHANGE: persist both axes, then reload. Call ORDER matters and the caller owns
 * the first step — `obsoleteAllStores()` (store-registry) must run BEFORE this, so an interruption between
 * the two leaves the OLD preferences with dropped bindings (harmless: the next boot mints fresh stores under
 * the old declaration) rather than the NEW preferences with the old paths still bound (a fresh boot would
 * reopen an old store under a different declaration — the exact mismatch ADR-0050 forbids). The reload is
 * REQUIRED: declarations are immutable per store, so the new preference takes effect only on the fresh
 * stores the next boot mints.
 */
export function applyStoragePreferences(durability: DurabilityPreference, backend: BackendPreference): void {
  writeDurabilityPreference(durability);
  writeBackendPreference(backend);
  globalThis.location.reload();
}
