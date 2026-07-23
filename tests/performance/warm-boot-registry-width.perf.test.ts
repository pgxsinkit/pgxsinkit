import { describe, expect, it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import { createSyncClient } from "@pgxsinkit/client";

import { buildSyntheticRegistry } from "./support/synthetic-registry";

// Registry-WIDTH lane for cold-engine WARM-store boot (PGlite-only, no containers). For each writable-table
// width we boot a filesystem-backed client, let boot finish, close it cleanly (the store persists on disk),
// then boot a SECOND client on the SAME store path — that second boot is the cold-engine/warm-store case the
// warm-store fast paths target. We record the BootReport phase timings + `warmBoot` flags.
//
// SLICE 2 (recovery-required marker) has LANDED: a clean shutdown clears the durable
// `mutation_recovery_required` marker, so the second (warm) boot SKIPS the per-table journal-recovery loop
// entirely instead of running one UPDATE per writable journal. This lane asserts that skip:
//   * warm boot: `warmBoot.journalRecoverySkipped === true` and `warmBoot.journalRecoveryRequired === false`
//     (marker `false` from the clean boot-A settle → recovery is O(1): one marker read, no per-table loop).
//
// SLICE 3 (durable-schema fingerprint fast path) has LANDED: boot-A stamps `local_schema_fingerprint`, so
// the second (warm) boot's freshly-generated durable-schema hash MATCHES and the durable replay is SKIPPED.
// This lane now asserts that skip too:
//   * warm boot: `warmBoot.schemaSkipped === true` and `warmBoot.schemaFingerprintMatch === true`.
//   * `schemaExecMs` collapses to the bootstrap-crossing + fingerprint-read (+ ephemeral, none here) cost —
//     roughly flat across widths rather than scaling with the durable DDL size — so the assertion is no
//     longer `schemaExecMs > 0` but the skip flags above.

// Repo-local tmp only (never repo root, never /tmp). Each iteration gets a unique subdir under here and
// is removed after use, so the lane leaves no residue.
const WARM_BOOT_TMP_ROOT = path.resolve(process.cwd(), "tmp/perf-warm-boot");

// Constant column shape across every width, so the only variable is the writable-table count.
const EXTRA_COLUMN_COUNT = 4;

// Unreachable sync endpoints: boot runs with sync OFF, so these are never dialled. Mirrors the
// PGlite-only pattern in client-local-optimistic.perf.test.ts.
const UNREACHABLE_ELECTRIC_URL = "http://127.0.0.1:1/v1/shape";
const UNREACHABLE_WRITE_URL = "http://127.0.0.1:1/api/mutations";

interface WarmBootMeasurement {
  schemaExecMs: number;
  journalRecoveryMs: number;
  storeVersionReconcileMs: number;
  pgliteCreateMs: number | null;
  totalMs: number;
  // ADR-0041 staged-boot stages (offsets from boot start): local-read core done / write runtime + recovery done.
  localReadReadyMs: number | null;
  writeReadyMs: number | null;
  journalRecoverySkipped: boolean;
  journalRecoveryRequired: boolean;
  schemaSkipped: boolean;
  schemaFingerprintMatch: boolean;
}

/**
 * Boot a filesystem-backed client at `storePath`, await boot completion, capture its finalized
 * BootReport phases, then close cleanly (the store persists on disk for the next boot).
 */
async function bootAndCapture(tableCount: number, storePath: string): Promise<WarmBootMeasurement> {
  const { registry } = buildSyntheticRegistry({ tableCount, extraColumnCount: EXTRA_COLUMN_COUNT });

  // Plain-string storePath (no `://`) + Bun/Node → the store resolves to the `file://` filesystem backend
  // (store-path.ts resolveStoreDataDir). Deliberately NOT memoryStoreForTests — we need a persisted store
  // that survives the first client's close so the second boot is a genuine cold-engine/warm-store boot.
  const client = await createSyncClient({
    registry,
    electricUrl: UNREACHABLE_ELECTRIC_URL,
    batchWriteUrl: UNREACHABLE_WRITE_URL,
    syncEnabled: false,
    storePath,
  });

  try {
    await client.ready;
    // With sync disabled the report is finalized at the moment `ready` resolves (ADR-0034), so it is
    // available here.
    const report = await client.bootReport();
    if (!report) {
      throw new Error("bootReport() was null after ready with sync disabled");
    }
    return {
      schemaExecMs: report.phases.schemaExecMs,
      journalRecoveryMs: report.phases.journalRecoveryMs,
      storeVersionReconcileMs: report.phases.storeVersionReconcileMs,
      pgliteCreateMs: report.phases.pgliteCreateMs,
      totalMs: report.totalMs,
      localReadReadyMs: report.localReadReadyMs,
      writeReadyMs: report.writeReadyMs,
      journalRecoverySkipped: report.warmBoot.journalRecoverySkipped,
      journalRecoveryRequired: report.warmBoot.journalRecoveryRequired,
      schemaSkipped: report.warmBoot.schemaSkipped,
      schemaFingerprintMatch: report.warmBoot.schemaFingerprintMatch,
    };
  } finally {
    // stop() closes the engine + PGlite but leaves the store on disk (distinct from destroy(), which
    // wipes it) — exactly the warm-store precondition for the next boot.
    await client.stop();
  }
}

/**
 * One cold-then-warm cycle at a given width on a fresh, unique store path: boot A creates + populates the
 * store schema and closes it; boot B is the measured cold-engine/warm-store boot. The store dir is removed
 * afterwards.
 */
async function measureWarmBoot(tableCount: number, label: string): Promise<WarmBootMeasurement> {
  const storeDir = path.join(
    WARM_BOOT_TMP_ROOT,
    `${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(storeDir, { recursive: true });
  const storePath = path.join(storeDir, "store");

  try {
    // Boot A — creates the durable store (schema replay, empty journals), then closes.
    await bootAndCapture(tableCount, storePath);
    // Boot B — cold engine over the now-warm persisted store. This is the measurement of record.
    return await bootAndCapture(tableCount, storePath);
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function fmt(value: number | null): string {
  return value == null ? "n/a" : value.toFixed(1);
}

describe("performance: warm-boot registry width (PGlite-only, no containers)", () => {
  it(
    "records cold-engine warm-store boot phase timings across 1 / 16 / 50 writable tables",
    async () => {
      await rm(WARM_BOOT_TMP_ROOT, { recursive: true, force: true });
      await mkdir(WARM_BOOT_TMP_ROOT, { recursive: true });

      // Width 1: single iteration. Width 16 (GenreTV shape): >=3 iterations → median. Width 50: single
      // iteration. Keeps total runtime reasonable while giving the 16-table shape a stable central value.
      const width1 = await measureWarmBoot(1, "w1");

      const width16Iterations: WarmBootMeasurement[] = [];
      for (let iteration = 0; iteration < 3; iteration += 1) {
        width16Iterations.push(await measureWarmBoot(16, `w16-i${iteration}`));
      }
      const width16: WarmBootMeasurement = {
        schemaExecMs: median(width16Iterations.map((m) => m.schemaExecMs)),
        journalRecoveryMs: median(width16Iterations.map((m) => m.journalRecoveryMs)),
        storeVersionReconcileMs: median(width16Iterations.map((m) => m.storeVersionReconcileMs)),
        pgliteCreateMs: median(width16Iterations.map((m) => m.pgliteCreateMs ?? 0)),
        totalMs: median(width16Iterations.map((m) => m.totalMs)),
        localReadReadyMs: median(width16Iterations.map((m) => m.localReadReadyMs ?? 0)),
        writeReadyMs: median(width16Iterations.map((m) => m.writeReadyMs ?? 0)),
        // The skip flags are deterministic across iterations (a clean boot-A settle always leaves the marker
        // `false`, and the stamped fingerprint always matches on the warm boot), so carry the first
        // iteration's values into the aggregate row.
        journalRecoverySkipped: width16Iterations[0]!.journalRecoverySkipped,
        journalRecoveryRequired: width16Iterations[0]!.journalRecoveryRequired,
        schemaSkipped: width16Iterations[0]!.schemaSkipped,
        schemaFingerprintMatch: width16Iterations[0]!.schemaFingerprintMatch,
      };

      const width50 = await measureWarmBoot(50, "w50");

      const rows: Array<{ width: string; measurement: WarmBootMeasurement }> = [
        { width: "1 (x1)", measurement: width1 },
        { width: "16 (median of 3)", measurement: width16 },
        { width: "50 (x1)", measurement: width50 },
      ];

      // Emit the recorded numbers as a clear table to stdout for reproducible width-regression comparisons.
      const header = [
        "writable tables",
        "schemaExecMs",
        "schemaSkipped",
        "journalRecoveryMs",
        "recSkipped",
        "storeVerReconcileMs",
        "pgliteCreateMs",
        "localReadReadyMs",
        "writeReadyMs",
        "totalMs",
      ];
      const lines = [
        "",
        "[perf] warm-boot registry-width baseline (cold-engine warm-store boot; PGlite fs store; recovery marker + exact schema fingerprint + ADR-0041 staged boot)",
        header.join(" | "),
        rows
          .map((row) =>
            [
              row.width,
              fmt(row.measurement.schemaExecMs),
              String(row.measurement.schemaSkipped),
              fmt(row.measurement.journalRecoveryMs),
              String(row.measurement.journalRecoverySkipped),
              fmt(row.measurement.storeVersionReconcileMs),
              fmt(row.measurement.pgliteCreateMs),
              fmt(row.measurement.localReadReadyMs),
              fmt(row.measurement.writeReadyMs),
              fmt(row.measurement.totalMs),
            ].join(" | "),
          )
          .join("\n"),
        "",
      ];
      console.log(lines.join("\n"));

      // Assertions:
      //   - The warm (second) boot skips the per-table journal-recovery loop because the
      //     clean boot-A settle left the durable marker `false`. Assert the skip is O(1) and width-independent
      //     at every width — `journalRecoverySkipped === true`, `journalRecoveryRequired === false`.
      //   - The warm boot's durable-schema fingerprint matches the boot-A stamp, so the
      //     durable replay is skipped at every width — `schemaSkipped === true`, `schemaFingerprintMatch ===
      //     true`. `schemaExecMs` is now just the bootstrap crossing + fingerprint read, not the durable DDL
      //     exec, so it no longer scales with width (recorded in the table above rather than asserted numeric).
      for (const { measurement } of rows) {
        expect(measurement.journalRecoverySkipped).toBe(true);
        expect(measurement.journalRecoveryRequired).toBe(false);
        expect(measurement.schemaSkipped).toBe(true);
        expect(measurement.schemaFingerprintMatch).toBe(true);
      }
    },
    10 * 60_000,
  );
});
