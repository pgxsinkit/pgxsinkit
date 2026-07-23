// Local store export (ADR-0035). Slice 1 ships the **store backup**: a full-fidelity, PGlite-restorable
// tarball of the whole local store, taken LIVE (no engine suspension). It is a `CHECKPOINT` — run through
// the engine's normal query serialisation so it orders behind in-flight engine work — followed by
// PGlite's `dumpDataDir`. Because the dump is of the datadir itself, the Mutation journal and Overlay
// travel INSIDE the artefact: a store backup is the lossless option, the only export an offline device
// with unflushed writes can take (CONTEXT.md → Store backup).
//
// Every export resolves to an {@link ExportReport} alongside the artefact, extending the ADR-0034
// observability rule (the BootReport house style) to exports: a versioned, allocation-light plain object
// (structured-clones across the worker bridge unchanged) carrying phase timings, a {@link MutationDiagnostics}
// snapshot, and a `startedAt` epoch anchor with every other value a monotonic offset/duration relative to it.

import type { MutationDiagnostics } from "@pgxsinkit/contracts";

import type { ClientPGlite } from "./index";

/**
 * Monotonic clock (ms) — `performance.now()` where available, else `Date.now()` (mirrors BootReport).
 * Exported so the sibling diagnostic-dump path ({@link file://./export-dump.ts}) times its extra phases
 * (clone boot, pg_dump) on the SAME clock as this module's checkpoint/dump pair.
 */
export const nowMs = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** Options for {@link SyncClient.exportStore}. */
export interface StoreExportOptions {
  /**
   * How to compress the tarball, forwarded to PGlite's `dumpDataDir`. `"auto"` (the default) gzips when a
   * `CompressionStream` is available and falls back to an uncompressed tar otherwise; `"gzip"` forces
   * compression; `"none"` skips it. The report's `compression` records the compression that was actually
   * applied (which, under `"auto"`, is resolved at runtime).
   */
  compression?: "auto" | "gzip" | "none";
  /**
   * Override the generated artefact file name. When omitted, the name is
   * `<storeId>-<timestamp>.pgdata.tar[.gz]`, where `storeId` is a filesystem-safe derivation of the store
   * path and the extension reflects the applied compression.
   */
  fileName?: string;
}

/**
 * The fields EVERY export report carries, whatever its kind — built in the BootReport house style
 * (ADR-0034): `reportVersion` is a contract number (additive fields keep it, a breaking reshape bumps it);
 * all `*Ms` are milliseconds; `startedAt` is the only wall-clock value and every `*AtMs` is a monotonic
 * offset from it. The per-kind interfaces below add their `kind`/`scope`/`phases` discriminant on top.
 */
export interface ExportReportCommon {
  reportVersion: 1;
  /** Epoch anchor (`Date.now()`) at export start; every other duration/offset is monotonic relative to it. */
  startedAt: number;
  /** Export start → artefact ready. */
  totalMs: number;
  /** The artefact's byte length — the size the caller downloads / persists. */
  byteLength: number;
  /**
   * The {@link MutationDiagnostics} snapshot at export time — the journal state captured alongside the
   * artefact (for the store backup, the very journal that travels INSIDE the tarball; for the diagnostic
   * dump, the live store's journal at dump time, whose rows the SQL also carries).
   */
  diagnostics: MutationDiagnostics;
}

/**
 * A live **store backup** (ADR-0035): the whole datadir as a PGlite-restorable tarball, journal and overlay
 * included. `checkpoint`/`dump` are the only phases — a store backup is a `CHECKPOINT` + `dumpDataDir`, no
 * clone. Slice-1 shape, kept unchanged (the union is additive).
 */
export interface StoreBackupReport extends ExportReportCommon {
  /** Which export produced this artefact. */
  kind: "store-backup";
  /** What the artefact covers. A store backup is always the whole store, journal and overlay included. */
  scope: "whole-store";
  /** The compression actually applied to the tarball (resolved from `"auto"` at dump time). */
  compression: "gzip" | "none";
  phases: {
    /** Offset from export start when the `CHECKPOINT` began. */
    checkpointStartedAtMs: number;
    /** `CHECKPOINT` wall — flushing dirty buffers to the datadir before it is tarred, serialised behind engine work. */
    checkpointMs: number;
    /** Offset from export start when `dumpDataDir` began. */
    dumpStartedAtMs: number;
    /** `dumpDataDir` wall — reading the datadir out and assembling (optionally compressing) the tarball. */
    dumpMs: number;
  };
}

/**
 * A **diagnostic dump** (ADR-0035, via the throwaway clone of the addendum): human-readable SQL of
 * EVERYTHING the store holds — synced tables, the `_overlay`/`_mutations` journal, the `pgxsinkit` metadata
 * schema, the read-model views, and the reconcile functions/triggers. It is a live datadir dump (checkpoint
 * + `dumpDataDir`) fed into a memory-backed throwaway PGlite via `loadDataDir`, against which `pg_dump` runs
 * — so the live engine is never touched (the addendum's whole point). Its phases add the clone boot and the
 * `pg_dump` walls to the shared checkpoint/dump pair.
 */
export interface DiagnosticDumpReport extends ExportReportCommon {
  kind: "diagnostic-dump";
  /** A diagnostic dump covers everything the store holds — synced data, journal, metadata, views, functions. */
  scope: "everything";
  phases: {
    /** Offset from export start when the `CHECKPOINT` began. */
    checkpointStartedAtMs: number;
    /** `CHECKPOINT` wall — flushing dirty buffers before the internal datadir dump the clone consumes. */
    checkpointMs: number;
    /** Offset from export start when the internal `dumpDataDir` began. */
    dumpStartedAtMs: number;
    /** `dumpDataDir` wall — the uncompressed internal tarball the throwaway clone boots from (`compression: "none"`). */
    dumpMs: number;
    /** Offset from export start when the throwaway clone's `PGlite.create({ loadDataDir })` began. */
    cloneBootStartedAtMs: number;
    /** Clone boot wall — booting the memory-backed throwaway from the internal dump. */
    cloneBootMs: number;
    /** Offset from export start when `pg_dump` began running against the clone. */
    pgDumpStartedAtMs: number;
    /** `pg_dump` wall — the WASM `pg_dump` reading the clone out to SQL. */
    pgDumpMs: number;
  };
}

/**
 * A **data export** (ADR-0035 decision 1, via the throwaway clone of the addendum): the PORTABLE artefact —
 * the synced tables and the enum types they depend on, schema + data, nothing of pgxsinkit's machinery,
 * loadable into a vanilla Postgres. It is a generated enum DDL header concatenated ahead of a `pg_dump -t`
 * (per synced table) `--no-owner` run against the same memory-backed throwaway clone the diagnostic dump
 * uses. Unlike the other two exports it GUARDS: it requires a drained Mutation journal (or the explicit
 * `drainJournal: false` escape hatch), so its phases add the drain wall ahead of the clone pipeline, and it
 * records its provenance (`tables` = the `-t` allowlist actually applied, `escapeHatch` = whether the drain
 * was skipped).
 */
export interface DataExportReport extends ExportReportCommon {
  kind: "data-export";
  /** A data export covers the synced tables + their enum types only — never pgxsinkit's overlay/journal/metadata. */
  scope: "synced-tables";
  /**
   * The schema-qualified physical synced tables the `-t` allowlist targeted, in registry order — the
   * self-describing provenance of exactly what the artefact carries (ephemeral/read-projection entries
   * excluded by construction). May be empty when the registry declares no owning persistent table.
   */
  tables: string[];
  /**
   * `true` when `drainJournal: false` skipped the drain and the artefact reflects the SYNCED state as-is
   * (unflushed local writes silently absent). `false` on the strict path (a drained or empty journal).
   */
  escapeHatch: boolean;
  phases: {
    /** Offset from export start when the drain guard began (`0` when the escape hatch skipped it). */
    drainStartedAtMs: number;
    /** Drain wall — flushing + awaiting the journal reach fully-drained (`0` under the escape hatch). */
    drainMs: number;
    /** Offset from export start when the `CHECKPOINT` began. */
    checkpointStartedAtMs: number;
    /** `CHECKPOINT` wall — flushing dirty buffers before the internal datadir dump the clone consumes. */
    checkpointMs: number;
    /** Offset from export start when the internal `dumpDataDir` began. */
    dumpStartedAtMs: number;
    /** `dumpDataDir` wall — the uncompressed internal tarball the throwaway clone boots from (`compression: "none"`). */
    dumpMs: number;
    /** Offset from export start when the throwaway clone's `PGlite.create({ loadDataDir })` began. */
    cloneBootStartedAtMs: number;
    /** Clone boot wall — booting the memory-backed throwaway from the internal dump. */
    cloneBootMs: number;
    /** Offset from export start when `pg_dump -t` began running against the clone. */
    pgDumpStartedAtMs: number;
    /** `pg_dump -t` wall — the WASM `pg_dump` reading the allowlisted tables out to SQL. */
    pgDumpMs: number;
  };
}

/**
 * A structured, versioned record of one local-store export (ADR-0035) — a discriminated union on `kind`.
 * Every member shares {@link ExportReportCommon}; the `kind`/`scope`/`phases` discriminant tells the three
 * exports apart. `exportStore` resolves a {@link StoreBackupReport}; `exportDiagnostics` a
 * {@link DiagnosticDumpReport}; `exportData` a {@link DataExportReport}.
 */
export type ExportReport = StoreBackupReport | DiagnosticDumpReport | DataExportReport;

/** The artefact + its report — the resolved value of {@link SyncClient.exportStore}. */
export interface StoreExportResult {
  /** The store-backup tarball as a named `File`, restorable by PGlite via `loadDataDir`. */
  file: File;
  /** The structured record of the export (ADR-0035). */
  report: StoreBackupReport;
}

/**
 * Reduce a plain store PATH (ADR-0036) to a filesystem-safe token for the backup file name. Takes the
 * path's LAST segment (as PGlite's own `dumpDataDir` does when it names the inner db), then keeps only
 * `[A-Za-z0-9._-]`. No scheme stripping — the store path is a plain name, never a storage URL. Falls back
 * to a fixed token for an empty path so the name is always well formed.
 */
export function deriveStoreId(storePath: string | undefined): string {
  if (!storePath) return "pgxsinkit-store";
  const lastSegment = storePath.split("/").filter(Boolean).pop() ?? storePath;
  const safe = lastSegment.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+|-+$/g, "");
  return safe.length > 0 ? safe : "pgxsinkit-store";
}

/**
 * An ISO-ish, filesystem-safe timestamp (colons/dots → hyphens) for a default artefact file name. Exported
 * so the diagnostic-dump path names its `.sql` artefact with the identical timestamp shape.
 */
export const compactTimestamp = (): string => new Date().toISOString().replace(/[:.]/g, "-");

/**
 * The datadir dump both exports share (ADR-0035): a `CHECKPOINT` through the store's normal query path,
 * then `dumpDataDir`. The store backup keeps its bytes as the artefact; the diagnostic dump feeds them to a
 * throwaway clone. Factored out so exactly one implementation of "flush + tar the live datadir" exists —
 * `performStoreExport` and `performDiagnosticExport` cannot drift on the checkpoint ordering or the timing
 * house style. Returns the raw `dumpDataDir` output plus the two phase walls, both offset from `startPerf`
 * (the caller's export-start monotonic anchor) so the timings compose into either report.
 *
 * The `CHECKPOINT` is a utility statement — Drizzle has no builder for it, so a raw `exec` is the justified
 * tier-③ form here. Running it via `pglite.exec` serialises it behind any in-flight engine work on PGlite's
 * single connection, flushing dirty buffers to the datadir the dump then reads — so the tarball reflects
 * committed state, not a torn mid-write datadir.
 */
export async function performDatadirDump(
  pglite: Pick<ClientPGlite, "exec" | "dumpDataDir">,
  compression: "auto" | "gzip" | "none",
  startPerf: number,
): Promise<{
  dumped: Awaited<ReturnType<ClientPGlite["dumpDataDir"]>>;
  checkpointStartedAtMs: number;
  checkpointMs: number;
  dumpStartedAtMs: number;
  dumpMs: number;
}> {
  const checkpointStartedAtMs = nowMs() - startPerf;
  const checkpointStartPerf = nowMs();
  await pglite.exec("CHECKPOINT");
  const checkpointMs = nowMs() - checkpointStartPerf;

  const dumpStartedAtMs = nowMs() - startPerf;
  const dumpStartPerf = nowMs();
  const dumped = await pglite.dumpDataDir(compression);
  const dumpMs = nowMs() - dumpStartPerf;

  return { dumped, checkpointStartedAtMs, checkpointMs, dumpStartedAtMs, dumpMs };
}

/** The dependencies {@link performStoreExport} needs from the owning client — narrow, so it is unit-testable. */
export interface StoreExportDeps {
  /** The live store to checkpoint and dump. */
  pglite: Pick<ClientPGlite, "exec" | "dumpDataDir">;
  /** The Mutation diagnostics seam (`client.diagnostics().mutation` / `readMutationStats`). */
  readMutationStats: () => Promise<MutationDiagnostics>;
  /**
   * The store's configured plain store PATH (ADR-0036) — reduced to the `storeId` in the default backup
   * file name (`deriveStoreId`). The resolved PGlite dataDir URL is deliberately NOT used here: it is
   * internal plumbing and must not leak into an artefact name as something to imitate.
   */
  storePath?: string;
}

/**
 * Run a live store backup (ADR-0035): checkpoint → dump → snapshot diagnostics → assemble the report. The
 * caller (`createSyncClient`) is responsible for awaiting engine-ready and entering the lifecycle slot
 * BEFORE calling this — kept out of here so the helper stays a pure "do the dump" unit. No engine
 * suspension: the backup is live by design.
 */
export async function performStoreExport(
  deps: StoreExportDeps,
  options: StoreExportOptions = {},
): Promise<StoreExportResult> {
  const startedAt = Date.now();
  const startPerf = nowMs();
  const compression = options.compression ?? "auto";

  // Live dump of the whole datadir (checkpoint → `dumpDataDir`, the shared core) — the journal and overlay
  // ride inside it (the lossless backup, ADR-0035).
  const { dumped, checkpointStartedAtMs, checkpointMs, dumpStartedAtMs, dumpMs } = await performDatadirDump(
    deps.pglite,
    compression,
    startPerf,
  );

  // PGlite names its dump `<db>.tar.gz` (type `application/x-gzip`) when it compressed, `<db>.tar`
  // (`application/x-tar`) otherwise — so the RESULT, not the requested option, tells us what `"auto"`
  // resolved to. Detect from whichever of name/type the runtime populated (its `File` is a polyfill in
  // non-browser hosts, so trust both).
  const dumpedName = dumped instanceof File ? dumped.name : "";
  const gzipped = dumpedName.endsWith(".gz") || dumped.type.includes("gzip");
  const appliedCompression: "gzip" | "none" = gzipped ? "gzip" : "none";
  const extension = gzipped ? ".pgdata.tar.gz" : ".pgdata.tar";
  const mimeType = gzipped ? "application/x-gzip" : "application/x-tar";
  const storeId = deriveStoreId(deps.storePath);
  const fileName = options.fileName ?? `${storeId}-${compactTimestamp()}${extension}`;
  // Build the artefact `File` from the raw bytes, NOT by re-wrapping `dumped`: PGlite's dump is a File
  // polyfill in non-browser hosts, and `new File([polyfillFile], name)` keeps the polyfill's own name
  // rather than the one we pass. Extracting the bytes first guarantees the store-scoped name sticks.
  const bytes = new Uint8Array(await dumped.arrayBuffer());
  const file = new File([bytes], fileName, { type: mimeType });

  // Snapshot diagnostics AFTER the dump so it describes the journal state the artefact actually holds.
  const diagnostics = await deps.readMutationStats();

  const report: StoreBackupReport = {
    reportVersion: 1,
    kind: "store-backup",
    scope: "whole-store",
    compression: appliedCompression,
    startedAt,
    totalMs: nowMs() - startPerf,
    byteLength: file.size,
    phases: { checkpointStartedAtMs, checkpointMs, dumpStartedAtMs, dumpMs },
    diagnostics,
  };

  return { file, report };
}
