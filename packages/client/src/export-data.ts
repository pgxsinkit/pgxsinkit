// Data export (ADR-0035 decision 1, via the throwaway clone of the addendum). The PORTABLE artefact: the
// synced tables and the enum types they depend on, schema + data, nothing of pgxsinkit's machinery —
// loadable into a vanilla Postgres. It is `generated enum DDL header + pg_dump -t (per synced table)`
// concatenated: `pg_dump -t` emits the allowlisted TABLES but not the enum TYPES their columns reference
// (and `--exclude-*` cannot subtract the reconcile functions), so the header carries the enums and `-t`
// carries exactly the physical synced tables — overlay/journal/metadata/views/functions fall outside `-t`
// by construction. `--no-owner` keeps the SQL portable across roles.
//
// Unlike the store backup and the diagnostic dump, the data export is the ONE variant that silently loses
// unflushed writes (decision 3): an `acked` write whose synced echo has not landed lives only in the Overlay
// and the `destroy()`-style "owed" predicate does not count it. So `exportData` requires a DRAINED journal —
// "drained" meaning all six mutation counts zero (CONTEXT.md → Data export: "drained ≠ nothing owed"), which
// for `acked` rows clears only via the synced echo through the Convergence barrier. The drain actively
// `flush()`es drainable rows and awaits that convergence, bounded by `drainJournal.timeoutMs`; non-drainable
// states (`failed`/`quarantined`/`conflicted`) never drain on their own, so they fail FAST with the
// diagnostics snapshot rather than burning the timeout. `drainJournal: false` is the explicit escape hatch
// exporting synced state as-is.
//
// The drain runs INSIDE the lifecycle slot (the caller enters the slot, then calls this): `flush()` needs
// the running engine and is not a lifecycle-exclusive op, but the artefact must be taken RIGHT AFTER the
// drain with no window for a new write to slip in — so export owns the store's lifecycle for the whole
// drain+dump, the simplest correct placement.

import type { MutationDiagnostics } from "@pgxsinkit/contracts";

import { runThrowawayCloneDump } from "./export-dump";
import { compactTimestamp, type DataExportReport, deriveStoreId, nowMs } from "./export-store";
import type { ClientPGlite } from "./index";

/** The default drain budget: actively flush + await the convergence barrier for up to 15s before failing. */
export const DEFAULT_DRAIN_TIMEOUT_MS = 15_000;
/** How often the drain re-checks the diagnostics seam while waiting for the journal to converge. */
const DRAIN_POLL_INTERVAL_MS = 50;

/** The drain guard's tuning: the wait budget for reaching a fully-drained journal. */
export interface DrainJournalOptions {
  /** Milliseconds to flush + await convergence before throwing {@link DataExportDrainError}. */
  timeoutMs: number;
}

/**
 * `exportData`'s drain policy: the default `{ timeoutMs }` guard, or `false` — the explicit escape hatch
 * that skips the drain and exports the SYNCED state as-is (unflushed local writes silently absent). A plain
 * JSON shape, so it survives structured clone across the worker bridge unchanged.
 */
export type DrainJournalOption = DrainJournalOptions | false;

/** Options for {@link SyncClient.exportData}. Plain JSON — structured-clone-safe across the worker bridge. */
export interface DataExportOptions {
  /**
   * Override the generated artefact file name. When omitted, the name is `<storeId>-<timestamp>-data.sql`,
   * where `storeId` is a filesystem-safe derivation of the store path (see `deriveStoreId`).
   */
  fileName?: string;
  /**
   * The drain guard (ADR-0035 decision 3). Default `{ timeoutMs: 15_000 }`: fail fast on non-drainable
   * states, else flush + await convergence up to the budget. `false` is the escape hatch — export synced
   * state as-is, skipping the drain entirely.
   */
  drainJournal?: DrainJournalOption;
}

/** The SQL artefact + its report — the resolved value of {@link SyncClient.exportData}. */
export interface DataExportResult {
  /** The portable SQL as a named `File` (`application/sql`), loadable into a vanilla Postgres. */
  file: File;
  /** The structured record of the export (ADR-0035). */
  report: DataExportReport;
}

/**
 * Thrown when `exportData`'s strict drain cannot produce a drained journal (ADR-0035 decision 3). Carries
 * the `MutationDiagnostics` snapshot at the moment of failure so the caller sees exactly what blocked the
 * export, and a `reason` distinguishing the two failure modes:
 *
 * - `"non-drainable-state"` — `failed`/`quarantined`/`conflicted` rows are present (either pre-existing, so
 *   the failure is immediate with no waiting, or a mid-drain `flush()` failure that moved rows to `failed`);
 *   these terminal states never drain on their own, so waiting is pointless.
 * - `"timeout"` — drainable rows (`pending`/`sending`/`acked`) did not reach fully-drained within the
 *   budget; most commonly `acked` writes whose synced echo never arrived (an offline device, a stalled
 *   read path).
 *
 * A distinct type — not a bare `Error` — so a caller can `instanceof`-branch a drain failure from a genuine
 * export failure, inspect the diagnostics, and choose the escape hatch (`drainJournal: false`) or the
 * lossless store backup instead.
 */
export class DataExportDrainError extends Error {
  /** Which drain failure occurred (see the class doc). */
  readonly reason: "non-drainable-state" | "timeout";
  /** The mutation diagnostics at the moment the drain gave up — the evidence of what was unflushed. */
  readonly diagnostics: MutationDiagnostics;

  constructor(reason: "non-drainable-state" | "timeout", diagnostics: MutationDiagnostics) {
    const detail =
      reason === "non-drainable-state"
        ? `non-drainable journal rows are present (failed=${diagnostics.failedCount}, ` +
          `quarantined=${diagnostics.quarantinedCount}, conflicted=${diagnostics.conflictedCount}) — these never ` +
          "drain on their own"
        : `the journal did not drain within the timeout (pending=${diagnostics.pendingCount}, ` +
          `sending=${diagnostics.sendingCount}, acked=${diagnostics.ackedCount}) — most likely acked writes whose ` +
          "synced echo has not landed";
    super(
      `[pgxsinkit] exportData refused: ${detail}. A strict data export needs a DRAINED journal (ADR-0035); ` +
        "resolve the rows, retry once they converge, use `drainJournal: false` to export synced state as-is, or " +
        "take a lossless `exportStore` backup instead.",
    );
    this.name = "DataExportDrainError";
    this.reason = reason;
    this.diagnostics = diagnostics;
  }
}

/** The dependencies {@link performDataExport} needs from the owning client — narrow, so it is unit-testable. */
export interface DataExportDeps {
  /** The live store to checkpoint and dump (the clone source; the live engine is never suspended). */
  pglite: Pick<ClientPGlite, "exec" | "dumpDataDir">;
  /** The Mutation diagnostics seam (`client.diagnostics().mutation` / `readMutationStats`). */
  readMutationStats: () => Promise<MutationDiagnostics>;
  /** The optimistic flush (`client.flush()`), driven during the drain to send drainable rows. */
  flush: () => Promise<void>;
  /**
   * The `-t` allowlist: the schema-qualified physical synced table names, resolved from the registry by the
   * SAME projection the DDL generator uses (`collectDataExportSyncedTableNames`) — never re-derived here.
   */
  syncedTableNames: string[];
  /**
   * The generated enum DDL header (`buildDataExportEnumHeaderSql`) — the `CREATE TYPE` statements for the
   * enums the exported tables reference, which `pg_dump -t` omits. `""` when no exported table uses an enum.
   */
  enumHeaderSql: string;
  /**
   * The clone-cleanup SQL (`buildDataExportCloneCleanupSql`) run on the throwaway clone before `pg_dump -t`,
   * dropping the reconcile triggers `-t` would otherwise pull into the artefact (referencing pgxsinkit
   * functions the export excludes). `""` when the registry has no writable owning table.
   */
  cloneCleanupSql: string;
  /**
   * The store's configured plain store PATH (ADR-0036) — reduced to the `storeId` in the default artefact
   * file name. The resolved PGlite dataDir URL is deliberately NOT used: internal plumbing, never an
   * artefact-name seed.
   */
  storePath?: string;
}

/** A non-drainable state is present when any terminal count is non-zero — waiting on these is pointless. */
const hasNonDrainableRows = (diagnostics: MutationDiagnostics): boolean =>
  diagnostics.failedCount > 0 || diagnostics.quarantinedCount > 0 || diagnostics.conflictedCount > 0;

/**
 * Fully drained = all SIX counts zero. `acked` explicitly counts: an acked write whose echo has not landed
 * is still only in the Overlay (CONTEXT.md → Data export), so a strict export must wait for it to clear via
 * the Convergence barrier — that is the POINT of the drain, not merely "nothing owed".
 */
const isFullyDrained = (diagnostics: MutationDiagnostics): boolean =>
  diagnostics.pendingCount === 0 &&
  diagnostics.sendingCount === 0 &&
  diagnostics.ackedCount === 0 &&
  !hasNonDrainableRows(diagnostics);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Drive the journal to fully-drained (ADR-0035 decision 3), or throw {@link DataExportDrainError}:
 *
 * 1. Read diagnostics and fail FAST — before any waiting — when a non-drainable state pre-exists (an offline
 *    device with a dirty journal cannot produce a strict export).
 * 2. An already-empty journal returns instantly with ZERO network involvement — an offline device with a
 *    clean journal exports strictly (the assert-in-a-test case).
 * 3. Otherwise drainable rows are present: `flush()` them and poll the diagnostics seam until fully-drained,
 *    bounded by `timeoutMs`. A `flush()` that FAILS moves rows to `failed`, so the next poll sees a
 *    non-drainable state and fails fast (well under the budget) rather than burning the whole timeout. Its
 *    throw is swallowed — the diagnostics re-read, not the throw, is the source of truth for what happened.
 */
async function drainJournalForExport(
  deps: DataExportDeps,
  timeoutMs: number,
): Promise<{ diagnostics: MutationDiagnostics; drainMs: number }> {
  const drainStartPerf = nowMs();

  // (1)/(2) — fail fast on pre-existing terminal rows; return instantly on an empty journal.
  let diagnostics = await deps.readMutationStats();
  if (hasNonDrainableRows(diagnostics)) {
    throw new DataExportDrainError("non-drainable-state", diagnostics);
  }
  if (isFullyDrained(diagnostics)) {
    return { diagnostics, drainMs: nowMs() - drainStartPerf };
  }

  // (3) — drainable rows present: flush + await convergence, bounded by the budget.
  for (;;) {
    // A throwing flush (e.g. a dead write endpoint) still marks rows `failed`; the re-read below detects it.
    await deps.flush().catch(() => undefined);

    diagnostics = await deps.readMutationStats();
    // A flush that failed mid-wait shows up here as `failed` rows — fail fast, do not burn the timeout.
    if (hasNonDrainableRows(diagnostics)) {
      throw new DataExportDrainError("non-drainable-state", diagnostics);
    }
    if (isFullyDrained(diagnostics)) {
      return { diagnostics, drainMs: nowMs() - drainStartPerf };
    }
    if (nowMs() - drainStartPerf >= timeoutMs) {
      throw new DataExportDrainError("timeout", diagnostics);
    }
    await sleep(DRAIN_POLL_INTERVAL_MS);
  }
}

/**
 * A short SQL comment header describing the artefact and how it was produced — self-describing provenance so
 * a human reading the `.sql` knows what it is, which tables it carries, and whether the escape hatch dropped
 * unflushed writes. Emitted ahead of the enum header and the `pg_dump -t` output.
 */
function buildArtefactCommentHeader(tableNames: string[], escapeHatch: boolean): string {
  const tableList = tableNames.length > 0 ? tableNames.join(", ") : "(none)";
  return [
    "-- pgxsinkit data export (ADR-0035): the synced tables + their enum types, schema + data,",
    "-- nothing of pgxsinkit's overlay/journal/metadata machinery — loadable into a vanilla Postgres.",
    "-- Produced by a generated enum DDL header concatenated ahead of `pg_dump -t <table> ... --no-owner`",
    "-- run against a throwaway in-memory clone of the local store.",
    `-- Tables: ${tableList}`,
    escapeHatch
      ? "-- Journal drain: SKIPPED (drainJournal: false) — reflects synced state as-is; unflushed local writes are absent."
      : "-- Journal drain: enforced — the Mutation journal was fully drained before the dump.",
    "",
  ].join("\n");
}

/**
 * Run a data export (ADR-0035): drain the journal (unless the escape hatch is set) → throwaway-clone
 * `pg_dump -t` per synced table → concatenate the comment + enum DDL header → assemble the report. The
 * caller (`createSyncClient`) awaits engine-ready and enters the lifecycle slot BEFORE calling this, so the
 * whole drain+dump runs under the store's single lifecycle slot (the drain must sit inside it — see the
 * module header).
 */
export async function performDataExport(
  deps: DataExportDeps,
  options: DataExportOptions = {},
): Promise<DataExportResult> {
  const startedAt = Date.now();
  const startPerf = nowMs();

  const drainOption: DrainJournalOption = options.drainJournal ?? { timeoutMs: DEFAULT_DRAIN_TIMEOUT_MS };
  const escapeHatch = drainOption === false;

  // Phase 1 — the drain guard. The escape hatch skips it entirely (0-wall); otherwise it may throw a typed
  // DataExportDrainError before any dump work happens.
  const drainStartedAtMs = nowMs() - startPerf;
  const drainMs = escapeHatch ? 0 : (await drainJournalForExport(deps, drainOption.timeoutMs)).drainMs;

  // Phase 2 — the throwaway-clone dump, restricted to the physical synced tables via `-t`, `--no-owner` for
  // portability. `-t` is repeated once per table. `runThrowawayCloneDump` phases are offset from the SAME
  // export-start anchor, so they compose after the drain wall into one timeline.
  const pgDumpArgs = ["--no-owner", ...deps.syncedTableNames.flatMap((name) => ["-t", name])];
  const { sqlBytes, phases } = await runThrowawayCloneDump(deps.pglite, startPerf, {
    pgDumpArgs,
    // Drop the reconcile triggers on the clone so `-t` yields portable, machinery-free tables.
    ...(deps.cloneCleanupSql.length > 0
      ? { prepareClone: async (clone) => void (await clone.exec(deps.cloneCleanupSql)) }
      : {}),
  });

  // Concatenate: comment header + generated enum DDL header + pg_dump output. The header is text; the dump
  // is raw bytes — `File` accepts a mixed BlobPart list and encodes both as UTF-8, so the bytes are decoded
  // exactly once (never a decode/re-encode round trip).
  const header = buildArtefactCommentHeader(deps.syncedTableNames, escapeHatch) + deps.enumHeaderSql;
  const storeId = deriveStoreId(deps.storePath);
  const fileName = options.fileName ?? `${storeId}-${compactTimestamp()}-data.sql`;
  const file = new File([header, sqlBytes], fileName, { type: "application/sql" });

  // Snapshot diagnostics AT dump time (post-drain): on the strict path this is a drained journal; under the
  // escape hatch it is whatever synced-as-is state the artefact reflects.
  const diagnostics = await deps.readMutationStats();

  const report: DataExportReport = {
    reportVersion: 1,
    kind: "data-export",
    scope: "synced-tables",
    tables: deps.syncedTableNames,
    escapeHatch,
    startedAt,
    totalMs: nowMs() - startPerf,
    byteLength: file.size,
    phases: {
      drainStartedAtMs,
      drainMs,
      checkpointStartedAtMs: phases.checkpointStartedAtMs,
      checkpointMs: phases.checkpointMs,
      dumpStartedAtMs: phases.dumpStartedAtMs,
      dumpMs: phases.dumpMs,
      cloneBootStartedAtMs: phases.cloneBootStartedAtMs,
      cloneBootMs: phases.cloneBootMs,
      pgDumpStartedAtMs: phases.pgDumpStartedAtMs,
      pgDumpMs: phases.pgDumpMs,
    },
    diagnostics,
  };

  return { file, report };
}
