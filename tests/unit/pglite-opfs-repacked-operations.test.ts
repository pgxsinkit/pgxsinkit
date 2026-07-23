import { describe, expect, test } from "bun:test";

import {
  METADATA_HEADER_BYTES,
  TXN_FRAME_HEADER_BYTES,
  decodeTxnFrame,
  encodeTxnFrame,
  inspectMetadataBaseHeader,
  inspectTxnFrameHeader,
} from "../../packages/pglite-opfs-repacked/src/core/codec";
import { FsError, StoreFailedError, StoreLimitError } from "../../packages/pglite-opfs-repacked/src/core/errors";
import { MAX_ACTIVE_LOG_FRAMES } from "../../packages/pglite-opfs-repacked/src/core/limits";
import { writeExact } from "../../packages/pglite-opfs-repacked/src/core/port";
import { RepackedVfs } from "../../packages/pglite-opfs-repacked/src/core/repacked-vfs";
import { MemoryRepackedPort } from "../../packages/pglite-opfs-repacked/test/support/memory-port";

const EXTENT_SIZES = [8192, 65_536] as const;

function durableResizeInodeIds(port: MemoryRepackedPort): bigint[] {
  const bytes = port.durableBytes("metadata-a.bin");
  let cursor = Number(inspectMetadataBaseHeader(bytes.subarray(0, METADATA_HEADER_BYTES)).baseEnd);
  const inodeIds: bigint[] = [];
  while (cursor < bytes.byteLength) {
    const inspected = inspectTxnFrameHeader(bytes.subarray(cursor, cursor + TXN_FRAME_HEADER_BYTES));
    const decoded = decodeTxnFrame(bytes.subarray(cursor, cursor + inspected.frameBytes));
    if (decoded.record.kind === "resizeFile") inodeIds.push(decoded.record.inodeId);
    cursor += inspected.frameBytes;
  }
  return inodeIds;
}

for (const extentSize of EXTENT_SIZES) {
  describe(`opfs-repacked transaction executor and metadata operations (${extentSize}-byte extents)`, () => {
    test("metadata operations persist through the one append/reduce path", async () => {
      const port = new MemoryRepackedPort();
      const vfs = await RepackedVfs.open(port, { extentSize });
      vfs.mkdir("/dir/nested", { recursive: true, mode: 0, nowMs: 1n });
      vfs.writeFile("/dir/nested/a", new Uint8Array(), { mode: 0, nowMs: 2n });
      vfs.chmod("/dir/nested/a", 0o600, 3n);
      vfs.utimes("/dir/nested/a", 4n, 5n, 6n);
      vfs.rename("/dir/nested/a", "/dir/a", 7n);
      expect(vfs.readdir("/dir")).toEqual(["a", "nested"]);
      expect(vfs.stat("/dir/a")).toMatchObject({ kind: "file", mode: 0o600, atimeMs: 4n, mtimeMs: 5n });
      vfs.unlink("/dir/a", 8n);
      vfs.rmdir("/dir/nested", 9n);
      vfs.strictSync();
      vfs.close();

      const reopened = await RepackedVfs.open(port);
      expect(reopened.readdir("/dir")).toEqual([]);
      expect(() => reopened.stat("/dir/a")).toThrow(FsError);
      reopened.close();
    });

    test("recursive mkdir strict reopen preserves exact mode and timestamps", async () => {
      const port = new MemoryRepackedPort();
      const vfs = await RepackedVfs.open(port, { extentSize });
      vfs.mkdir("/__proto__/nested", { recursive: true, mode: 0, nowMs: 42n });
      vfs.strictSync();
      vfs.close();

      const reopened = await RepackedVfs.open(port);
      expect(reopened.stat("/__proto__")).toMatchObject({
        kind: "directory",
        mode: 0,
        atimeMs: 42n,
        mtimeMs: 42n,
        ctimeMs: 42n,
      });
      expect(reopened.stat("/__proto__/nested")).toMatchObject({
        kind: "directory",
        mode: 0,
        atimeMs: 42n,
        mtimeMs: 42n,
        ctimeMs: 42n,
      });
      reopened.close();
    });

    test("cross-extent data, descriptor offsets, and zeroed extension persist", async () => {
      const port = new MemoryRepackedPort();
      const bytes = Uint8Array.from({ length: extentSize + 808 }, (_, index) => index % 251);
      const vfs = await RepackedVfs.open(port, { extentSize });
      vfs.writeFile("/data", bytes, { nowMs: 1n });
      const fd = vfs.open("/data", "r+");
      const first = new Uint8Array(12);
      expect(vfs.read(fd, first, 0, first.byteLength, BigInt(extentSize - 4))).toBe(12);
      expect(first).toEqual(bytes.subarray(extentSize - 4, extentSize + 8));
      expect(vfs.write(fd, new TextEncoder().encode("xy"), 0, 2, BigInt(extentSize + 812), 2n)).toBe(2);
      expect(vfs.fstat(fd).size).toBe(BigInt(extentSize + 814));
      vfs.close(fd);
      vfs.truncate("/data", 2n, 3n);
      vfs.truncate("/data", 6n, 4n);
      expect(vfs.readFile("/data")).toEqual(Uint8Array.from([bytes[0]!, bytes[1]!, 0, 0, 0, 0]));
      vfs.strictSync();
      vfs.close();

      const reopened = await RepackedVfs.open(port);
      expect(reopened.readFile("/data")).toEqual(Uint8Array.from([bytes[0]!, bytes[1]!, 0, 0, 0, 0]));
      reopened.close();
    });

    test("one awaited sync materializes one coalesced frame for sequential extending writes", async () => {
      const port = new MemoryRepackedPort();
      const vfs = await RepackedVfs.open(port, { extentSize });
      const fd = vfs.open("/file", "w+", 0o100600, 1n);
      vfs.strictSync();
      port.clearObservedOperations();

      for (let index = 0; index < 8; index += 1) {
        const chunk = new Uint8Array(1024).fill(index + 1);
        expect(vfs.write(fd, chunk, 0, chunk.byteLength, undefined, BigInt(index + 2))).toBe(chunk.byteLength);
      }
      expect(port.observedOperations().filter((operation) => operation.label === "metadata.log.append")).toHaveLength(
        0,
      );

      expect(vfs.runScheduledRepack()).toBe(false);
      expect(port.observedOperations().filter((operation) => operation.label === "metadata.log.append")).toHaveLength(
        1,
      );
      vfs.strictSync();
      expect(durableResizeInodeIds(port)).toEqual([2n]);
      vfs.close();
    });

    test("the exact arena-size cache serves descriptor, path, and orphan extensions", async () => {
      const port = new MemoryRepackedPort();
      const vfs = await RepackedVfs.open(port, { extentSize });
      const fd = vfs.open("/file", "w+", 0o100600, 1n);
      vfs.strictSync();
      port.clearObservedOperations();

      const chunk = new Uint8Array(1024).fill(3);
      expect(vfs.write(fd, chunk, 0, chunk.byteLength, undefined, 2n)).toBe(chunk.byteLength);
      expect(port.observedOperations().filter((operation) => operation.operation === "getSize")).toEqual([]);

      port.clearObservedOperations();
      expect(vfs.write(fd, chunk, 0, chunk.byteLength, BigInt(chunk.byteLength * 3), 3n)).toBe(chunk.byteLength);
      expect(port.observedOperations().filter((operation) => operation.operation === "getSize")).toEqual([]);
      expect(
        port
          .observedOperations()
          .filter((operation) => operation.operation === "write" || operation.operation === "flush")
          .map((operation) => operation.label),
      ).toEqual(expect.arrayContaining(["arena.gap-zero.write", "arena.gap-zero.flush"]));

      vfs.writeFile("/path", chunk, { nowMs: 4n });
      port.clearObservedOperations();
      vfs.truncate("/path", BigInt(chunk.byteLength * 3), 5n);
      expect(port.observedOperations().filter((operation) => operation.operation === "getSize")).toEqual([]);

      const orphanFd = vfs.open("/orphan", "w+", 0o100600, 6n);
      vfs.write(orphanFd, chunk, 0, chunk.byteLength, undefined, 7n);
      vfs.unlink("/orphan", 8n);
      port.clearObservedOperations();
      expect(vfs.write(orphanFd, chunk, 0, chunk.byteLength, BigInt(chunk.byteLength * 2), 9n)).toBe(chunk.byteLength);
      expect(port.observedOperations().filter((operation) => operation.operation === "getSize")).toEqual([]);
      vfs.close(orphanFd);
      vfs.close();
    });

    test("termination drops an unmaterialized resize tail to the last materialized size", async () => {
      const port = new MemoryRepackedPort();
      const vfs = await RepackedVfs.open(port, { extentSize });
      const fd = vfs.open("/file", "w+", 0o100600, 1n);
      const chunk = new Uint8Array(1024).fill(7);
      vfs.write(fd, chunk, 0, chunk.byteLength, undefined, 2n);
      vfs.strictSync();
      port.clearObservedOperations();

      vfs.write(fd, chunk, 0, chunk.byteLength, undefined, 3n);
      vfs.write(fd, chunk, 0, chunk.byteLength, undefined, 4n);
      expect(port.observedOperations().filter((operation) => operation.label === "metadata.log.append")).toHaveLength(
        0,
      );
      port.terminate();

      const reopened = await RepackedVfs.open(port);
      expect(reopened.stat("/file").size).toBe(BigInt(chunk.byteLength));
      expect(reopened.readFile("/file")).toEqual(chunk);
      reopened.close();
    });

    test("interleaved extending writes materialize ordered frames for both inodes", async () => {
      const port = new MemoryRepackedPort();
      const vfs = await RepackedVfs.open(port, { extentSize });
      const left = vfs.open("/left", "w+", 0o100600, 1n);
      const right = vfs.open("/right", "w+", 0o100600, 2n);
      vfs.strictSync();
      port.clearObservedOperations();

      vfs.write(left, Uint8Array.of(1, 2), 0, 2, undefined, 3n);
      vfs.write(right, Uint8Array.of(3, 4, 5), 0, 3, undefined, 4n);
      expect(port.observedOperations().filter((operation) => operation.label === "metadata.log.append")).toHaveLength(
        1,
      );
      vfs.runScheduledRepack();
      expect(port.observedOperations().filter((operation) => operation.label === "metadata.log.append")).toHaveLength(
        2,
      );
      vfs.strictSync();
      expect(durableResizeInodeIds(port)).toEqual([2n, 3n]);
      vfs.close();

      const reopened = await RepackedVfs.open(port);
      expect(reopened.readFile("/left")).toEqual(Uint8Array.of(1, 2));
      expect(reopened.readFile("/right")).toEqual(Uint8Array.of(3, 4, 5));
      reopened.close();
    });

    test("strict sync flushes arena, materializes the pending tail, then flushes metadata", async () => {
      const port = new MemoryRepackedPort();
      const vfs = await RepackedVfs.open(port, { extentSize });
      const fd = vfs.open("/file", "w+", 0o100600, 1n);
      vfs.strictSync();
      const chunk = new Uint8Array(1024).fill(9);
      vfs.write(fd, chunk, 0, chunk.byteLength, undefined, 2n);
      vfs.write(fd, chunk, 0, chunk.byteLength, undefined, 3n);
      port.clearObservedOperations();

      vfs.strictSync();

      expect(
        port
          .observedOperations()
          .filter((operation) => operation.operation === "write" || operation.operation === "flush")
          .map((operation) => operation.label),
      ).toEqual(["sync.arena.flush", "metadata.log.append", "sync.metadata.flush"]);
      port.terminate();
      const reopened = await RepackedVfs.open(port);
      expect(reopened.stat("/file").size).toBe(BigInt(chunk.byteLength * 2));
      expect(reopened.readFile("/file")).toEqual(new Uint8Array(chunk.byteLength * 2).fill(9));
      reopened.close();
    });

    test("unlink keeps open descriptors attached to an isolated runtime orphan", async () => {
      const port = new MemoryRepackedPort();
      const vfs = await RepackedVfs.open(port, { extentSize });
      vfs.writeFile("/open", new TextEncoder().encode("orphan"), { nowMs: 1n });
      const fd = vfs.open("/open", "r");
      vfs.unlink("/open", 2n);
      expect(() => vfs.stat("/open")).toThrow(FsError);
      const output = new Uint8Array(6);
      expect(vfs.read(fd, output, 0, output.byteLength, 0n)).toBe(6);
      expect(new TextDecoder().decode(output)).toBe("orphan");
      expect(vfs.fstat(fd)).toMatchObject({ kind: "file", size: 6n });
      vfs.close(fd);
      vfs.close();
    });

    test("extending writes commit and return only the known positive prefix", async () => {
      const port = new MemoryRepackedPort();
      const vfs = await RepackedVfs.open(port, { extentSize });
      vfs.writeFile("/partial", new Uint8Array(), { nowMs: 1n });
      const fd = vfs.open("/partial", "r+");
      port.injectFault({ operation: "write", label: "arena.write", outcome: "short", bytes: 3 });
      port.injectFault({ operation: "write", label: "arena.write", outcome: "throw-before" });

      expect(vfs.write(fd, new TextEncoder().encode("abcdef"), 0, 6, undefined, 2n)).toBe(3);
      expect(vfs.fstat(fd).size).toBe(3n);
      expect(new TextDecoder().decode(vfs.readFile("/partial"))).toBe("abc");
      const next = new Uint8Array(1);
      expect(vfs.read(fd, next, 0, 1)).toBe(0);
      vfs.strictSync();
      vfs.close();

      const reopened = await RepackedVfs.open(port);
      expect(new TextDecoder().decode(reopened.readFile("/partial"))).toBe("abc");
      reopened.close();
    });

    test("a failed extension zero barrier leaves the old size and retry exposes only zeros", async () => {
      const port = new MemoryRepackedPort();
      const vfs = await RepackedVfs.open(port, { extentSize });
      vfs.writeFile("/shrink", new TextEncoder().encode("secret"), { nowMs: 1n });
      const arenaEffectsBeforeShrink = port.pendingEffects().filter((effect) => effect.file === "arena.bin").length;
      vfs.truncate("/shrink", 2n, 2n);
      expect(port.pendingEffects().filter((effect) => effect.file === "arena.bin")).toHaveLength(
        arenaEffectsBeforeShrink,
      );
      const metadataEffectsBefore = port.pendingEffects().filter((effect) => effect.file === "metadata-a.bin").length;
      port.injectFault({
        operation: "write",
        label: "arena.gap-zero.write",
        outcome: "throw-after",
        bytes: 2,
      });
      expect(() => vfs.truncate("/shrink", 6n, 3n)).toThrow("injected write failure after effect");
      expect(vfs.stat("/shrink").size).toBe(2n);
      expect(port.pendingEffects().filter((effect) => effect.file === "metadata-a.bin")).toHaveLength(
        metadataEffectsBefore,
      );

      vfs.truncate("/shrink", 6n, 4n);
      expect(vfs.readFile("/shrink")).toEqual(Uint8Array.from([115, 101, 0, 0, 0, 0]));
      vfs.close();
    });

    test("termination after shrink and unflushed extension never exposes pre-shrink bytes", async () => {
      const port = new MemoryRepackedPort();
      const vfs = await RepackedVfs.open(port, { extentSize });
      vfs.writeFile("/shrink", new TextEncoder().encode("secret"), { nowMs: 1n });
      vfs.strictSync();
      vfs.truncate("/shrink", 2n, 2n);
      vfs.strictSync();

      const stableEffects = new Set(port.pendingEffects().map((effect) => effect.id));
      vfs.truncate("/shrink", 6n, 3n);
      const decisions: Record<number, "absent" | "full"> = {};
      for (const effect of port.pendingEffects()) {
        if (!stableEffects.has(effect.id)) decisions[effect.id] = effect.file === "arena.bin" ? "absent" : "full";
      }
      port.terminate(decisions);

      const reopened = await RepackedVfs.open(port);
      expect(reopened.readFile("/shrink")).toEqual(Uint8Array.from([115, 101, 0, 0, 0, 0]));
      reopened.close();
    });

    test("ambiguous fresh arena growth leaves no metadata and is safely retryable", async () => {
      const port = new MemoryRepackedPort();
      const vfs = await RepackedVfs.open(port, { extentSize });
      const metadataEffectsBefore = port.pendingEffects().filter((effect) => effect.file === "metadata-a.bin").length;
      port.injectFault({ operation: "truncate", label: "arena.grow", outcome: "throw-after" });
      expect(() => vfs.writeFile("/retry", "value", { nowMs: 1n })).toThrow("injected truncate failure after effect");
      expect(() => vfs.lstat("/retry")).toThrow(FsError);
      expect(port.pendingEffects().filter((effect) => effect.file === "metadata-a.bin")).toHaveLength(
        metadataEffectsBefore,
      );

      port.clearObservedOperations();
      vfs.writeFile("/retry", "value", { nowMs: 2n });
      expect(
        port
          .observedOperations()
          .filter((operation) => operation.operation === "getSize")
          .map((operation) => operation.label),
      ).toEqual(["arena.size.before-allocation"]);
      expect(
        port
          .observedOperations()
          .filter((operation) => operation.operation === "flush")
          .map((operation) => operation.label),
      ).toContain("arena.allocation.flush");
      expect(new TextDecoder().decode(vfs.readFile("/retry"))).toBe("value");
      vfs.close();
    });

    test("open flags enforce access and append ignores an explicit position", async () => {
      const port = new MemoryRepackedPort();
      const vfs = await RepackedVfs.open(port, { extentSize });
      vfs.writeFile("/flags", new TextEncoder().encode("abc"), { nowMs: 1n });
      const append = vfs.open("/flags", "a+");
      expect(vfs.write(append, new TextEncoder().encode("X"), 0, 1, 0n, 2n)).toBe(1);
      expect(vfs.write(append, new TextEncoder().encode("Y"), 0, 1, undefined, 3n)).toBe(1);
      expect(new TextDecoder().decode(vfs.readFile("/flags"))).toBe("abcXY");

      const readOnly = vfs.open("/flags", "r");
      expect(() => vfs.write(readOnly, new Uint8Array(1), 0, 1, 0n, 4n)).toThrow(FsError);
      const writeOnly = vfs.open("/created", "wx", 0, 5n);
      expect(() => vfs.read(writeOnly, new Uint8Array(1), 0, 1, 0n)).toThrow(FsError);
      expect(() => vfs.open("/created", "wx", 0, 6n)).toThrow(FsError);
      expect(() => vfs.read(999, new Uint8Array(1), 0, 1, 0n)).toThrow(FsError);
      expect(() => vfs.read(readOnly, new Uint8Array(1), 1, 1, 0n)).toThrow(FsError);
      vfs.close();
    });

    test("rename replacement keeps all open destination descriptors on one growing orphan", async () => {
      const port = new MemoryRepackedPort();
      const vfs = await RepackedVfs.open(port, { extentSize });
      vfs.writeFile("/source", new TextEncoder().encode("new"), { nowMs: 1n });
      vfs.writeFile("/destination", new TextEncoder().encode("old"), { nowMs: 2n });
      const reader = vfs.open("/destination", "r");
      const writer = vfs.open("/destination", "r+");
      vfs.rename("/source", "/destination", 3n);

      expect(new TextDecoder().decode(vfs.readFile("/destination"))).toBe("new");
      expect(vfs.write(writer, new TextEncoder().encode("!"), 0, 1, BigInt(extentSize), 4n)).toBe(1);
      expect(vfs.fstat(reader).size).toBe(BigInt(extentSize + 1));
      const tail = new Uint8Array(2);
      expect(vfs.read(reader, tail, 0, 2, BigInt(extentSize - 1))).toBe(2);
      expect(tail).toEqual(Uint8Array.from([0, 33]));
      vfs.close(reader);
      vfs.close(writer);
      vfs.strictSync();
      vfs.close();

      const reopened = await RepackedVfs.open(port);
      expect(new TextDecoder().decode(reopened.readFile("/destination"))).toBe("new");
      reopened.close();
    });

    test("writeFile commits a known partial file then surfaces the underlying failure", async () => {
      const port = new MemoryRepackedPort();
      const vfs = await RepackedVfs.open(port, { extentSize });
      port.injectFault({ operation: "write", label: "arena.write-file", outcome: "short", bytes: 2 });
      port.injectFault({ operation: "write", label: "arena.write-file", outcome: "throw-before" });
      expect(() => vfs.writeFile("/partial-file", new TextEncoder().encode("value"), { nowMs: 1n })).toThrow(
        "injected write failure before effect",
      );
      expect(new TextDecoder().decode(vfs.readFile("/partial-file"))).toBe("va");
      vfs.close();
    });

    test("writeFile honors string encoding, mode zero, append, overwrite, and exclusive flags", async () => {
      const port = new MemoryRepackedPort();
      const vfs = await RepackedVfs.open(port, { extentSize });
      vfs.writeFile("/options", "base", { encoding: "utf-8", mode: 0, nowMs: 1n });
      expect(vfs.stat("/options").mode).toBe(0);
      vfs.writeFile("/options", "+", { flag: "a", nowMs: 2n });
      vfs.writeFile("/options", "X", { flag: "r+", nowMs: 3n });
      expect(new TextDecoder().decode(vfs.readFile("/options"))).toBe("Xase+");
      expect(() => vfs.writeFile("/options", "no", { flag: "wx", nowMs: 4n })).toThrow(FsError);
      expect(() => vfs.writeFile("/missing", "no", { flag: "r+", nowMs: 5n })).toThrow(FsError);
      const effects = port.pendingEffects();
      expect(() => vfs.writeFile("/bad", "no", { encoding: "utf16le", nowMs: 6n })).toThrow(FsError);
      expect(port.pendingEffects()).toEqual(effects);
      vfs.writeFile("/options", "", { flag: "w", nowMs: 7n });
      expect(vfs.readFile("/options")).toEqual(new Uint8Array());
      vfs.close();
    });

    test("strict sync failure poisons and failed close skips persistence", async () => {
      const port = new MemoryRepackedPort();
      const vfs = await RepackedVfs.open(port, { extentSize });
      vfs.writeFile("/dirty", new TextEncoder().encode("x"), { nowMs: 1n });
      port.injectFault({ operation: "flush", label: "sync.arena.flush", outcome: "throw-before" });
      expect(() => vfs.strictSync()).toThrow("injected flush failure before effect");
      const pending = port.pendingEffects();
      expect(() => vfs.lstat("/dirty")).toThrow(StoreFailedError);
      expect(() => vfs.mkdir("/", { nowMs: -1n })).toThrow(StoreFailedError);
      expect(() => vfs.close()).toThrow(StoreFailedError);
      expect(port.pendingEffects()).toEqual(pending);
      const reopened = await RepackedVfs.open(port);
      reopened.close();
    });

    test("strict sync flushes dirty arena before metadata and stops on the first error", async () => {
      const port = new MemoryRepackedPort();
      const vfs = await RepackedVfs.open(port, { extentSize });
      vfs.writeFile("/ordered", "value", { nowMs: 1n });
      port.clearObservedOperations();
      vfs.strictSync();
      expect(
        port
          .observedOperations()
          .filter((operation) => operation.operation === "flush")
          .map((operation) => operation.label),
      ).toEqual(["sync.arena.flush", "sync.metadata.flush"]);

      vfs.writeFile("/failure", "value", { nowMs: 2n });
      port.clearObservedOperations();
      port.injectFault({ operation: "flush", label: "sync.arena.flush", outcome: "throw-before" });
      expect(() => vfs.strictSync()).toThrow("injected flush failure before effect");
      expect(
        port
          .observedOperations()
          .filter((operation) => operation.operation === "flush")
          .map((operation) => operation.label),
      ).toEqual(["sync.arena.flush"]);
      expect(() => vfs.close()).toThrow(StoreFailedError);
      expect(port.openHandleCount()).toBe(0);
    });

    test("strict sync skips every physical flush after read-only activity", async () => {
      const port = new MemoryRepackedPort();
      const vfs = await RepackedVfs.open(port, { extentSize });
      vfs.writeFile("/stable", "value", { nowMs: 1n });
      vfs.strictSync();
      const flushes = vfs.metrics().flushes;

      port.clearObservedOperations();
      expect(new TextDecoder().decode(vfs.readFile("/stable"))).toBe("value");
      vfs.strictSync();

      expect(port.observedOperations().filter((operation) => operation.operation === "flush")).toEqual([]);
      expect(vfs.metrics().flushes).toEqual(flushes);
      vfs.close();
    });

    test("data preparation precedes metadata and lost creation leaves no reachable file", async () => {
      const port = new MemoryRepackedPort();
      const vfs = await RepackedVfs.open(port, { extentSize });
      const previousIds = new Set(port.pendingEffects().map((effect) => effect.id));
      vfs.writeFile("/lost", "payload", { nowMs: 1n });
      const effects = port.pendingEffects().filter((effect) => !previousIds.has(effect.id));
      const metadataIndex = effects.findIndex((effect) => effect.file === "metadata-a.bin");
      expect(metadataIndex).toBeGreaterThan(0);
      expect(effects.slice(0, metadataIndex).every((effect) => effect.file === "arena.bin")).toBe(true);
      const decisions: Record<number, "full" | "absent"> = {};
      for (const effect of effects) decisions[effect.id] = effect.file === "arena.bin" ? "full" : "absent";
      port.terminate(decisions);

      const reopened = await RepackedVfs.open(port);
      expect(() => reopened.lstat("/lost")).toThrow(FsError);
      reopened.close();
    });

    test("ambiguous metadata append reopens at either complete transaction boundary", async () => {
      for (const appendDecision of ["absent", "full"] as const) {
        const port = new MemoryRepackedPort();
        const vfs = await RepackedVfs.open(port, { extentSize });
        vfs.mkdir("/stable", { nowMs: 1n });
        vfs.strictSync();
        port.injectFault({
          operation: "write",
          file: "metadata-a.bin",
          label: "metadata.log.append",
          outcome: "throw-after",
        });
        expect(() => vfs.mkdir("/ambiguous", { nowMs: 2n })).toThrow("injected write failure after effect");
        const append = port
          .pendingEffects()
          .findLast((effect) => effect.file === "metadata-a.bin" && effect.operation === "write");
        expect(append).toBeDefined();
        port.terminate({ [append!.id]: appendDecision });

        const reopened = await RepackedVfs.open(port);
        expect(reopened.readdir("/")).toEqual(appendDecision === "full" ? ["ambiguous", "stable"] : ["stable"]);
        reopened.close();
      }
    });

    test("active-log exhaustion rejects mixed operations before arena mutation", async () => {
      const port = new MemoryRepackedPort();
      const seeded = await RepackedVfs.open(port, { extentSize });
      seeded.writeFile("/full-log", new Uint8Array(), { nowMs: 1n });
      seeded.strictSync();
      seeded.close();

      const frames: Uint8Array[] = [];
      let suffixBytes = 0;
      for (let sequence = 2; sequence <= MAX_ACTIVE_LOG_FRAMES; sequence += 1) {
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
      const metadata = await port.acquire("metadata-a.bin", "fixture.acquire.full-log");
      writeExact(metadata, BigInt(metadataEnd), suffix, "fixture.write.full-log");
      metadata.flush("fixture.flush.full-log");
      metadata.close();

      const vfs = await RepackedVfs.open(port);
      const before = port.pendingEffects();
      const arenaEffectsBefore = before.filter((effect) => effect.file === "arena.bin").length;
      expect(() => vfs.writeFile("/full-log", "x", { nowMs: 40_000n })).toThrow(StoreLimitError);
      const after = port.pendingEffects();
      expect(after).toHaveLength(before.length);
      expect(after.filter((effect) => effect.file === "arena.bin")).toHaveLength(arenaEffectsBefore);
      vfs.close();
    });

    test("normal rejection appends nothing and an ambiguous append poisons", async () => {
      const port = new MemoryRepackedPort();
      const vfs = await RepackedVfs.open(port, { extentSize });
      const metadataBytes = port.durableBytes("metadata-a.bin").byteLength;
      const pendingBeforeRejection = port.pendingEffects();
      expect(() => vfs.mkdir("/", { nowMs: 1n })).toThrow(FsError);
      expect(port.pendingEffects()).toEqual(pendingBeforeRejection);
      expect(port.durableBytes("metadata-a.bin").byteLength).toBe(metadataBytes);

      port.injectFault({
        operation: "write",
        file: "metadata-a.bin",
        label: "metadata.log.append",
        outcome: "throw-after",
      });
      expect(() => vfs.mkdir("/ambiguous", { nowMs: 2n })).toThrow("injected write failure after effect");
      expect(() => vfs.stat("/")).toThrow(StoreFailedError);
      expect(() => vfs.close()).toThrow(StoreFailedError);
    });
  });
}
