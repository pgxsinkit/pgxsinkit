import { describe, expect, test } from "bun:test";

import { CorruptStoreError, StoreLimitError } from "../../packages/pglite-opfs-repacked/src/core/errors";
import { arenaByteOffset, readExact, writeExact } from "../../packages/pglite-opfs-repacked/src/core/port";
import { MemoryRepackedPort } from "../../packages/pglite-opfs-repacked/test/support/memory-port";
import type { MemoryOperationSummary } from "../../packages/pglite-opfs-repacked/test/support/memory-port";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

describe("opfs-repacked bounded persistence port", () => {
  test("the memory port exposes an immutable inventory of the exact labeled operations it observed", async () => {
    const port = new MemoryRepackedPort();
    await port.enumerate("inventory.enumerate");
    const handle = await port.acquire("arena.bin", "inventory.acquire");
    handle.getSize("inventory.size");
    handle.truncate(4, "inventory.truncate");
    handle.write(Uint8Array.of(1, 2), 0, "inventory.write");
    handle.read(new Uint8Array(2), 0, "inventory.read");
    handle.flush("inventory.flush");

    const observed = port.observedOperations();
    expect(observed).toEqual([
      { operation: "enumerate", file: undefined, label: "inventory.enumerate" },
      { operation: "acquire", file: "arena.bin", label: "inventory.acquire" },
      { operation: "getSize", file: "arena.bin", label: "inventory.size" },
      { operation: "truncate", file: "arena.bin", label: "inventory.truncate" },
      { operation: "write", file: "arena.bin", label: "inventory.write" },
      { operation: "read", file: "arena.bin", label: "inventory.read" },
      { operation: "flush", file: "arena.bin", label: "inventory.flush" },
    ]);
    expect(() =>
      (observed as MemoryOperationSummary[]).push({ operation: "flush", file: "arena.bin", label: "mutated" }),
    ).toThrow();
    expect(port.observedOperations()).toHaveLength(7);
  });

  test("fault selection can target a repeated labeled operation by zero-based occurrence", async () => {
    const port = new MemoryRepackedPort();
    const handle = await port.acquire("arena.bin", "inventory.acquire");
    port.injectFault({
      operation: "write",
      file: "arena.bin",
      label: "repeated.write",
      outcome: "throw-before",
      occurrence: 1,
    });

    expect(handle.write(Uint8Array.of(1), 0, "repeated.write")).toBe(1);
    expect(() => handle.write(Uint8Array.of(2), 1, "repeated.write")).toThrow("injected write failure before effect");
  });

  test("enumeration exposes every entry kind and acquisition/enumeration faults use the same labels", async () => {
    const port = new MemoryRepackedPort();
    port.injectEntry("unexpected.bin", "file");
    port.injectEntry("nested", "directory");
    expect(await port.enumerate("store.enumerate")).toEqual([
      { name: "nested", kind: "directory" },
      { name: "unexpected.bin", kind: "file" },
    ]);
    port.injectFault({ operation: "enumerate", label: "store.enumerate", outcome: "throw-before" });
    expect(port.enumerate("store.enumerate")).rejects.toThrow("injected enumerate failure");
    port.injectFault({ operation: "acquire", label: "store.acquire.arena", outcome: "throw-after" });
    expect(port.acquire("arena.bin", "store.acquire.arena")).rejects.toThrow("injected acquire failure");
    expect(await port.enumerate("store.enumerate")).toContainEqual({ name: "arena.bin", kind: "file" });
    expect(await port.acquire("arena.bin", "store.acquire.arena")).toBeDefined();
  });

  test("exact helpers close over short reads and writes without unbounded allocation", async () => {
    const port = new MemoryRepackedPort();
    const handle = await port.acquire("arena.bin", "store.acquire.arena");
    port.injectFault({ operation: "write", label: "arena.header", outcome: "short", bytes: 2 });
    writeExact(handle, 0n, textEncoder.encode("abcdef"), "arena.header");
    expect(handle.getSize("arena.size")).toBe(6);

    port.injectFault({ operation: "read", label: "arena.verify", outcome: "short", bytes: 1 });
    expect(textDecoder.decode(readExact(handle, 0n, 6, 6, "arena.verify"))).toBe("abcdef");
    expect(() => readExact(handle, 0n, 7, 7, "arena.too-long")).toThrow(CorruptStoreError);
    expect(() => readExact(handle, 0n, 7, 6, "arena.over-limit")).toThrow(StoreLimitError);
    expect(() => writeExact(handle, 1n << 64n, new Uint8Array([1]), "arena.bad-offset")).toThrow(StoreLimitError);
    port.injectFault({ operation: "write", label: "arena.no-progress", outcome: "short", bytes: 0 });
    let progressError: unknown;
    try {
      writeExact(handle, 6n, new Uint8Array([1]), "arena.no-progress");
    } catch (cause) {
      progressError = cause;
    }
    expect(progressError).toBeInstanceOf(Error);
    expect(progressError).not.toBeInstanceOf(CorruptStoreError);
    expect((progressError as Error).name).toBe("PortWriteError");
    const invalidProgressHandle = {
      name: "arena.bin" as const,
      getSize: () => 0,
      read: () => 0,
      write: () => Number.NaN,
      truncate: () => undefined,
      flush: () => undefined,
      close: () => undefined,
    };
    expect(() => writeExact(invalidProgressHandle, 0n, new Uint8Array([1]), "arena.invalid-progress")).toThrow(
      "made no valid write progress",
    );
    expect(arenaByteOffset(0n, 8192)).toBe(8192n);
    expect(arenaByteOffset(1n, 8192, 7)).toBe(16_391n);
    expect(() => arenaByteOffset(1n << 32n, 8192)).toThrow(StoreLimitError);
  });

  test("unflushed effects can be absent, partial, or independently present after termination", async () => {
    const port = new MemoryRepackedPort();
    let arena = await port.acquire("arena.bin", "store.acquire.arena");
    let metadata = await port.acquire("metadata-a.bin", "store.acquire.metadata-a");
    writeExact(arena, 0n, textEncoder.encode("arena"), "arena.write");
    writeExact(metadata, 0n, textEncoder.encode("metadata"), "metadata.write");
    const [arenaEffect, metadataEffect] = port.pendingEffects();
    expect(arenaEffect?.file).toBe("arena.bin");
    expect(metadataEffect?.file).toBe("metadata-a.bin");

    port.terminate({
      [arenaEffect!.id]: 3,
      [metadataEffect!.id]: "full",
    });
    expect(textDecoder.decode(port.durableBytes("arena.bin"))).toBe("are");
    expect(textDecoder.decode(port.durableBytes("metadata-a.bin"))).toBe("metadata");

    arena = await port.acquire("arena.bin", "store.acquire.arena");
    metadata = await port.acquire("metadata-a.bin", "store.acquire.metadata-a");
    writeExact(arena, 3n, textEncoder.encode("na"), "arena.retry");
    metadata.truncate(4, "metadata.truncate");
    port.terminate();
    expect(textDecoder.decode(port.durableBytes("arena.bin"))).toBe("are");
    expect(textDecoder.decode(port.durableBytes("metadata-a.bin"))).toBe("metadata");
  });

  test("a completed flush is stable and an ambiguous flush can persist before throwing", async () => {
    const port = new MemoryRepackedPort();
    let handle = await port.acquire("activation.bin", "store.acquire.activation");
    writeExact(handle, 0n, textEncoder.encode("first"), "activation.write");
    handle.flush("activation.flush");
    writeExact(handle, 0n, textEncoder.encode("second"), "activation.overwrite");
    port.terminate();
    expect(textDecoder.decode(port.durableBytes("activation.bin"))).toBe("first");

    handle = await port.acquire("activation.bin", "store.acquire.activation");
    writeExact(handle, 0n, textEncoder.encode("third"), "activation.write");
    port.injectFault({ operation: "flush", label: "activation.flush", outcome: "throw-after" });
    expect(() => handle.flush("activation.flush")).toThrow("injected flush failure after effect");
    port.terminate();
    expect(textDecoder.decode(port.durableBytes("activation.bin"))).toBe("third");
  });

  test("ambiguous writes expose the exact applied prefix to termination materialization", async () => {
    const port = new MemoryRepackedPort();
    const handle = await port.acquire("metadata-b.bin", "store.acquire.metadata-b");
    port.injectFault({
      operation: "write",
      label: "metadata.append",
      outcome: "throw-after",
      bytes: 3,
    });
    expect(() => handle.write(textEncoder.encode("frame"), 0, "metadata.append")).toThrow(
      "injected write failure after effect",
    );
    const [effect] = port.pendingEffects();
    expect(effect?.bytes).toBe(3);
    port.terminate({ [effect!.id]: "full" });
    expect(textDecoder.decode(port.durableBytes("metadata-b.bin"))).toBe("fra");
  });
});
