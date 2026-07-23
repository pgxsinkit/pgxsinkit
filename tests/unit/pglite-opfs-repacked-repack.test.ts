import { describe, expect, test } from "bun:test";

import { encodeTxnFrame } from "../../packages/pglite-opfs-repacked/src/core/codec";
import { FsError, StoreFailedError } from "../../packages/pglite-opfs-repacked/src/core/errors";
import { SOFT_ACTIVE_LOG_FRAMES } from "../../packages/pglite-opfs-repacked/src/core/limits";
import { writeExact } from "../../packages/pglite-opfs-repacked/src/core/port";
import { RepackedVfs } from "../../packages/pglite-opfs-repacked/src/core/repacked-vfs";
import { MemoryRepackedPort } from "../../packages/pglite-opfs-repacked/test/support/memory-port";
import type { MemoryFault } from "../../packages/pglite-opfs-repacked/test/support/memory-port";

const EXTENT_SIZES = [8192, 65_536] as const;

for (const extentSize of EXTENT_SIZES) {
  describe(`opfs-repacked projected repack and activation (${extentSize}-byte extents)`, () => {
    test("time-based scheduling ignores an idle generation", async () => {
      const port = new MemoryRepackedPort();
      const vfs = await RepackedVfs.open(port, { extentSize });

      expect(vfs.runScheduledRepack()).toBe(false);
      expect(vfs.runScheduledRepack(Number.MAX_SAFE_INTEGER)).toBe(false);
      expect(vfs.metrics()).toMatchObject({ generation: 1n, activeLogFrames: 0, repackCount: 0 });
      vfs.close();
    });

    test("relaxed sync amortizes accumulated arena dirt before repack", async () => {
      const port = new MemoryRepackedPort();
      const vfs = await RepackedVfs.open(port, { extentSize });
      vfs.writeFile("/large", new Uint8Array(4 * 1024 * 1024 + 1), { nowMs: 1n });

      port.clearObservedOperations();
      expect(vfs.metrics().flushes.amortized).toBe(0);
      expect(vfs.runScheduledRepack()).toBe(false);
      expect(vfs.metrics().flushes.amortized).toBe(1);
      expect(
        port
          .observedOperations()
          .filter((operation) => operation.operation === "flush")
          .map((operation) => operation.label),
      ).toEqual(["sync.arena.amortized.flush"]);
      vfs.close();
    });

    test("an ambiguous amortized arena flush poisons without publishing its pending frame", async () => {
      const port = new MemoryRepackedPort();
      const vfs = await RepackedVfs.open(port, { extentSize });
      vfs.writeFile("/large", new Uint8Array(4 * 1024 * 1024 + 1), { nowMs: 1n });
      port.injectFault({
        operation: "flush",
        file: "arena.bin",
        label: "sync.arena.amortized.flush",
        outcome: "throw-after",
      });

      expect(() => vfs.runScheduledRepack()).toThrow("injected flush failure after effect");
      expect(() => vfs.lstat("/large")).toThrow(StoreFailedError);
      expect(() => vfs.close()).toThrow(StoreFailedError);
      port.terminate();

      const reopened = await RepackedVfs.open(port);
      expect(() => reopened.lstat("/large")).toThrow(FsError);
      reopened.close();
    });

    test("metrics attribute the most recent successful repack duration", async () => {
      const port = new MemoryRepackedPort();
      const vfs = await RepackedVfs.open(port, { extentSize });
      expect(vfs.metrics().lastRepackDurationMs).toBeNull();

      vfs.repack();

      expect(vfs.metrics().lastRepackDurationMs).toBeGreaterThanOrEqual(0);
      vfs.close();
    });

    test("repack materializes a coalesced resize tail before writing its projected base", async () => {
      const port = new MemoryRepackedPort();
      const vfs = await RepackedVfs.open(port, { extentSize });
      const fd = vfs.open("/file", "w+", 0o100600, 1n);
      vfs.strictSync();
      const chunk = new Uint8Array(1024).fill(4);
      vfs.write(fd, chunk, 0, chunk.byteLength, undefined, 2n);
      vfs.write(fd, chunk, 0, chunk.byteLength, undefined, 3n);
      port.clearObservedOperations();

      vfs.repack();

      const writes = port.observedOperations().filter((operation) => operation.operation === "write");
      expect(writes.map((operation) => operation.label)).toEqual([
        "metadata.log.append",
        "repack.metadata.write",
        "repack.activation.write",
      ]);
      port.terminate();
      const reopened = await RepackedVfs.open(port);
      expect(reopened.metrics().generation).toBe(2n);
      expect(reopened.stat("/file").size).toBe(BigInt(chunk.byteLength * 2));
      reopened.close();
    });

    test("two activated replacements age quarantine and reclaim a contiguous tail", async () => {
      const port = new MemoryRepackedPort();
      const vfs = await RepackedVfs.open(port, { extentSize });
      vfs.writeFile("/old", "old", { nowMs: 1n });
      vfs.unlink("/old", 2n);

      vfs.repack();
      expect(vfs.metrics()).toMatchObject({
        generation: 2n,
        totalExtents: 1n,
        quarantineExtents: 1,
        lastRepackReason: "manual",
        repackCount: 1,
        flushes: { arena: 1, metadata: 1, manifest: 1, zeroBarrier: 0 },
      });
      vfs.repack();
      expect(vfs.metrics()).toMatchObject({
        generation: 3n,
        totalExtents: 0n,
        quarantineExtents: 0,
        repackCount: 2,
        flushes: { arena: 2, metadata: 2, manifest: 2, zeroBarrier: 0 },
      });

      vfs.writeFile("/new", "new", { nowMs: 3n });
      vfs.strictSync();
      vfs.close();
      const reopened = await RepackedVfs.open(port);
      expect(new TextDecoder().decode(reopened.readFile("/new"))).toBe("new");
      expect(reopened.metrics().generation).toBe(3n);
      reopened.close();
    });

    test("inactive candidate failures are retryable and do not publish projected state", async () => {
      const port = new MemoryRepackedPort();
      const vfs = await RepackedVfs.open(port, { extentSize });
      vfs.mkdir("/before", { nowMs: 1n });
      port.injectFault({
        operation: "write",
        file: "metadata-b.bin",
        label: "repack.metadata.write",
        outcome: "throw-after",
      });

      expect(() => vfs.repack()).toThrow("injected write failure after effect");
      expect(vfs.metrics().generation).toBe(1n);
      vfs.mkdir("/after", { nowMs: 2n });
      vfs.repack();
      expect(vfs.metrics().generation).toBe(2n);
      vfs.close();

      const reopened = await RepackedVfs.open(port);
      expect(reopened.readdir("/")).toEqual(["after", "before"]);
      reopened.close();
    });

    test("every pre-activation persistence failure leaves the exact live state retryable", async () => {
      const faults: MemoryFault[] = [
        { operation: "flush", file: "arena.bin", label: "repack.arena.flush", outcome: "throw-before" },
        { operation: "flush", file: "arena.bin", label: "repack.arena.flush", outcome: "throw-after" },
        { operation: "truncate", file: "metadata-b.bin", label: "repack.metadata.reset", outcome: "throw-before" },
        { operation: "truncate", file: "metadata-b.bin", label: "repack.metadata.reset", outcome: "throw-after" },
        { operation: "write", file: "metadata-b.bin", label: "repack.metadata.write", outcome: "throw-before" },
        { operation: "write", file: "metadata-b.bin", label: "repack.metadata.write", outcome: "throw-after" },
        { operation: "flush", file: "metadata-b.bin", label: "repack.metadata.flush", outcome: "throw-before" },
        { operation: "flush", file: "metadata-b.bin", label: "repack.metadata.flush", outcome: "throw-after" },
      ];
      for (const fault of faults) {
        const port = new MemoryRepackedPort();
        const vfs = await RepackedVfs.open(port, { extentSize });
        vfs.mkdir("/stable", { nowMs: 1n });
        port.injectFault(fault);

        expect(() => vfs.repack()).toThrow();
        expect(vfs.metrics().generation).toBe(1n);
        expect(vfs.readdir("/")).toEqual(["stable"]);
        vfs.repack();
        expect(vfs.metrics().generation).toBe(2n);
        vfs.close();

        const reopened = await RepackedVfs.open(port);
        expect(reopened.readdir("/")).toEqual(["stable"]);
        reopened.close();
      }
    });

    test("arena flush failure cannot publish a projected tail reclamation", async () => {
      for (const outcome of ["throw-before", "throw-after"] as const) {
        const port = new MemoryRepackedPort();
        const vfs = await RepackedVfs.open(port, { extentSize });
        vfs.writeFile("/retired", "bytes", { nowMs: 1n });
        vfs.unlink("/retired", 2n);
        vfs.repack();
        expect(vfs.metrics()).toMatchObject({ generation: 2n, totalExtents: 1n, quarantineExtents: 1 });
        port.injectFault({ operation: "flush", file: "arena.bin", label: "repack.arena.flush", outcome });

        expect(() => vfs.repack()).toThrow();
        expect(vfs.metrics()).toMatchObject({ generation: 2n, totalExtents: 1n, quarantineExtents: 1 });
        vfs.mkdir("/still-open", { nowMs: 3n });
        vfs.repack();
        expect(vfs.metrics()).toMatchObject({ generation: 3n, totalExtents: 0n, quarantineExtents: 0 });
        vfs.close();
      }
    });

    test("an ambiguous activation write poisons and reopen selects one exact authority", async () => {
      for (const activationDecision of ["absent", "full"] as const) {
        const port = new MemoryRepackedPort();
        const vfs = await RepackedVfs.open(port, { extentSize });
        vfs.mkdir("/stable", { nowMs: 1n });
        vfs.strictSync();
        port.injectFault({
          operation: "write",
          file: "activation.bin",
          label: "repack.activation.write",
          outcome: "throw-after",
        });

        expect(() => vfs.repack()).toThrow("injected write failure after effect");
        expect(() => vfs.readdir("/")).toThrow(StoreFailedError);
        const activation = port
          .pendingEffects()
          .findLast((effect) => effect.file === "activation.bin" && effect.operation === "write");
        expect(activation).toBeDefined();
        port.terminate({ [activation!.id]: activationDecision });

        const reopened = await RepackedVfs.open(port);
        expect(reopened.readdir("/")).toEqual(["stable"]);
        expect(reopened.metrics().generation).toBe(activationDecision === "full" ? 2n : 1n);
        reopened.close();
      }
    });

    test("activation flush errors poison and reopen resolves whether the flush took effect", async () => {
      for (const outcome of ["throw-before", "throw-after"] as const) {
        const port = new MemoryRepackedPort();
        const vfs = await RepackedVfs.open(port, { extentSize });
        vfs.mkdir("/stable", { nowMs: 1n });
        vfs.strictSync();
        port.injectFault({
          operation: "flush",
          file: "activation.bin",
          label: "repack.activation.flush",
          outcome,
        });

        expect(() => vfs.repack()).toThrow();
        expect(() => vfs.metrics()).toThrow(StoreFailedError);
        port.terminate();
        const reopened = await RepackedVfs.open(port);
        expect(reopened.metrics().generation).toBe(outcome === "throw-after" ? 2n : 1n);
        expect(reopened.readdir("/")).toEqual(["stable"]);
        reopened.close();
      }
    });

    test("a torn overwrite of the older activation slot preserves the current authority", async () => {
      const port = new MemoryRepackedPort();
      const vfs = await RepackedVfs.open(port, { extentSize });
      vfs.mkdir("/first", { nowMs: 1n });
      vfs.repack();
      vfs.mkdir("/second", { nowMs: 2n });
      vfs.strictSync();
      port.injectFault({
        operation: "write",
        file: "activation.bin",
        label: "repack.activation.write",
        outcome: "throw-after",
        bytes: 40,
      });

      expect(() => vfs.repack()).toThrow();
      const torn = port
        .pendingEffects()
        .findLast((effect) => effect.file === "activation.bin" && effect.operation === "write");
      expect(torn).toBeDefined();
      port.terminate({ [torn!.id]: "full" });

      const reopened = await RepackedVfs.open(port);
      expect(reopened.metrics().generation).toBe(2n);
      expect(reopened.readdir("/")).toEqual(["first", "second"]);
      reopened.close();
    });

    test("open orphans pin quarantine until closure across physical replacements", async () => {
      const port = new MemoryRepackedPort();
      const vfs = await RepackedVfs.open(port, { extentSize });
      vfs.writeFile("/orphan", "held", { nowMs: 1n });
      const fd = vfs.open("/orphan", "r");
      vfs.unlink("/orphan", 2n);
      vfs.repack();
      vfs.repack();
      expect(vfs.metrics()).toMatchObject({ totalExtents: 1n, quarantineExtents: 1 });
      const bytes = new Uint8Array(4);
      expect(vfs.read(fd, bytes, 0, 4, 0n)).toBe(4);
      expect(new TextDecoder().decode(bytes)).toBe("held");

      vfs.close(fd);
      vfs.repack();
      expect(vfs.metrics().quarantineExtents).toBe(1);
      vfs.repack();
      expect(vfs.metrics()).toMatchObject({ totalExtents: 0n, quarantineExtents: 0 });
      vfs.writeFile("/replacement", "reuse", { nowMs: 3n });
      vfs.strictSync();
      vfs.close();
      port.terminate();
      const reopened = await RepackedVfs.open(port);
      expect(new TextDecoder().decode(reopened.readFile("/replacement"))).toBe("reuse");
      reopened.close();
    });

    test("termination after one replacement recovers the extent still quarantined", async () => {
      const port = new MemoryRepackedPort();
      const vfs = await RepackedVfs.open(port, { extentSize });
      vfs.writeFile("/retired", "bytes", { nowMs: 1n });
      vfs.unlink("/retired", 2n);
      vfs.repack();
      vfs.close();
      port.terminate();

      const reopened = await RepackedVfs.open(port);
      expect(reopened.metrics()).toMatchObject({ generation: 2n, totalExtents: 1n, quarantineExtents: 1 });
      expect(() => reopened.lstat("/retired")).toThrow(FsError);
      reopened.close();
    });

    test("quarantine pressure is deferred while normal allocation grows immediately", async () => {
      const port = new MemoryRepackedPort();
      const vfs = await RepackedVfs.open(port, { extentSize });
      vfs.writeFile("/old", "old", { nowMs: 1n });
      vfs.unlink("/old", 2n);
      expect(vfs.metrics().pendingRepackReason).toBe("quarantine-pressure");

      vfs.writeFile("/new", "new", { nowMs: 3n });
      expect(vfs.metrics()).toMatchObject({ generation: 1n, totalExtents: 2n, repackCount: 0 });
      expect(vfs.runScheduledRepack()).toBe(true);
      expect(vfs.metrics()).toMatchObject({ generation: 2n, lastRepackReason: "quarantine-pressure" });
      expect(vfs.runScheduledRepack()).toBe(true);
      expect(vfs.metrics()).toMatchObject({ generation: 3n, lastRepackReason: "quarantine-pressure" });
      expect(vfs.runScheduledRepack(Number.MAX_SAFE_INTEGER)).toBe(false);
      expect(vfs.metrics()).toMatchObject({ generation: 3n, activeLogFrames: 0 });
      vfs.close();
    });

    test("a relaxed unlink never permits destructive reuse before two replacements", async () => {
      const port = new MemoryRepackedPort();
      const vfs = await RepackedVfs.open(port, { extentSize });
      vfs.writeFile("/a", "owner-a", { nowMs: 1n });
      vfs.strictSync();
      const stableEffects = new Set(port.pendingEffects().map((effect) => effect.id));

      vfs.unlink("/a", 2n);
      vfs.writeFile("/b", "owner-b", { nowMs: 3n });
      expect(vfs.metrics()).toMatchObject({ generation: 1n, totalExtents: 2n, quarantineExtents: 1 });
      const relaxed = port.pendingEffects().filter((effect) => !stableEffects.has(effect.id));
      const decisions: Record<number, "absent" | "full"> = {};
      for (const effect of relaxed) decisions[effect.id] = effect.file === "arena.bin" ? "full" : "absent";
      port.terminate(decisions);

      const reopened = await RepackedVfs.open(port);
      expect(new TextDecoder().decode(reopened.readFile("/a"))).toBe("owner-a");
      expect(() => reopened.lstat("/b")).toThrow(FsError);
      reopened.close();
    });

    test("non-tail reuse after two replacements exposes zeros when relaxed payload data is lost", async () => {
      const port = new MemoryRepackedPort();
      const vfs = await RepackedVfs.open(port, { extentSize });
      vfs.writeFile("/old", new Uint8Array(extentSize).fill(0x71), { nowMs: 1n });
      vfs.writeFile("/keeper", "keeper", { nowMs: 2n });
      vfs.strictSync();
      vfs.unlink("/old", 3n);
      vfs.repack();
      vfs.repack();
      expect(vfs.metrics()).toMatchObject({ totalExtents: 2n, availableExtents: 1, quarantineExtents: 0 });

      const effectsBefore = new Set(port.pendingEffects().map((effect) => effect.id));
      vfs.writeFile("/new", Uint8Array.of(0x21), { nowMs: 4n });
      expect(vfs.metrics().flushes.zeroBarrier).toBe(1);
      const effects = port.pendingEffects().filter((effect) => !effectsBefore.has(effect.id));
      const decisions: Record<number, "absent" | "full"> = {};
      for (const effect of effects) decisions[effect.id] = effect.file === "arena.bin" ? "absent" : "full";
      port.terminate(decisions);

      const reopened = await RepackedVfs.open(port);
      expect(reopened.readFile("/new")).toEqual(Uint8Array.of(0));
      expect(new TextDecoder().decode(reopened.readFile("/keeper"))).toBe("keeper");
      reopened.close();
    });

    test("termination before a post-repack allocation frame leaves durable zero residue harmless", async () => {
      const port = new MemoryRepackedPort();
      const vfs = await RepackedVfs.open(port, { extentSize });
      vfs.writeFile("/old", new Uint8Array(extentSize).fill(0x61), { nowMs: 1n });
      vfs.writeFile("/keeper", "keeper", { nowMs: 2n });
      vfs.strictSync();
      vfs.unlink("/old", 3n);
      vfs.repack();
      vfs.repack();
      vfs.writeFile("/lost", "lost", { nowMs: 4n });
      port.terminate();

      const reopened = await RepackedVfs.open(port);
      expect(() => reopened.lstat("/lost")).toThrow(FsError);
      expect(reopened.metrics().availableExtents).toBe(1);
      reopened.writeFile("/new", "new", { nowMs: 5n });
      reopened.strictSync();
      reopened.close();
      const final = await RepackedVfs.open(port);
      expect(new TextDecoder().decode(final.readFile("/new"))).toBe("new");
      expect(new TextDecoder().decode(final.readFile("/keeper"))).toBe("keeper");
      final.close();
    });

    test("a recovered near-soft-limit log is repacked at the next scheduled opportunity", async () => {
      const port = new MemoryRepackedPort();
      const seeded = await RepackedVfs.open(port, { extentSize });
      seeded.writeFile("/logged", new Uint8Array(), { nowMs: 1n });
      seeded.strictSync();
      seeded.close();

      const frames: Uint8Array[] = [];
      let suffixBytes = 0;
      for (let sequence = 2; sequence <= SOFT_ACTIVE_LOG_FRAMES; sequence += 1) {
        const frame = encodeTxnFrame({
          generation: 1n,
          sequence: BigInt(sequence),
          record: {
            kind: "changeMode",
            inodeId: 2n,
            mode: sequence & 1,
            ctimeMs: BigInt(sequence),
          },
        });
        frames.push(frame);
        suffixBytes += frame.byteLength;
      }
      const suffix = new Uint8Array(suffixBytes);
      let cursor = 0;
      for (const frame of frames) {
        suffix.set(frame, cursor);
        cursor += frame.byteLength;
      }
      const metadataEnd = port.durableBytes("metadata-a.bin").byteLength;
      const metadata = await port.acquire("metadata-a.bin", "fixture.acquire.soft-log");
      writeExact(metadata, BigInt(metadataEnd), suffix, "fixture.write.soft-log");
      metadata.flush("fixture.flush.soft-log");
      metadata.close();

      const vfs = await RepackedVfs.open(port);
      expect(vfs.metrics().activeLogFrames).toBe(SOFT_ACTIVE_LOG_FRAMES);
      expect(vfs.runScheduledRepack()).toBe(true);
      expect(vfs.metrics()).toMatchObject({
        generation: 2n,
        activeLogFrames: 0,
        lastRepackReason: "log-frames",
      });
      vfs.close();
    });

    test("arena quota exhaustion runs exactly two inline repacks and retries allocation once", async () => {
      const port = new MemoryRepackedPort();
      const vfs = await RepackedVfs.open(port, { extentSize });
      vfs.writeFile("/old", "old", { nowMs: 1n });
      vfs.unlink("/old", 2n);
      port.injectFault({ operation: "truncate", file: "arena.bin", label: "arena.grow", outcome: "quota" });

      vfs.writeFile("/new", "new", { nowMs: 3n });
      expect(vfs.metrics()).toMatchObject({ generation: 3n, repackCount: 2, lastRepackReason: "quota" });
      expect(new TextDecoder().decode(vfs.readFile("/new"))).toBe("new");
      vfs.close();
    });

    test("a failed quota retry performs no third repack and leaves the operation uncommitted", async () => {
      const port = new MemoryRepackedPort();
      const vfs = await RepackedVfs.open(port, { extentSize });
      port.injectFault({ operation: "truncate", file: "arena.bin", label: "arena.grow", outcome: "quota" });
      port.injectFault({ operation: "truncate", file: "arena.bin", label: "arena.grow", outcome: "quota" });

      expect(() => vfs.writeFile("/full", "x", { nowMs: 1n })).toThrow("injected arena quota exhaustion");
      expect(vfs.metrics()).toMatchObject({ generation: 3n, repackCount: 2 });
      expect(() => vfs.lstat("/full")).toThrow(FsError);
      vfs.close();
    });

    test("quota retry replans truncate, descriptor extension, and orphan growth", async () => {
      for (const operation of ["truncate", "descriptor", "orphan"] as const) {
        const port = new MemoryRepackedPort();
        const vfs = await RepackedVfs.open(port, { extentSize });
        vfs.writeFile("/target", new Uint8Array(), { nowMs: 1n });
        let fd: number | undefined;
        if (operation !== "truncate") fd = vfs.open("/target", "r+");
        if (operation === "orphan") vfs.unlink("/target", 2n);
        port.injectFault({ operation: "truncate", file: "arena.bin", label: "arena.grow", outcome: "quota" });

        if (operation === "truncate") {
          vfs.truncate("/target", 1n, 3n);
          expect(vfs.readFile("/target")).toEqual(Uint8Array.of(0));
        } else {
          expect(vfs.write(fd!, Uint8Array.of(0x41), 0, 1, 0n, 3n)).toBe(1);
          const output = new Uint8Array(1);
          expect(vfs.read(fd!, output, 0, 1, 0n)).toBe(1);
          expect(output).toEqual(Uint8Array.of(0x41));
          vfs.close(fd!);
        }
        expect(vfs.metrics()).toMatchObject({ generation: 3n, repackCount: 2, lastRepackReason: "quota" });
        vfs.close();
      }
    });

    test("tail-trim failure leaks only space and fresh reuse receives a durable zero barrier", async () => {
      for (const outcome of ["throw-before", "throw-after"] as const) {
        const port = new MemoryRepackedPort();
        const oldBytes = new Uint8Array(extentSize).fill(0x7b);
        const vfs = await RepackedVfs.open(port, { extentSize });
        vfs.writeFile("/old", oldBytes, { nowMs: 1n });
        vfs.strictSync();
        vfs.unlink("/old", 2n);
        vfs.repack();
        port.injectFault({ operation: "truncate", label: "repack.arena.trim", outcome });
        vfs.repack();
        expect(vfs.metrics().totalExtents).toBe(0n);

        const effectsBefore = new Set(port.pendingEffects().map((effect) => effect.id));
        vfs.writeFile("/new", Uint8Array.of(0x21), { nowMs: 3n });
        expect(vfs.metrics().flushes.zeroBarrier).toBe(1);
        const effects = port.pendingEffects().filter((effect) => !effectsBefore.has(effect.id));
        const decisions: Record<number, "absent" | "full"> = {};
        for (const effect of effects) decisions[effect.id] = effect.file === "arena.bin" ? "absent" : "full";
        port.terminate(decisions);

        const reopened = await RepackedVfs.open(port);
        expect(reopened.readFile("/new")).toEqual(Uint8Array.of(0));
        expect(() => reopened.lstat("/old")).toThrow(FsError);
        reopened.close();
      }
    });
  });
}
