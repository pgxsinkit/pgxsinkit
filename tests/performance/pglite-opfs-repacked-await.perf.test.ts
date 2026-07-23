import { describe, expect, it } from "bun:test";

import { PGlite } from "@electric-sql/pglite";

import { OpfsRepackedPort } from "../../packages/pglite-opfs-repacked/src/opfs-port";
import { openOpfsRepackedFsForPort } from "../../packages/pglite-opfs-repacked/src/opfs-repacked-fs";
import { createOpfsRepackedPGlite } from "../../packages/pglite-opfs-repacked/src/pglite-factory";
import { MemoryOpfsDirectory } from "../../packages/pglite-opfs-repacked/test/support/memory-opfs";

const WARMUP_QUERIES = 20;
const MEASURED_QUERIES = 5_000;

interface Measurement {
  label: "awaited" | "detached";
  totalMs: number;
  perQueryMs: number;
  openHandlesAfterClose: number;
}

async function measureAwaited(): Promise<Measurement> {
  const directory = new MemoryOpfsDirectory();
  const pg = await createOpfsRepackedPGlite({ directory, durability: "relaxed", extentSize: 8192 });
  const timing = await measureQueries(pg);
  await pg.close();
  return { label: "awaited", ...timing, openHandlesAfterClose: directory.openHandleCount() };
}

async function measureDetached(): Promise<Measurement> {
  const directory = new MemoryOpfsDirectory();
  const adapter = await openOpfsRepackedFsForPort(new OpfsRepackedPort(directory), {
    durability: "relaxed",
    extentSize: 8192,
  });
  // Unsupported construction used only as the diagnostic comparator: this is
  // the optional host optimization that an upstream rejection latch could make
  // safe. The benchmark-local proxy deliberately translates the detached host
  // boolean back to the awaited adapter assertion; production code retains the
  // terminal mismatch and its public factory never selects this mode.
  const detachedComparator = new Proxy(adapter, {
    get(target, property) {
      if (property === "syncToFs") return async () => target.syncToFs(false);
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const pg = new PGlite({ fs: detachedComparator, relaxedDurability: true });
  try {
    await pg.waitReady;
    adapter.strictSync();
    const timing = await measureQueries(pg);
    await pg.close();
    return { label: "detached", ...timing, openHandlesAfterClose: directory.openHandleCount() };
  } catch (cause) {
    await adapter.cleanupFailedInit();
    throw cause;
  }
}

async function measureQueries(pg: PGlite): Promise<{ totalMs: number; perQueryMs: number }> {
  for (let index = 0; index < WARMUP_QUERIES; index += 1) await pg.exec("SELECT 1");
  const started = performance.now();
  for (let index = 0; index < MEASURED_QUERIES; index += 1) await pg.exec("SELECT 1");
  const totalMs = performance.now() - started;
  return { totalMs, perQueryMs: totalMs / MEASURED_QUERIES };
}

describe("performance: OPFS repacked awaited host boundary (PGlite-only, no containers)", () => {
  it(
    "records awaited relaxed-query cost against the unsupported detached comparator",
    async () => {
      const awaited = await measureAwaited();
      const detached = await measureDetached();
      const overheadMs = awaited.perQueryMs - detached.perQueryMs;
      const overheadPercent = (overheadMs / detached.perQueryMs) * 100;

      console.log(
        [
          "",
          "[perf] OPFS repacked relaxed durability: awaited host boundary vs detached comparator",
          "mode | queries | totalMs | perQueryMs",
          `${awaited.label} | ${MEASURED_QUERIES} | ${awaited.totalMs.toFixed(2)} | ${awaited.perQueryMs.toFixed(4)}`,
          `${detached.label} | ${MEASURED_QUERIES} | ${detached.totalMs.toFixed(2)} | ${detached.perQueryMs.toFixed(4)}`,
          `awaited overhead | ${overheadMs.toFixed(4)} ms/query | ${overheadPercent.toFixed(2)}%`,
          "",
        ].join("\n"),
      );

      expect(Number.isFinite(overheadMs)).toBe(true);
      expect(awaited.perQueryMs).toBeLessThanOrEqual(1);
      expect(overheadMs).toBeLessThanOrEqual(0.1);
      expect(awaited.openHandlesAfterClose).toBe(0);
      expect(detached.openHandlesAfterClose).toBe(0);
    },
    2 * 60_000,
  );
});
