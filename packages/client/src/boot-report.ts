// Boot observability (ADR-0034). Every client boot builds a structured, versioned {@link BootReport} as it
// runs and finalizes it exactly once at `onInitialSync` (the moment the `boot client ready` rail line fires
// and `ready` resolves). The report is a plain, allocation-light object — no class instance leaks out — so
// it structured-clones across the worker bridge unchanged.
//
// The numbers are captured INDEPENDENTLY of the debug rail: `timeAsync` only measures when
// `__pgxsinkitDebug` is on, but the report must exist on every boot, so the builder always measures. It
// still emits the SAME rail lines `timeAsync` would (`<event> start` / `<event> done {ms}`), gated by
// `syncDebug`'s own console/sink gate, so the log text tools and tests match is unchanged.

import { syncDebug } from "./debug";

/** Monotonic clock (ms) — `performance.now()` where available, else `Date.now()`. */
const nowMs = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());

/**
 * A structured, versioned record of one client boot (ADR-0034). `reportVersion` is a contract number:
 * additive fields keep it, a breaking reshape bumps it. All durations are milliseconds; all `*AtMs` are
 * offsets from boot start (the `startedAt` epoch anchor is the only wall-clock value).
 */
export interface BootReport {
  reportVersion: 1;
  /** How the engine booted: the in-process client (bun/Node/fallback) or inside `defineSyncWorker`. */
  mode: "in-process" | "worker";
  /** Whether the caller proved the store a schemaless spare (the ADR-0032 S4 fresh-store hint). */
  freshStore: boolean;
  /**
   * How this store presented at boot: `"restored"` when the boot seeded a brand-new store from a backup
   * (ADR-0035 `restoreFrom`); `"fresh"` when the caller proved it a schemaless spare (the SAME signal as
   * {@link BootReport.freshStore}); `"warm"` otherwise (an existing persisted store — the common case).
   * Distinct from `freshStore`, which stays a bare boolean: `storeKind` additionally names the restore case,
   * which a boolean cannot express.
   */
  storeKind: "fresh" | "warm" | "restored";
  /**
   * The store backend this boot actually opened (ADR-0049 decision 12): `"opfs-repacked"` (the placement probe
   * granted sync-access handles in the engine home), `"idbfs"` (browser/worker, handles denied — today's default),
   * `"filesystem"` (Bun/Node), or `"memory"` (the sanctioned test/ephemeral lane). Derived from the minted dataDir
   * scheme at the single client-owned mint seam; absent (omitted) on a BYO instance whose backend is underivable.
   * Additive field; `reportVersion` stays `1`. Distinct from {@link BootReport.storeKind}, which is untouched.
   */
  storageBackend?: "opfs-repacked" | "idbfs" | "filesystem" | "memory";
  /**
   * Where the engine ran for this boot (ADR-0049 decision 12): `"in-process"` for the main-thread/Bun
   * `createSyncClient`; inside `defineSyncWorker`, the placement-probe result — `"shared-worker"` (the engine boots
   * in the SharedWorker itself, WebKit today) or `"elected-worker"` (a tab-spawned dedicated worker holds the
   * handles, Chromium/Firefox). Absent (omitted) when the boot cannot derive it (e.g. a dedicated elected-engine
   * worker that never ran the SharedWorker placement decision). Additive field; `reportVersion` stays `1`.
   */
  engineHome?: "shared-worker" | "elected-worker" | "in-process";
  /**
   * The verbatim reason an opfs-CAPABLE boot (the probe granted sync-access handles) nonetheless opened `idbfs`
   * (ADR-0049 decision 12). Set ONLY when such a fallback actually occurred — never on a plain idb boot (the probe
   * denied from the start), and never on a granted opfs boot that stayed on opfs. Today's set-sites are the
   * granted-then-idb transitions the client owns: a declaration-gated adoption that deferred/failed (idb stays
   * authoritative) and the recordless idb-store downgrade (invariant 14 — never a fresh opfs mint over an
   * existing idb store's data). Additive field; `reportVersion` stays `1`.
   */
  storageFallbackReason?: string;
  /** Whether the ADR-0032 S4 fetch/schema overlap was active for this boot. */
  overlapPrefetch: boolean;
  /** The registry fingerprint the store is provisioned under — the same value store-version reconcile stamps. */
  registryFingerprint: string;
  /** Epoch anchor (`Date.now()`) at boot start; every other duration/offset is monotonic relative to it. */
  startedAt: number;
  /** Boot start → `onInitialSync` (all eager groups caught up). */
  totalMs: number;
  /**
   * Boot start → `localReadReady` resolved (ADR-0041): PGlite open, durable schema compatible, store-version
   * reconcile complete, and the drizzle read facade built — cached reads are safe with ZERO network. `null`
   * when the boot rejected before the stage. Additive field; `reportVersion` stays `1`.
   */
  localReadReadyMs: number | null;
  /**
   * Boot start → `writeReady` resolved (ADR-0041): the mutation runtime is constructed and boot recovery
   * (plus restore quarantine on a restore boot) has completed — enqueue is safe. `null` when the boot
   * rejected before the stage. Additive field; `reportVersion` stays `1`.
   */
  writeReadyMs: number | null;
  /**
   * Present only when the store was pre-provisioned (a spare's initdb ran off-thread before this boot
   * adopted it); `null` otherwise. When present, `phases.pgliteCreateMs` is `null` — the create cost is
   * reported here instead.
   */
  provision: {
    /** The spare's PGlite create (initdb) cost, paid at provision time. */
    initdbMs: number;
    /** How long the provisioned store sat ready before this boot adopted it. */
    provisionedMsBeforeBoot: number;
  } | null;
  phases: {
    /** PGlite create cost, or `null` when the store was adopted from a spare (see {@link BootReport.provision}). */
    pgliteCreateMs: number | null;
    schemaExecMs: number;
    journalRecoveryMs: number;
    storeVersionReconcileMs: number;
    /**
     * `startConfiguredSync`: stream/group construction wall. On an overlap boot (ADR-0032 S4,
     * {@link BootReport.overlapPrefetch}) the early-started segment runs concurrently with schema, journal
     * recovery, and registry reconciliation, so this includes that shared wall. Structurally 0 when the boot
     * is ready inside the
     * sync-start call itself (zero eager groups / instant catch-up) — finalize runs before the phase closes.
     */
    syncStartMs: number;
    /** Sync-start done → last eager boot group ready. */
    catchupMs: number;
    /**
     * Cumulative time in configured prepare hooks (`prepareLocalDbBeforeSchema` + `prepareLocalDbAfterSchema`), present
     * only when at least one hook is configured. Not part of the required v1 shape (ADR-0034).
     */
    prepareMs?: number;
  };
  /**
   * Warm-store observability for the durable-schema and journal-recovery fast paths. Grouped like
   * {@link BootReport.phases} so the flags structured-clone across the worker bridge as one unit.
   */
  warmBoot: {
    /** Whether durable-schema replay was skipped this boot because the stored fingerprint matched. */
    schemaSkipped: boolean;
    /** Whether the stored durable-schema fingerprint matched the generated schema. */
    schemaFingerprintMatch: boolean;
    /** Whether the boot-time `recoverSending` journal pass was skipped this boot. */
    journalRecoverySkipped: boolean;
    /**
     * Whether the durable recovery marker required journal recovery this boot. A clean settle clears the marker,
     * allowing the next boot to skip the recovery pass.
     */
    journalRecoveryRequired: boolean;
    /** How many writable table journals the boot-time `recoverSending` pass visited (the registry's writable-entry count). */
    journalTablesVisited: number;
    /** Rows lifted `sending → pending` by recovery; `null` when the selected recovery path cannot count them. */
    journalRowsRecovered: number | null;
  };
  /**
   * Per consistency GROUP, for the eager + promoted boot groups only (a lazily-activated-later group never
   * appears — nor mutates a finalized report). Groups run concurrently, so `fetchMs`/`applyMs` are per-group
   * wall SEGMENTS, not a partition of `totalMs`.
   */
  groups: Array<{
    groupKey: string;
    /** Number of member tables (shapes) in the group. */
    tables: number;
    /** Offset from boot start when the group's streams started. */
    startedAtMs: number;
    /** Offset from boot start when the group reached its initial sync. */
    readyAtMs: number;
    /** Number of batch deliveries the group's stream chain received during boot catch-up. */
    requests: number;
    /** Number of change rows ingested during boot catch-up. */
    rows: number;
    /**
     * Settle→next-delivery wall within this group's chain. On the single-threaded WASM host this absorbs
     * OTHER groups' apply transactions and main-thread work between deliveries — read it as "time this
     * group spent not applying", an upper bound on its network wait, not pure network cost.
     */
    fetchMs: number;
    /**
     * Wall around this group's batch commits into PGlite. Includes waiting behind another group's
     * transaction on the shared connection (single writer), so concurrent groups' `applyMs` can overlap.
     */
    applyMs: number;
  }>;
}

/** The phase durations the builder captures by key; `catchupMs` is derived, not a captured phase. */
type PhaseKey = "schemaExec" | "journalRecovery" | "storeVersionReconcile" | "syncStart";

/**
 * The per-group accumulator the engine stamps as a boot group's stream chain delivers and applies (ADR-0034).
 * One per consistency group (one `syncShapesToTables` call). Frozen at the group's ready edge so later live
 * traffic never mutates a finalized report.
 */
export interface GroupBootStamp {
  /** A batch was delivered to the group's subscribe callback (one response). `changeCount` = its change rows. */
  onBatchDelivered: (changeCount: number) => void;
  /** A commit transaction applied `ms` of work into PGlite for this group. */
  onApply: (ms: number) => void;
  /** The group reached its initial sync — stamp `readyAtMs` and freeze accumulation. */
  markReady: () => void;
}

/** The seam `startConfiguredSync` uses to open a boot group's accumulator (implemented by the builder). */
export interface BootStampCollector {
  beginGroup: (groupKey: string, tables: number) => GroupBootStamp;
}

interface GroupAccumulator extends GroupBootStamp {
  snapshot: () => BootReport["groups"][number];
}

function createGroupAccumulator(groupKey: string, tables: number, bootStartPerf: number): GroupAccumulator {
  const startedAtMs = nowMs() - bootStartPerf;
  let requests = 0;
  let rows = 0;
  let fetchMs = 0;
  let applyMs = 0;
  let readyAtMs: number | null = null;
  // `markReady` fires from INSIDE the ready-causing commit (before that delivery's `onApply` runs), so we
  // must record that commit's apply before freezing. So `markReady` only flags ready; the freeze snaps shut
  // at the START of the NEXT delivery — the first that is genuinely post-boot live traffic.
  let readyReached = false;
  let frozen = false;
  // Marks the last settle point; the gap to the next delivery is fetch (network) wait. Seeded at creation so
  // the first delivery's gap is the initial catch-up wait.
  let lastMark = nowMs();

  return {
    onBatchDelivered: (changeCount) => {
      // A delivery arriving after the group is ready is post-boot live traffic — freeze here so it (and its
      // apply) is excluded, leaving the ready-causing batch fully recorded.
      if (readyReached) frozen = true;
      if (frozen) return;
      const now = nowMs();
      fetchMs += Math.max(0, now - lastMark);
      lastMark = now;
      requests += 1;
      rows += changeCount;
    },
    onApply: (ms) => {
      if (frozen) return;
      applyMs += ms;
      // Exclude the apply wall from the NEXT fetch gap (the apply happens inside the delivery callback).
      lastMark = nowMs();
    },
    markReady: () => {
      if (readyAtMs != null) return;
      readyAtMs = nowMs() - bootStartPerf;
      readyReached = true;
    },
    snapshot: () => ({
      groupKey,
      tables,
      startedAtMs,
      readyAtMs: readyAtMs ?? nowMs() - bootStartPerf,
      requests,
      rows,
      fetchMs,
      applyMs,
    }),
  };
}

/** Builds a {@link BootReport} across a boot and finalizes it exactly once. Owned by `createSyncClient`. */
export interface BootReportBuilder extends BootStampCollector {
  /** The monotonic anchor (`performance.now()` at boot start) every offset is relative to. */
  readonly bootStartPerf: number;
  /**
   * Time `fn`, always measuring (unlike `timeAsync`, which only measures when the rail is on) and capturing
   * the duration into the report, while emitting the SAME rail lines `timeAsync` would. `key` is `null` for
   * a prepare hook (folded into the optional `prepareMs`).
   */
  phase: <T>(
    key: PhaseKey | "prepare",
    event: string,
    fn: () => Promise<T>,
    data?: Record<string, unknown>,
  ) => Promise<T>;
  setPgliteCreateMs: (ms: number | null) => void;
  setProvision: (provision: BootReport["provision"]) => void;
  /**
   * Stamp `storageBackend` (ADR-0049 decision 12) at the client-owned mint seam, derived from the resolved dataDir
   * scheme. Idempotent — the first stamp wins (the mint runs once per boot). Never called on a BYO instance whose
   * backend is underivable, leaving the field absent.
   */
  setStorageBackend: (backend: NonNullable<BootReport["storageBackend"]>) => void;
  /**
   * Stamp `storageFallbackReason` (ADR-0049 decision 12) — the verbatim reason an opfs-capable boot opened `idbfs`.
   * Called ONLY when such a fallback occurred; a boot that never falls back leaves the field absent. Idempotent —
   * the first stamp wins.
   */
  setStorageFallbackReason: (reason: string) => void;
  /**
   * Record the durable-schema fast-path outcome (the durable-schema-fingerprint slice): whether replay was
   * skipped and whether the stored fingerprint matched. Both default to the current truth (`false`), so this
   * need not be called until that slice lands.
   */
  setSchemaFastPath: (info: { skipped: boolean; fingerprintMatch: boolean }) => void;
  /**
   * Record the boot-time journal-recovery outcome (the recovery-marker slice): whether the pass was skipped,
   * whether it was required, how many writable journals it visited, and how many rows it lifted (`null` until
   * instrumented). `tablesVisited` is wired from boot today; the rest default to current-truth values.
   */
  setJournalRecovery: (info: {
    skipped: boolean;
    required: boolean;
    tablesVisited: number;
    rowsRecovered: number | null;
  }) => void;
  /**
   * Stamp `localReadReadyMs` at the moment the staged local-read core resolves `localReadReady` (ADR-0041).
   * Idempotent — the first stamp wins.
   */
  setLocalReadReadyMs: (ms: number) => void;
  /**
   * Stamp `writeReadyMs` at the moment the write/recovery tail resolves `writeReady` (ADR-0041). Idempotent —
   * the first stamp wins.
   */
  setWriteReadyMs: (ms: number) => void;
  /**
   * Record `phases.syncStartMs` directly — for the ADR-0032 S4 overlap path, where sync construction is
   * kicked off before schema exec (not wrapped in {@link BootReportBuilder.phase}) and has no rail line.
   */
  setSyncStartMs: (ms: number) => void;
  /** Capture the offset at which sync construction completed — the base for `catchupMs`. */
  markSyncStartDone: () => void;
  /** Build + store the report once (idempotent). Returns the report, or the already-built one on a re-call. */
  finalize: () => BootReport;
  /** The finalized report, or `null` before the first boot completes / after an early stop. */
  report: () => BootReport | null;
}

/** Inputs known at boot start — the flags and identity the report carries verbatim. */
export interface BootReportInit {
  mode: BootReport["mode"];
  freshStore: boolean;
  storeKind: BootReport["storeKind"];
  /**
   * The engine home for this boot (ADR-0049 decision 12), known at boot start. Omitted (`undefined`) when it
   * cannot be derived up front — the finalized report then carries no `engineHome`.
   */
  engineHome?: BootReport["engineHome"];
  overlapPrefetch: boolean;
  registryFingerprint: string;
}

export function createBootReportBuilder(init: BootReportInit): BootReportBuilder {
  const startedAt = Date.now();
  const bootStartPerf = nowMs();
  const durations = new Map<PhaseKey, number>();
  let prepareMs: number | null = null;
  let pgliteCreateMs: number | null = null;
  let provision: BootReport["provision"] = null;
  // Conservative defaults used until the boot path reports its actual schema and recovery outcomes through
  // the setters below.
  let warmBoot: BootReport["warmBoot"] = {
    schemaSkipped: false,
    schemaFingerprintMatch: false,
    journalRecoverySkipped: false,
    journalRecoveryRequired: true,
    journalTablesVisited: 0,
    journalRowsRecovered: null,
  };
  let syncStartDoneOffset: number | null = null;
  let localReadReadyMs: number | null = null;
  let writeReadyMs: number | null = null;
  // ADR-0049 decision 12 diagnostics — both stamped during the boot (after this builder is created), so they are
  // mutable locals, not `init` fields. Absent (undefined) until stamped; the finalize output omits them then.
  let storageBackend: NonNullable<BootReport["storageBackend"]> | undefined;
  let storageFallbackReason: string | undefined;
  const groups: GroupAccumulator[] = [];
  let built: BootReport | null = null;

  const duration = (key: PhaseKey): number => durations.get(key) ?? 0;

  return {
    bootStartPerf,
    phase: async (key, event, fn, data) => {
      const startedAtPerf = nowMs();
      // Mirror `timeAsync`'s rail lines exactly (text tools/tests match); `syncDebug` self-gates the console.
      syncDebug(`${event} start`, data);
      try {
        return await fn();
      } finally {
        const ms = nowMs() - startedAtPerf;
        syncDebug(`${event} done`, { ms: Math.round(ms) });
        if (key === "prepare") prepareMs = (prepareMs ?? 0) + ms;
        else durations.set(key, ms);
      }
    },
    setPgliteCreateMs: (ms) => {
      pgliteCreateMs = ms;
    },
    setProvision: (value) => {
      provision = value;
    },
    setStorageBackend: (backend) => {
      if (storageBackend == null) storageBackend = backend;
    },
    setStorageFallbackReason: (reason) => {
      if (storageFallbackReason == null) storageFallbackReason = reason;
    },
    setSchemaFastPath: (info) => {
      warmBoot = { ...warmBoot, schemaSkipped: info.skipped, schemaFingerprintMatch: info.fingerprintMatch };
    },
    setJournalRecovery: (info) => {
      warmBoot = {
        ...warmBoot,
        journalRecoverySkipped: info.skipped,
        journalRecoveryRequired: info.required,
        journalTablesVisited: info.tablesVisited,
        journalRowsRecovered: info.rowsRecovered,
      };
    },
    setLocalReadReadyMs: (ms) => {
      if (localReadReadyMs == null) localReadReadyMs = ms;
    },
    setWriteReadyMs: (ms) => {
      if (writeReadyMs == null) writeReadyMs = ms;
    },
    setSyncStartMs: (ms) => {
      durations.set("syncStart", ms);
    },
    markSyncStartDone: () => {
      syncStartDoneOffset = nowMs() - bootStartPerf;
    },
    beginGroup: (groupKey, tables) => {
      const accumulator = createGroupAccumulator(groupKey, tables, bootStartPerf);
      groups.push(accumulator);
      return accumulator;
    },
    finalize: () => {
      if (built) return built;
      const totalMs = nowMs() - bootStartPerf;
      const syncStartBase = syncStartDoneOffset ?? totalMs;
      built = {
        reportVersion: 1,
        mode: init.mode,
        freshStore: init.freshStore,
        storeKind: init.storeKind,
        // ADR-0049 decision 12 diagnostics: additive and OMITTED when not derivable/stamped (so an unstamped boot
        // — or a BYO instance with an underivable backend — carries none of them), keeping `reportVersion` at 1.
        ...(init.engineHome != null ? { engineHome: init.engineHome } : {}),
        ...(storageBackend != null ? { storageBackend } : {}),
        ...(storageFallbackReason != null ? { storageFallbackReason } : {}),
        overlapPrefetch: init.overlapPrefetch,
        registryFingerprint: init.registryFingerprint,
        startedAt,
        totalMs,
        localReadReadyMs,
        writeReadyMs,
        provision,
        warmBoot,
        phases: {
          pgliteCreateMs,
          schemaExecMs: duration("schemaExec"),
          journalRecoveryMs: duration("journalRecovery"),
          storeVersionReconcileMs: duration("storeVersionReconcile"),
          syncStartMs: duration("syncStart"),
          catchupMs: Math.max(0, totalMs - syncStartBase),
          ...(prepareMs != null ? { prepareMs } : {}),
        },
        groups: groups.map((group) => group.snapshot()),
      };
      return built;
    },
    report: () => built,
  };
}
