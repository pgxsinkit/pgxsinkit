// The placement probe (ADR-0049 decision 1, plan step 4). The SharedWorker decides its engine home by
// ACTUALLY opening a sync-access handle in its own scope — the bench phase-0 mechanism
// (`apps/perf-lab/src/bench/sharedworker-proof.worker.ts`, probe stage) — never by sniffing for the
// PRESENCE of `createSyncAccessHandle` on a prototype. Presence says nothing: Chromium and Firefox
// expose the method in a SharedWorker yet REFUSE the open there, while WebKit grants it. Only a real open
// tells the truth, so the verdict here is a real open on a throwaway scratch file, removed afterwards.
//
// NEVER CACHED (invariant 8: "probe per boot"). There is deliberately no module-level memo: engines and
// modes change across SharedWorker lifetimes, and a stale grant would place the engine in a scope that no
// longer holds handles. Every call runs the full probe. This module owns no state whatsoever.
//
// The probe operates ENTIRELY under the toolkit's `pgxsinkit/probe/` namespace (from
// `opfsProbeDirectoryPath()` — never re-derived here). It never touches the OPFS root directly and NEVER
// goes inside or beside any store directory: a store directory is under whole-directory ownership by the
// opfs-repacked VFS (ADR-0048), which fails CLOSED on any unowned entry it finds, so a scratch file placed
// there would poison a real store's boot. The probe namespace is disjoint from `pgxsinkit/stores` and
// `pgxsinkit/commitments` (ADR-0049 D6, invariant 11), so it can never contend with a store.

import { opfsProbeDirectoryPath } from "./store-path";

/** Monotonic clock (ms) — `performance.now()` where available, else `Date.now()` (matches `boot-report.ts`). */
const nowMs = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());

/**
 * The minimal structural shape of the OPFS sync-access handle the probe opens and immediately closes. The
 * open is the whole verdict; `close()` releases it so the scratch file can be removed. Typed locally so this
 * module carries no DOM lib dependency (the pattern `store-path.ts` uses for OPFS handles).
 */
export interface OpfsSyncAccessHandle {
  close(): void;
}

/**
 * The minimal structural shape of an OPFS `FileSystemFileHandle` the probe opens a sync-access handle on.
 * `createSyncAccessHandle` is typed as POSSIBLY ABSENT on purpose: the probe never pre-checks it — it calls
 * it, and absence at CALL time surfaces as the thrown `TypeError` we report verbatim, which is itself an
 * honest "no sync access here" verdict rather than a presence sniff.
 */
export interface OpfsProbeFileHandle {
  createSyncAccessHandle?: () => Promise<OpfsSyncAccessHandle>;
}

/**
 * The minimal structural shape of the OPFS `FileSystemDirectoryHandle` the probe walks and creates under.
 * All three hops use `{ create: true }`: the probe MAKES its namespace (unlike `store-path.ts`'s
 * never-creating existence walk). Declared locally so this module carries no DOM lib dependency.
 */
export interface OpfsProbeDirectoryHandle {
  getDirectoryHandle(name: string, options: { create: true }): Promise<OpfsProbeDirectoryHandle>;
  getFileHandle(name: string, options: { create: true }): Promise<OpfsProbeFileHandle>;
  removeEntry(name: string): Promise<void>;
}

/** The outcome of one placement probe. The probe ANSWERS; it never rejects. */
export interface PlacementProbeResult {
  /** True only when a REAL `createSyncAccessHandle` open succeeded in this scope. */
  granted: boolean;
  /** Verbatim `Name: message` of the denial/failure when not granted (diagnostics; never parsed). */
  error?: string;
  /** Wall-clock ms the probe took (injectable clock). */
  ms: number;
}

/** Injectable seams so the probe is deterministic in a Bun unit test (no real OPFS there). */
export interface PlacementProbeDeps {
  /**
   * The OPFS root getter. Omit in production: the default reads `navigator.storage.getDirectory` off
   * `globalThis` (structural, no DOM lib). Absent API → the API-absent verdict below.
   */
  getRoot?: () => Promise<OpfsProbeDirectoryHandle>;
  /**
   * The scratch file name to open under `pgxsinkit/probe/`. Defaults to `probe-<random>` — UNIQUE per call
   * so concurrent SharedWorkers (different stores, same origin) can probe simultaneously without contending
   * on one file. Injected for deterministic tests.
   */
  scratchName?: string;
  /** Wall clock. Defaults to `performance.now()`-or-`Date.now()` (the `boot-report.ts` `nowMs` pattern). */
  now?: () => number;
}

/** The API-absent verdict message — no throw occurred, so there is no `Name: message` to report verbatim. */
const OPFS_API_ABSENT_ERROR = "OPFS API not available: navigator.storage.getDirectory is absent in this scope";

/** Verbatim `Name: message` attribution the diagnostics envelope wants (never parsed downstream). */
function describeProbeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/** The default scratch suffix — a short random tail so each probe file is unique per call. */
function defaultScratchName(): string {
  const uuid = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto?.randomUUID?.();
  // `randomUUID` exists in every scope pgxsinkit runs a probe in (browser SharedWorker, Bun); the fallback
  // only guards exotic embeds and is still unique enough for a per-call scratch name.
  return `probe-${uuid ? uuid.slice(0, 8) : Math.random().toString(36).slice(2, 10)}`;
}

/** Resolve the default OPFS root getter off `globalThis`, or `null` when the API is absent. */
function resolveDefaultGetRoot(): (() => Promise<OpfsProbeDirectoryHandle>) | null {
  const storage = (
    globalThis as {
      navigator?: { storage?: { getDirectory?: () => Promise<OpfsProbeDirectoryHandle> } };
    }
  ).navigator?.storage;
  const getDirectory = storage?.getDirectory;
  if (getDirectory == null) return null;
  return () => getDirectory.call(storage);
}

/**
 * Probe whether a REAL `createSyncAccessHandle` open succeeds in the executing scope — the ADR-0049 D1
 * verdict that decides the engine home. Granted → the engine boots in this scope (SharedWorker-direct) and
 * election never engages; denied → router-only mode (attach acks carry `electionRequired: true`).
 *
 * Sequence, all under the `pgxsinkit/probe/` namespace ({@link opfsProbeDirectoryPath}):
 *   1. Resolve the OPFS root (`navigator.storage.getDirectory()`); API absent → {@link OPFS_API_ABSENT_ERROR}.
 *   2. Walk/create `pgxsinkit` → `probe` (`{ create: true }`).
 *   3. Create the scratch file (`{ create: true }`).
 *   4. Call `createSyncAccessHandle()` — the verdict. Absence at call time throws a `TypeError` we report.
 *   5. On success: `close()` the handle → granted.
 *   6. ALWAYS (finally): `removeEntry` the scratch file, best-effort.
 *
 * Any throw in steps 1–4 (bar the API-absent early return) → `{ granted: false, error: "Name: message" }`.
 * The probe NEVER rethrows: it answers, it never fails. And it is NEVER cached — every call probes afresh
 * (invariant 8).
 */
export async function probeOpfsSyncAccess(deps: PlacementProbeDeps = {}): Promise<PlacementProbeResult> {
  const now = deps.now ?? nowMs;
  const start = now();
  const elapsed = (): number => Math.max(0, now() - start);

  const getRoot = deps.getRoot ?? resolveDefaultGetRoot();
  if (getRoot == null) {
    // API absent: no handle open was even attempted, so there is no thrown error to attribute verbatim.
    return { granted: false, error: OPFS_API_ABSENT_ERROR, ms: elapsed() };
  }

  const scratchName = deps.scratchName ?? defaultScratchName();
  const [container, probe] = opfsProbeDirectoryPath();

  // Held so `finally` can remove the scratch file once the probe directory has been resolved; undefined
  // means the walk never got that far (nothing to clean up).
  let probeDir: OpfsProbeDirectoryHandle | undefined;
  try {
    const root = await getRoot();
    const containerHandle = await root.getDirectoryHandle(container, { create: true });
    probeDir = await containerHandle.getDirectoryHandle(probe, { create: true });
    const fileHandle = await probeDir.getFileHandle(scratchName, { create: true });
    // Call, never pre-check: absence surfaces as the thrown TypeError we report verbatim (a real "no sync
    // access" verdict), not as a method-presence sniff.
    const open = (fileHandle as { createSyncAccessHandle: () => Promise<OpfsSyncAccessHandle> }).createSyncAccessHandle;
    const handle = await open.call(fileHandle);
    handle.close();
    return { granted: true, ms: elapsed() };
  } catch (error) {
    return { granted: false, error: describeProbeError(error), ms: elapsed() };
  } finally {
    if (probeDir != null) {
      try {
        await probeDir.removeEntry(scratchName);
      } catch {
        // Best-effort cleanup: a leftover scratch file in the probe namespace harms nothing (it is not a
        // store, and the next probe uses a fresh unique name), and a cleanup error must NEVER demote a
        // granted verdict — the verdict was already decided by the open above.
      }
    }
  }
}
