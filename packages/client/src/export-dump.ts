// Diagnostic dump (ADR-0035, via the throwaway clone of the addendum). Where a store backup keeps the
// datadir tarball as its artefact, a diagnostic dump turns the store into human-readable SQL — every table
// (synced + the `_overlay`/`_mutations` journal), the `pgxsinkit` metadata schema, the read-model views,
// and the reconcile functions/triggers — so a support engineer sees the misbehaving store EXACTLY as it
// holds it, unflushed writes and all.
//
// The mechanism is the addendum's throwaway clone, NOT the abandoned suspend/reopen seam: (1) take a LIVE
// datadir dump of the running store (the SAME checkpoint + `dumpDataDir` core the store backup uses, but
// uncompressed — the clone consumes it immediately, so the gzip+gunzip round trip is pure waste); (2) boot
// a memory-backed THROWAWAY pgwasm from that dump via `loadDataDir` — engine-less, no `live` extension,
// nothing `pg_dump`'s `DEALLOCATE ALL` can corrupt; (3) run `pg_dump` against the throwaway; (4) discard
// it. The live engine is never touched — the addendum's whole point — so tabs never notice beyond the
// lifecycle slot reporting busy.
//
// `@pgxsinkit/pgwasm-pg-dump` is loaded ONLY via the dynamic `import()` below (ADR-0035 decision 7): its
// ~700 kB `pg_dump.wasm` (+ ~100 kB JS) stays off boot and off every non-exporting bundle, fetched on first
// `exportDiagnostics`.

import type { MutationDiagnostics } from "@pgxsinkit/contracts";
import { createPgwasm, type Pgwasm } from "@pgxsinkit/pgwasm";
import { cBuild } from "@pgxsinkit/pgwasm-c";

import { compactTimestamp, type DiagnosticDumpReport, deriveStoreId, nowMs, performDatadirDump } from "./export-store";
import type { PgwasmClient } from "./index";
import { resolveStoreDataDir } from "./store-path";

/** Options for {@link SyncClient.exportDiagnostics}. */
export interface DiagnosticExportOptions {
  /**
   * Override the generated artefact file name. When omitted, the name is
   * `<storeId>-<timestamp>-diagnostics.sql`, where `storeId` is a filesystem-safe derivation of the store
   * path (see `deriveStoreId`).
   */
  fileName?: string;
}

/** The SQL artefact + its report — the resolved value of {@link SyncClient.exportDiagnostics}. */
export interface DiagnosticExportResult {
  /** The `pg_dump` output as a named `File` (`application/sql`), loadable into a vanilla Postgres. */
  file: File;
  /** The structured record of the export (ADR-0035). */
  report: DiagnosticDumpReport;
}

/** The dependencies {@link performDiagnosticExport} needs from the owning client — narrow, so it is unit-testable. */
export interface DiagnosticExportDeps {
  /** The live store to checkpoint and dump (the clone source; the live engine is never suspended). */
  pgwasm: Pick<PgwasmClient, "exec" | "dumpDataDir">;
  /** The Mutation diagnostics seam (`client.diagnostics().mutation` / `readMutationStats`). */
  readMutationStats: () => Promise<MutationDiagnostics>;
  /**
   * The store's configured plain store PATH (ADR-0036) — reduced to the `storeId` in the default artefact
   * file name. The resolved pgwasm dataDir URL is deliberately NOT used: it is internal plumbing and must
   * not leak into an artefact name as something to imitate.
   */
  storePath?: string;
}

/**
 * A process-unique suffix source for the throwaway clone's store name. The clone is memory-backed and
 * closed in a `finally`, so a collision would only matter if two dumps overlapped — the lifecycle slot
 * already forbids that — but a monotonic counter plus a random token makes the name collision-free by
 * construction regardless, so a stray second clone can never adopt a live one's memory namespace.
 */
let cloneCounter = 0;
const nextCloneStorePath = (): string =>
  `pgxsinkit-export-clone-${++cloneCounter}-${Math.random().toString(36).slice(2, 10)}`;

/** The four extra phase walls the throwaway-clone pipeline adds on top of the shared checkpoint/dump pair. */
export interface CloneDumpPhases {
  /** Offset from `startPerf` when the internal `dumpDataDir` (the clone's source) began. */
  dumpStartedAtMs: number;
  /** `dumpDataDir` wall — the uncompressed internal tarball the throwaway clone boots from (`compression: "none"`). */
  dumpMs: number;
  /** Offset from `startPerf` when the `CHECKPOINT` began. */
  checkpointStartedAtMs: number;
  /** `CHECKPOINT` wall — flushing dirty buffers before the internal datadir dump the clone consumes. */
  checkpointMs: number;
  /** Offset from `startPerf` when the throwaway clone's `pgwasm.create({ loadDataDir })` began. */
  cloneBootStartedAtMs: number;
  /** Clone boot wall — booting the memory-backed throwaway from the internal dump. */
  cloneBootMs: number;
  /** Offset from `startPerf` when `pg_dump` began running against the clone. */
  pgDumpStartedAtMs: number;
  /** `pg_dump` wall — the WASM `pg_dump` reading the clone out to SQL. */
  pgDumpMs: number;
}

/** The raw SQL bytes plus the pipeline phase walls — {@link runThrowawayCloneDump}'s result. */
export interface CloneDumpResult {
  /** The `pg_dump` output bytes (unwrapped from the `File` `pgDump` returns). */
  sqlBytes: Uint8Array<ArrayBuffer>;
  /** The pipeline phase timings, all offset from the caller's `startPerf` anchor. */
  phases: CloneDumpPhases;
}

/**
 * The throwaway-clone dump core shared by BOTH `pgDump` exports (ADR-0035 addendum): (1) a LIVE datadir dump
 * of the running store (`compression: "none"` — the clone consumes the bytes immediately, so gzip+gunzip is
 * pure waste); (2) a memory-backed THROWAWAY pgwasm booted from it via `loadDataDir` — engine-less, no
 * `live` extension, nothing `pg_dump`'s `DEALLOCATE ALL` can corrupt; (3) `pg_dump` against the throwaway
 * with the caller's `args` (none for a diagnostic dump; the `-t` allowlist + `--no-owner` for a data
 * export); (4) discard the clone in a `finally`. Factored out so `performDiagnosticExport` and
 * `performDataExport` cannot drift on the clone plumbing, the memory-scheme selection, or the timing house
 * style — the ONLY differences between the two dumps are the `pg_dump` args and the artefact assembly.
 *
 * `@pgxsinkit/pgwasm-pg-dump` is loaded ONLY via the dynamic `import()` here (ADR-0035 decision 7): its
 * ~700 kB `pg_dump.wasm` (+ ~100 kB JS) stays off boot and off every non-exporting bundle.
 */
export interface CloneDumpOptions {
  /** The `pg_dump` args (none for a diagnostic dump; `-t` allowlist + `--no-owner` for a data export). */
  pgDumpArgs?: string[];
  /**
   * A hook run on the throwaway clone AFTER boot, BEFORE `pg_dump` — its one legitimate window to mutate the
   * clone (which is fully owned and discarded straight after). The data export uses it to drop the reconcile
   * triggers `pg_dump -t` would otherwise pull into the artefact (see `buildDataExportCloneCleanupSql`); a
   * diagnostic dump passes none (it wants the store verbatim).
   */
  prepareClone?: (clone: Pgwasm) => Promise<void>;
}

export async function runThrowawayCloneDump(
  pgwasm: Pick<PgwasmClient, "exec" | "dumpDataDir">,
  startPerf: number,
  options: CloneDumpOptions = {},
): Promise<CloneDumpResult> {
  // Step 1 — the LIVE datadir dump the clone boots from (checkpoint → `dumpDataDir`, the shared core).
  const { dumped, checkpointStartedAtMs, checkpointMs, dumpStartedAtMs, dumpMs } = await performDatadirDump(
    pgwasm,
    "none",
    startPerf,
  );

  // Step 2 — boot the throwaway. Memory-backed via the resolution module's SCHEME selection (ADR-0036
  // decision 5: NEVER pgwasm's explicit `fs: new MemoryFS()` — as probed before the pgwasm switch (ADR-0062),
  // a `dumpDataDir` from an explicit-fs instance silently omits post-initdb relation files). No extensions at
  // all — not even `live` — and no sync runtime: the clone exists only to be read out by `pg_dump`, and
  // `DEALLOCATE ALL` has nothing here to corrupt.
  const cloneDataDir = resolveStoreDataDir(nextCloneStorePath(), "memory");
  const cloneBootStartedAtMs = nowMs() - startPerf;
  const cloneBootStartPerf = nowMs();
  // Relaxed durability (ADR-0047): this clone is a MEMORY-backed, read-only throwaway (dumped → `pg_dump`
  // → discarded), so it has no idb flush to relax — the flag is a no-op on the memory backend and is set
  // purely to state intent (a throwaway never needs synchronous durability) and stay correct if the clone's
  // backend ever changes.
  const throwaway = await createPgwasm({
    build: cBuild,
    dataDir: cloneDataDir,
    loadDataDir: dumped,
    relaxedDurability: true,
  });
  const cloneBootMs = nowMs() - cloneBootStartPerf;

  let sqlBytes: Uint8Array<ArrayBuffer>;
  let pgDumpStartedAtMs: number;
  let pgDumpMs: number;
  try {
    // Between boot and dump — the clone's one mutation window (owned, discarded next) — run the caller's
    // prepare hook. The data export drops the reconcile triggers `-t` would otherwise capture; timed inside
    // the pgDump-prep gap, it is a couple of tiny DROPs, so it is not given its own report phase.
    if (options.prepareClone) {
      await options.prepareClone(throwaway);
    }

    // Step 3 — the lazy `pg_dump`. The dynamic `import()` keeps `@pgxsinkit/pgwasm-pg-dump` — and its WASM —
    // off the boot bundle. The caller rebuilds the artefact `File`
    // from the returned bytes, so `fileName` here is cosmetic only.
    pgDumpStartedAtMs = nowMs() - startPerf;
    const pgDumpStartPerf = nowMs();
    const { pgDump } = await import("@pgxsinkit/pgwasm-pg-dump");
    const dumpFile = await pgDump({
      pg: throwaway,
      ...(options.pgDumpArgs != null ? { args: options.pgDumpArgs } : {}),
      fileName: "pgxsinkit-export.sql",
    });
    pgDumpMs = nowMs() - pgDumpStartPerf;
    sqlBytes = new Uint8Array(await dumpFile.arrayBuffer());
  } finally {
    // Step 4 — discard the throwaway in a `finally`, so a THROWING `pg_dump` never leaks the clone (its
    // memory is co-resident with the live engine for the export's duration; leaking one is a real cost).
    await throwaway.close();
  }

  return {
    sqlBytes,
    phases: {
      checkpointStartedAtMs,
      checkpointMs,
      dumpStartedAtMs,
      dumpMs,
      cloneBootStartedAtMs,
      cloneBootMs,
      pgDumpStartedAtMs,
      pgDumpMs,
    },
  };
}

/**
 * Run a diagnostic dump (ADR-0035): live datadir dump → memory-backed throwaway clone → `pg_dump` → discard
 * the clone → assemble the report. The caller (`createSyncClient`) awaits engine-ready and enters the
 * lifecycle slot BEFORE calling this, exactly as it does for the store backup — kept out of here so the
 * helper stays a pure "do the dump" unit.
 */
export async function performDiagnosticExport(
  deps: DiagnosticExportDeps,
  options: DiagnosticExportOptions = {},
): Promise<DiagnosticExportResult> {
  const startedAt = Date.now();
  const startPerf = nowMs();

  // A diagnostic dump takes the WHOLE store (no `-t`): synced + overlay + journal + metadata + views +
  // functions — everything a support engineer needs to read a misbehaving store.
  const { sqlBytes, phases } = await runThrowawayCloneDump(deps.pgwasm, startPerf);

  const storeId = deriveStoreId(deps.storePath);
  const fileName = options.fileName ?? `${storeId}-${compactTimestamp()}-diagnostics.sql`;
  // Build the artefact `File` from the raw bytes, NOT by re-wrapping the `File` `pgDump` returned: a wrapped
  // polyfilled `File` keeps its own name in non-browser hosts (the same bun quirk the store backup hit) — the
  // bytes-first path guarantees the store-scoped name/mime stick whatever `File` the dump hands back.
  const file = new File([sqlBytes], fileName, { type: "application/sql" });

  // Snapshot diagnostics of the LIVE store (the clone is already closed) — the journal state whose rows the
  // SQL also carries, so the report and the artefact agree on what was unflushed at dump time.
  const diagnostics = await deps.readMutationStats();

  const report: DiagnosticDumpReport = {
    reportVersion: 1,
    kind: "diagnostic-dump",
    scope: "everything",
    startedAt,
    totalMs: nowMs() - startPerf,
    byteLength: file.size,
    phases,
    diagnostics,
  };

  return { file, report };
}
