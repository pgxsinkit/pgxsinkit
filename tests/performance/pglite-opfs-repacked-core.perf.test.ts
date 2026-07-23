import { describe, expect, it } from "bun:test";

import { RepackedVfs } from "../../packages/pglite-opfs-repacked/src/core/repacked-vfs";
import {
  applyTxn,
  createInitialState,
  planCreateFile,
} from "../../packages/pglite-opfs-repacked/src/core/state-machine";
import { MemoryRepackedPort } from "../../packages/pglite-opfs-repacked/test/support/memory-port";

const EXTENT_SIZES = [8192, 65_536] as const;
const SMALL_LOG_FRAMES = 128;
const NEAR_SOFT_LOG_FRAMES = 14_000;
const MAX_SMALL_RECOVERY_MS = 50;
const MAX_NEAR_SOFT_RECOVERY_MS = 500;
const MAX_REPACK_P95_MS = 300;
const MAX_ZERO_BARRIER_MS = 100;
const MAX_HEAP_DELTA_BYTES = 128 * 1024 * 1024;
const MAX_ALLOCATOR_PER_OPERATION_RATIO = 2;

interface CoreProfile {
  extentSize: number;
  smallRecoveryMs: number;
  nearSoftRecoveryMs: number;
  nearSoftHeapDeltaBytes: number;
  repackP50Ms: number;
  repackP95Ms: number;
  lastRepackDurationMs: number;
  repackHeapDeltaBytes: number;
  zeroBarrierMs: number;
  quarantineBytesBeforeRepack: string;
  metadataBytesBeforeRepack: number;
  metadataFramesBeforeRepack: number;
  flushesAfterReuse: ReturnType<RepackedVfs["metrics"]>["flushes"];
  flushesAfterAmortization: ReturnType<RepackedVfs["metrics"]>["flushes"];
  handlesWhileOpen: number;
  handlesAfterClose: number;
  totalExtentsAfterReuse: string;
  availableExtentsAfterReuse: number;
  quarantineExtentsAfterReuse: number;
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

async function seededLog(extentSize: number, frames: number): Promise<MemoryRepackedPort> {
  const port = new MemoryRepackedPort();
  const vfs = await RepackedVfs.open(port, { extentSize });
  for (let index = 0; index < frames; index += 1) {
    vfs.writeFile(`/f${index}`, new Uint8Array(), { nowMs: BigInt(index + 1) });
  }
  vfs.strictSync();
  vfs.close();
  return port;
}

async function measureRecovery(port: MemoryRepackedPort): Promise<{ ms: number; heapDeltaBytes: number }> {
  Bun.gc(true);
  const heapBefore = process.memoryUsage().heapUsed;
  const started = performance.now();
  const reopened = await RepackedVfs.open(port);
  const ms = performance.now() - started;
  const heapDeltaBytes = Math.max(0, process.memoryUsage().heapUsed - heapBefore);
  reopened.close();
  return { ms, heapDeltaBytes };
}

function measureAllocatorBatch(count: number): number {
  const state = createInitialState(8192);
  const started = performance.now();
  for (let index = 0; index < count; index += 1) {
    applyTxn(
      state,
      planCreateFile(state, `/a${index}`, {
        nowMs: BigInt(index + 1),
        size: 8192n,
      }).record,
    );
  }
  return performance.now() - started;
}

async function profileExtent(extentSize: number): Promise<CoreProfile> {
  const small = await seededLog(extentSize, SMALL_LOG_FRAMES);
  const smallRecovery = await measureRecovery(small);

  const nearSoft = await seededLog(extentSize, NEAR_SOFT_LOG_FRAMES);
  const nearSoftRecovery = await measureRecovery(nearSoft);
  const live = await RepackedVfs.open(nearSoft);
  const beforeRepack = live.metrics();
  Bun.gc(true);
  const heapBeforeRepack = process.memoryUsage().heapUsed;
  let heapPeakDuringRepack = heapBeforeRepack;
  const repackSamples: number[] = [];
  for (let sample = 0; sample < 15; sample += 1) {
    const started = performance.now();
    live.repack();
    repackSamples.push(performance.now() - started);
    heapPeakDuringRepack = Math.max(heapPeakDuringRepack, process.memoryUsage().heapUsed);
  }
  const repackHeapDeltaBytes = heapPeakDuringRepack - heapBeforeRepack;
  const lastRepackDurationMs = live.metrics().lastRepackDurationMs;
  if (lastRepackDurationMs === null) throw new Error("repack duration metric was not recorded");
  live.close();

  const amortizedPort = new MemoryRepackedPort();
  const amortized = await RepackedVfs.open(amortizedPort, { extentSize });
  amortized.writeFile("/large", new Uint8Array(4 * 1024 * 1024 + 1), { nowMs: 1n });
  amortized.runScheduledRepack();
  const flushesAfterAmortization = amortized.metrics().flushes;
  amortized.close();

  const reusePort = new MemoryRepackedPort();
  const reuse = await RepackedVfs.open(reusePort, { extentSize });
  reuse.writeFile("/old", new Uint8Array(extentSize * 32).fill(0x71), { nowMs: 1n });
  reuse.writeFile("/keeper", Uint8Array.of(0x22), { nowMs: 2n });
  reuse.strictSync();
  reuse.unlink("/old", 3n);
  const quarantineBytesBeforeRepack = reuse.metrics().quarantineBytes.toString();
  reuse.repack();
  reuse.repack();
  const zeroStarted = performance.now();
  reuse.writeFile("/replacement", new Uint8Array(extentSize * 32).fill(0x33), { nowMs: 4n });
  const zeroBarrierMs = performance.now() - zeroStarted;
  const afterReuse = reuse.metrics();
  const flushesAfterReuse = afterReuse.flushes;
  const handlesWhileOpen = reusePort.openHandleCount();
  reuse.close();

  return {
    extentSize,
    smallRecoveryMs: smallRecovery.ms,
    nearSoftRecoveryMs: nearSoftRecovery.ms,
    nearSoftHeapDeltaBytes: nearSoftRecovery.heapDeltaBytes,
    repackP50Ms: percentile(repackSamples, 0.5),
    repackP95Ms: percentile(repackSamples, 0.95),
    lastRepackDurationMs,
    repackHeapDeltaBytes,
    zeroBarrierMs,
    quarantineBytesBeforeRepack,
    metadataBytesBeforeRepack: beforeRepack.activeLogBytes,
    metadataFramesBeforeRepack: beforeRepack.activeLogFrames,
    flushesAfterReuse,
    flushesAfterAmortization,
    handlesWhileOpen,
    handlesAfterClose: reusePort.openHandleCount(),
    totalExtentsAfterReuse: afterReuse.totalExtents.toString(),
    availableExtentsAfterReuse: afterReuse.availableExtents,
    quarantineExtentsAfterReuse: afterReuse.quarantineExtents,
  };
}

describe("performance: OPFS repacked core profiles (deterministic port, no containers)", () => {
  it(
    "records recovery, allocator, repack, zero-barrier, space, heap, flush, and handle profiles",
    async () => {
      const allocator1kMs = measureAllocatorBatch(1_000);
      const allocator4kMs = measureAllocatorBatch(4_000);
      const profiles: CoreProfile[] = [];
      for (const extentSize of EXTENT_SIZES) profiles.push(await profileExtent(extentSize));
      const allocatorPerOperationRatio = allocator4kMs / 4_000 / Math.max(Number.EPSILON, allocator1kMs / 1_000);

      console.log(
        "\n[perf] OPFS repacked core profile\n" +
          JSON.stringify(
            {
              allocator: {
                oneThousandMs: allocator1kMs,
                fourThousandMs: allocator4kMs,
                perOperationRatio: allocatorPerOperationRatio,
              },
              profiles,
            },
            null,
            2,
          ),
      );

      expect(allocator1kMs).toBeGreaterThan(0);
      expect(allocator4kMs).toBeGreaterThan(0);
      expect(allocatorPerOperationRatio).toBeLessThanOrEqual(MAX_ALLOCATOR_PER_OPERATION_RATIO);
      for (const profile of profiles) {
        expect(profile.smallRecoveryMs).toBeLessThanOrEqual(MAX_SMALL_RECOVERY_MS);
        expect(profile.nearSoftRecoveryMs).toBeLessThanOrEqual(MAX_NEAR_SOFT_RECOVERY_MS);
        expect(profile.nearSoftHeapDeltaBytes).toBeLessThanOrEqual(MAX_HEAP_DELTA_BYTES);
        expect(profile.repackP95Ms).toBeLessThanOrEqual(MAX_REPACK_P95_MS);
        expect(profile.repackHeapDeltaBytes).toBeLessThanOrEqual(MAX_HEAP_DELTA_BYTES);
        expect(profile.zeroBarrierMs).toBeLessThanOrEqual(MAX_ZERO_BARRIER_MS);
        expect(profile.flushesAfterReuse.zeroBarrier).toBe(1);
        expect(profile.flushesAfterAmortization.amortized).toBe(1);
        expect(profile.handlesWhileOpen).toBe(4);
        expect(profile.handlesAfterClose).toBe(0);
        expect(profile.metadataFramesBeforeRepack).toBe(NEAR_SOFT_LOG_FRAMES);
        expect(profile.metadataBytesBeforeRepack).toBeLessThanOrEqual(2 * 1024 * 1024);
        expect(profile.quarantineBytesBeforeRepack).toBe(String(profile.extentSize * 32));
        expect(profile.totalExtentsAfterReuse).toBe("33");
        expect(profile.availableExtentsAfterReuse).toBe(0);
        expect(profile.quarantineExtentsAfterReuse).toBe(0);
      }
    },
    3 * 60_000,
  );
});
