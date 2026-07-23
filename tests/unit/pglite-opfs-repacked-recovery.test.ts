import { describe, expect, test } from "bun:test";

import { crc32WithZeroedRange } from "../../packages/pglite-opfs-repacked/src/core/checksum";
import {
  ACTIVATION_CHECKSUM_OFFSET,
  ACTIVATION_SLOT_BYTES,
  ARENA_HEADER_CHECKSUM_OFFSET,
  METADATA_HEADER_BYTES,
  METADATA_HEADER_CHECKSUM_OFFSET,
  encodeActivationSlot,
  encodeArenaHeader,
  encodeMetadataBase,
  encodeTxnFrame,
  metadataBaseDigest,
} from "../../packages/pglite-opfs-repacked/src/core/codec";
import {
  CorruptStoreError,
  ExtentSizeMismatchError,
  FsError,
  StoreOwnedError,
  StoreRecreationRequiredError,
  UnexpectedStoreEntryError,
} from "../../packages/pglite-opfs-repacked/src/core/errors";
import {
  DEFAULT_EXTENT_BYTES,
  MAX_ACTIVE_LOG_FRAMES,
  MAX_U64,
} from "../../packages/pglite-opfs-repacked/src/core/limits";
import { writeExact } from "../../packages/pglite-opfs-repacked/src/core/port";
import type { OwnedFileName } from "../../packages/pglite-opfs-repacked/src/core/port";
import { RepackedVfs } from "../../packages/pglite-opfs-repacked/src/core/repacked-vfs";
import type { RepackedVfsOpenOptions } from "../../packages/pglite-opfs-repacked/src/core/repacked-vfs";
import {
  applyTxn,
  createInitialState,
  planCreateFile,
  planMkdir,
  planResizeFile,
  projectRepack,
} from "../../packages/pglite-opfs-repacked/src/core/state-machine";
import { MemoryRepackedPort } from "../../packages/pglite-opfs-repacked/test/support/memory-port";

const EXTENT_SIZES = [8192, 65_536];

async function replaceDurableFile(port: MemoryRepackedPort, name: OwnedFileName, bytes: Uint8Array): Promise<void> {
  const handle = await port.acquire(name, `fixture.acquire.${name}`);
  handle.truncate(0, `fixture.truncate.${name}`);
  writeExact(handle, 0n, bytes, `fixture.write.${name}`);
  handle.flush(`fixture.flush.${name}`);
  handle.close();
}

async function appendDurableFile(port: MemoryRepackedPort, name: OwnedFileName, bytes: Uint8Array): Promise<void> {
  const handle = await port.acquire(name, `fixture.acquire.${name}`);
  const offset = handle.getSize(`fixture.size.${name}`);
  writeExact(handle, BigInt(offset), bytes, `fixture.append.${name}`);
  handle.flush(`fixture.flush.${name}`);
  handle.close();
}

async function openingError(port: MemoryRepackedPort, options: RepackedVfsOpenOptions = {}): Promise<unknown> {
  try {
    const opened = await RepackedVfs.open(port, options);
    opened.close();
    return undefined;
  } catch (cause) {
    return cause;
  }
}

async function proveAllHandlesReleased(port: MemoryRepackedPort): Promise<void> {
  const handles = [];
  try {
    for (const name of ["activation.bin", "arena.bin", "metadata-a.bin", "metadata-b.bin"] as const) {
      handles.push(await port.acquire(name, `fixture.prove-cleanup.${name}`));
    }
  } finally {
    for (const handle of handles.reverse()) handle.close();
  }
}

function concatenate(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

describe("opfs-repacked bootstrap and bounded recovery", () => {
  test("invalid extent sizes reject before any port operation or store mutation", async () => {
    for (const extentSize of [0, 8193, 4096, 16 * 1024 * 1024 + 8192, Number.NaN]) {
      const port = new MemoryRepackedPort();
      expect(await openingError(port, { extentSize })).toBeInstanceOf(TypeError);
      expect(port.observedOperations()).toEqual([]);
      expect(port.openHandleCount()).toBe(0);
      for (const name of ["activation.bin", "arena.bin", "metadata-a.bin", "metadata-b.bin"] as const) {
        expect(port.durableBytes(name)).toEqual(new Uint8Array());
      }
    }
  });

  test.each(EXTENT_SIZES)("bootstraps and reopens through RepackedVfs at extent size %i", async (extentSize) => {
    const port = new MemoryRepackedPort();
    const created = await RepackedVfs.open(port, { extentSize });
    created.close();

    expect(port.durableBytes("arena.bin").byteLength).toBe(8192);
    expect(port.durableBytes("metadata-a.bin").byteLength).toBeGreaterThan(METADATA_HEADER_BYTES);
    expect(port.durableBytes("metadata-b.bin").byteLength).toBe(0);
    expect(port.durableBytes("activation.bin").byteLength).toBe(ACTIVATION_SLOT_BYTES);

    const reopened = await RepackedVfs.open(port);
    reopened.close();
  });

  test.each(EXTENT_SIZES)(
    "selected activation must exactly match metadata identity, generation, end, and digest at %i bytes",
    async (extentSize) => {
      for (const mismatch of ["identity", "generation", "end", "digest"] as const) {
        const port = new MemoryRepackedPort();
        (await RepackedVfs.open(port, { extentSize })).close();
        const base = port.durableBytes("metadata-a.bin");
        const selected = {
          sequence: 1n,
          metadataFile: mismatch === "identity" ? ("b" as const) : ("a" as const),
          generation: mismatch === "generation" ? 2n : 1n,
          baseEnd: mismatch === "end" ? BigInt(base.byteLength + 1) : BigInt(base.byteLength),
          baseDigest: mismatch === "digest" ? metadataBaseDigest(base) ^ 1 : metadataBaseDigest(base),
        };
        if (mismatch === "identity") {
          await replaceDurableFile(port, "metadata-b.bin", base);
        }
        await replaceDurableFile(port, "activation.bin", encodeActivationSlot(selected));
        const before = port.durableBytes("metadata-a.bin");

        expect(await openingError(port)).toBeInstanceOf(CorruptStoreError);
        expect(port.durableBytes("metadata-a.bin")).toEqual(before);
        await proveAllHandlesReleased(port);
      }
    },
  );

  test.each(EXTENT_SIZES)(
    "activated stores reject missing, short, or integrity-invalid arena headers without mutation at %i bytes",
    async (extentSize) => {
      for (const arena of [
        new Uint8Array(),
        encodeArenaHeader({ extentSize }).subarray(0, 31),
        (() => {
          const invalid = encodeArenaHeader({ extentSize }).slice();
          invalid[invalid.byteLength - 1] = 1;
          return invalid;
        })(),
      ]) {
        const port = new MemoryRepackedPort();
        (await RepackedVfs.open(port, { extentSize })).close();
        const metadata = port.durableBytes("metadata-a.bin");
        const activation = port.durableBytes("activation.bin");
        await replaceDurableFile(port, "arena.bin", arena);

        expect(await openingError(port)).toBeInstanceOf(CorruptStoreError);
        expect(port.durableBytes("arena.bin")).toEqual(arena);
        expect(port.durableBytes("metadata-a.bin")).toEqual(metadata);
        expect(port.durableBytes("activation.bin")).toEqual(activation);
        await proveAllHandlesReleased(port);
      }
    },
  );

  test.each(EXTENT_SIZES)(
    "same-version arena and selected metadata extent identities must agree at %i bytes",
    async (extentSize) => {
      const port = new MemoryRepackedPort();
      (await RepackedVfs.open(port, { extentSize })).close();
      const metadata = port.durableBytes("metadata-a.bin");
      const activation = port.durableBytes("activation.bin");
      const mismatchedArena = encodeArenaHeader({ extentSize: extentSize === 8192 ? 65_536 : 8192 });
      await replaceDurableFile(port, "arena.bin", mismatchedArena);

      expect(await openingError(port)).toBeInstanceOf(CorruptStoreError);
      expect(port.durableBytes("arena.bin")).toEqual(mismatchedArena);
      expect(port.durableBytes("metadata-a.bin")).toEqual(metadata);
      expect(port.durableBytes("activation.bin")).toEqual(activation);
      await proveAllHandlesReleased(port);
    },
  );

  test.each(EXTENT_SIZES)(
    "canonical partial bootstrap residue is reset and completed at %i bytes",
    async (extentSize) => {
      const state = createInitialState(extentSize);
      const arena = encodeArenaHeader({ extentSize });
      const base = encodeMetadataBase(state);
      const slot = encodeActivationSlot({
        sequence: 1n,
        metadataFile: "a",
        generation: 1n,
        baseEnd: BigInt(base.byteLength),
        baseDigest: metadataBaseDigest(base),
      });
      const layouts = [
        { arena: arena.subarray(0, 101), base: new Uint8Array(), activation: new Uint8Array() },
        { arena, base: base.subarray(0, METADATA_HEADER_BYTES + 7), activation: new Uint8Array() },
        { arena, base, activation: slot.subarray(0, 73) },
      ];
      for (const layout of layouts) {
        const port = new MemoryRepackedPort();
        await replaceDurableFile(port, "arena.bin", layout.arena);
        await replaceDurableFile(port, "metadata-a.bin", layout.base);
        await replaceDurableFile(port, "activation.bin", layout.activation);

        (await RepackedVfs.open(port)).close();
        expect(port.durableBytes("arena.bin")).toEqual(arena);
        expect(port.durableBytes("metadata-a.bin")).toEqual(base);
        expect(port.durableBytes("activation.bin")).toEqual(slot);
      }
    },
  );

  test("indeterminate short bootstrap residue re-bootstraps at the default extent size", async () => {
    // A first-bootstrap crash can persist fewer than 20 header bytes — a
    // prefix that is identical for every extent size. Reopening without a
    // configured size must prefer the creation default, not the smallest
    // candidate that happens to match the ambiguous prefix.
    for (const persistedBytes of [8, 12, 16]) {
      const port = new MemoryRepackedPort();
      const intended = encodeArenaHeader({ extentSize: DEFAULT_EXTENT_BYTES });
      await replaceDurableFile(port, "arena.bin", intended.subarray(0, persistedBytes));

      (await RepackedVfs.open(port)).close();
      const header = port.durableBytes("arena.bin");
      const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
      expect(view.getUint32(16, true)).toBe(DEFAULT_EXTENT_BYTES);
    }
  });

  test.each(EXTENT_SIZES)(
    "reported bootstrap write and flush failures leave restartable or activated durable bytes at %i bytes",
    async (extentSize) => {
      const cases = [
        { operation: "write" as const, file: "arena.bin" as const, label: "bootstrap.arena.write", bytes: 101 },
        { operation: "flush" as const, file: "arena.bin" as const, label: "bootstrap.arena.flush" },
        {
          operation: "write" as const,
          file: "metadata-a.bin" as const,
          label: "bootstrap.metadata-a.write",
          bytes: METADATA_HEADER_BYTES + 7,
        },
        { operation: "flush" as const, file: "metadata-a.bin" as const, label: "bootstrap.metadata-a.flush" },
        {
          operation: "write" as const,
          file: "activation.bin" as const,
          label: "bootstrap.activation.write",
          bytes: 73,
        },
        { operation: "flush" as const, file: "activation.bin" as const, label: "bootstrap.activation.flush" },
      ];
      for (const fault of cases) {
        const port = new MemoryRepackedPort();
        port.injectFault({ ...fault, outcome: "throw-after" });
        expect(await openingError(port, { extentSize })).toBeInstanceOf(Error);
        const decisions = Object.fromEntries(port.pendingEffects().map((effect) => [effect.id, "full" as const]));
        port.terminate(decisions);

        (await RepackedVfs.open(port)).close();
        (await RepackedVfs.open(port)).close();
      }
    },
  );

  test.each(EXTENT_SIZES)(
    "every bootstrap write prefix is restartable or a complete initial activation at %i bytes",
    async (extentSize) => {
      const arena = encodeArenaHeader({ extentSize });
      const base = encodeMetadataBase(createInitialState(extentSize));
      const activation = encodeActivationSlot({
        sequence: 1n,
        metadataFile: "a",
        generation: 1n,
        baseEnd: BigInt(base.byteLength),
        baseDigest: metadataBaseDigest(base),
      });
      let recoveredPrefixes = 0;
      for (const [name, bytes] of [
        ["arena.bin", arena],
        ["metadata-a.bin", base],
        ["activation.bin", activation],
      ] as const) {
        for (let prefix = 0; prefix <= bytes.byteLength; prefix += 1) {
          const port = new MemoryRepackedPort();
          if (name !== "arena.bin") await replaceDurableFile(port, "arena.bin", arena);
          if (name === "activation.bin") await replaceDurableFile(port, "metadata-a.bin", base);
          await replaceDurableFile(port, name, bytes.subarray(0, prefix));
          (await RepackedVfs.open(port)).close();
          recoveredPrefixes += 1;
        }
      }
      expect(recoveredPrefixes).toBe(arena.byteLength + base.byteLength + activation.byteLength + 3);
    },
  );

  test("arbitrary unactivated residue fails closed without content mutation", async () => {
    const port = new MemoryRepackedPort();
    const residue = new Uint8Array([0xff, 0x01, 0x02]);
    await replaceDurableFile(port, "arena.bin", encodeArenaHeader({ extentSize: 8192 }));
    await replaceDurableFile(port, "activation.bin", residue);

    expect(await openingError(port, { extentSize: 64 * 1024 })).toBeInstanceOf(CorruptStoreError);
    expect(port.durableBytes("activation.bin")).toEqual(residue);
  });

  test("empty metadata with arena extent payload fails closed instead of bootstrapping", async () => {
    const port = new MemoryRepackedPort();
    const arena = concatenate([encodeArenaHeader({ extentSize: 8192 }), Uint8Array.of(0x51)]);
    await replaceDurableFile(port, "arena.bin", arena);

    expect(await openingError(port)).toBeInstanceOf(CorruptStoreError);
    expect(port.durableBytes("arena.bin")).toEqual(arena);
    expect(port.durableBytes("metadata-a.bin")).toEqual(new Uint8Array());
    expect(port.durableBytes("metadata-b.bin")).toEqual(new Uint8Array());
    expect(port.durableBytes("activation.bin")).toEqual(new Uint8Array());
  });

  test("integrity-invalid envelopes never classify version-looking bytes as another format", async () => {
    const arenaPort = new MemoryRepackedPort();
    const invalidArena = encodeArenaHeader({ extentSize: 8192 }).slice();
    new DataView(invalidArena.buffer).setUint32(8, 2, true);
    await replaceDurableFile(arenaPort, "arena.bin", invalidArena);
    expect(await openingError(arenaPort)).toBeInstanceOf(CorruptStoreError);

    const activationPort = new MemoryRepackedPort();
    const activated = await RepackedVfs.open(activationPort, { extentSize: 8192 });
    activated.repack();
    activated.close();
    const invalidOlderSlot = activationPort.durableBytes("activation.bin");
    new DataView(invalidOlderSlot.buffer).setUint32(8, 2, true);
    await replaceDurableFile(activationPort, "activation.bin", invalidOlderSlot);
    const selected = await RepackedVfs.open(activationPort);
    expect(selected.metrics().generation).toBe(2n);
    selected.close();

    const framePort = new MemoryRepackedPort();
    (await RepackedVfs.open(framePort, { extentSize: 8192 })).close();
    const baseEnd = framePort.durableBytes("metadata-a.bin").byteLength;
    const invalidFrame = encodeTxnFrame({
      generation: 1n,
      sequence: 1n,
      record: planMkdir(createInitialState(8192), "/discarded", { nowMs: 1n }).record,
    });
    new DataView(invalidFrame.buffer).setUint32(8, 2, true);
    await appendDurableFile(framePort, "metadata-a.bin", invalidFrame);
    const recovered = await RepackedVfs.open(framePort);
    expect(() => recovered.lstat("/discarded")).toThrow(FsError);
    recovered.close();
    expect(framePort.durableBytes("metadata-a.bin").byteLength).toBe(baseEnd);
  });

  test("integrity-valid unsupported identities win over trailing layout corruption", async () => {
    const arenaPort = new MemoryRepackedPort();
    const arena = new Uint8Array(8193);
    arena.set(encodeArenaHeader({ extentSize: 8192 }));
    const arenaView = new DataView(arena.buffer);
    arenaView.setUint32(8, 2, true);
    arenaView.setUint32(
      ARENA_HEADER_CHECKSUM_OFFSET,
      crc32WithZeroedRange(arena.subarray(0, 8192), ARENA_HEADER_CHECKSUM_OFFSET, 4),
      true,
    );
    await replaceDurableFile(arenaPort, "arena.bin", arena);
    expect(await openingError(arenaPort)).toBeInstanceOf(StoreRecreationRequiredError);

    const activationPort = new MemoryRepackedPort();
    const base = encodeMetadataBase(createInitialState(8192));
    const activation = new Uint8Array(ACTIVATION_SLOT_BYTES * 2 + 1);
    const slot = encodeActivationSlot({
      sequence: 1n,
      metadataFile: "a",
      generation: 1n,
      baseEnd: BigInt(base.byteLength),
      baseDigest: metadataBaseDigest(base),
    });
    const slotView = new DataView(slot.buffer);
    slotView.setUint32(8, 2, true);
    slotView.setUint32(ACTIVATION_CHECKSUM_OFFSET, crc32WithZeroedRange(slot, ACTIVATION_CHECKSUM_OFFSET, 4), true);
    activation.set(slot);
    await replaceDurableFile(activationPort, "activation.bin", activation);
    expect(await openingError(activationPort)).toBeInstanceOf(StoreRecreationRequiredError);

    const metadataPort = new MemoryRepackedPort();
    await replaceDurableFile(metadataPort, "arena.bin", new Uint8Array([0xff]));
    const unsupportedBase = encodeMetadataBase(createInitialState(8192));
    const unsupportedBaseView = new DataView(unsupportedBase.buffer);
    unsupportedBaseView.setUint32(8, 2, true);
    unsupportedBaseView.setUint32(
      METADATA_HEADER_CHECKSUM_OFFSET,
      crc32WithZeroedRange(unsupportedBase, METADATA_HEADER_CHECKSUM_OFFSET, 4),
      true,
    );
    await replaceDurableFile(metadataPort, "metadata-a.bin", unsupportedBase);
    expect(await openingError(metadataPort)).toBeInstanceOf(StoreRecreationRequiredError);
  });

  test("caller options cannot make contradictory partial bootstrap identities consistent", async () => {
    const port = new MemoryRepackedPort();
    await replaceDurableFile(port, "arena.bin", encodeArenaHeader({ extentSize: 8192 }).subarray(0, 20));
    await replaceDurableFile(port, "metadata-a.bin", encodeMetadataBase(createInitialState(64 * 1024)));

    expect(await openingError(port, { extentSize: 64 * 1024 })).toBeInstanceOf(CorruptStoreError);
  });

  test("inactive partial metadata is ignored but a corrupt selected base never falls back", async () => {
    const partialPort = new MemoryRepackedPort();
    (await RepackedVfs.open(partialPort, { extentSize: 8192 })).close();
    const partial = new Uint8Array([7, 6, 5, 4]);
    await replaceDurableFile(partialPort, "metadata-b.bin", partial);
    (await RepackedVfs.open(partialPort)).close();
    expect(partialPort.durableBytes("metadata-b.bin")).toEqual(partial);

    const corruptPort = new MemoryRepackedPort();
    (await RepackedVfs.open(corruptPort, { extentSize: 8192 })).close();
    const baseA = corruptPort.durableBytes("metadata-a.bin");
    const stateB = projectRepack(createInitialState(8192));
    const baseB = encodeMetadataBase(stateB);
    const slotA = encodeActivationSlot({
      sequence: 1n,
      metadataFile: "a",
      generation: 1n,
      baseEnd: BigInt(baseA.byteLength),
      baseDigest: metadataBaseDigest(baseA),
    });
    const slotB = encodeActivationSlot({
      sequence: 2n,
      metadataFile: "b",
      generation: 2n,
      baseEnd: BigInt(baseB.byteLength),
      baseDigest: metadataBaseDigest(baseB),
    });
    const manifest = new Uint8Array(ACTIVATION_SLOT_BYTES * 2);
    manifest.set(slotA);
    manifest.set(slotB, ACTIVATION_SLOT_BYTES);
    baseB[baseB.byteLength - 1] = baseB[baseB.byteLength - 1]! ^ 1;
    await replaceDurableFile(corruptPort, "metadata-b.bin", baseB);
    await replaceDurableFile(corruptPort, "activation.bin", manifest);

    expect(await openingError(corruptPort, { extentSize: 64 * 1024 })).toBeInstanceOf(CorruptStoreError);
  });

  test("directory ownership, exclusive ownership, extent options, and size failures reject cleanly", async () => {
    const unexpected = new MemoryRepackedPort();
    unexpected.injectEntry("foreign.bin", "file");
    expect(await openingError(unexpected)).toBeInstanceOf(UnexpectedStoreEntryError);
    expect(unexpected.durableBytes("arena.bin").byteLength).toBe(0);

    const owned = new MemoryRepackedPort();
    const lock = await owned.acquire("activation.bin", "fixture.hold-lock");
    expect(await openingError(owned)).toBeInstanceOf(StoreOwnedError);
    lock.close();

    const mismatch = new MemoryRepackedPort();
    (await RepackedVfs.open(mismatch, { extentSize: 8192 })).close();
    expect(await openingError(mismatch, { extentSize: 64 * 1024 })).toBeInstanceOf(ExtentSizeMismatchError);
    (await RepackedVfs.open(mismatch)).close();

    const failedSize = new MemoryRepackedPort();
    failedSize.injectFault({
      operation: "getSize",
      file: "arena.bin",
      label: "store.size.arena.bin",
      outcome: "throw-before",
    });
    expect(await openingError(failedSize)).toHaveProperty(
      "message",
      expect.stringContaining("injected getSize failure"),
    );
    await proveAllHandlesReleased(failedSize);
  });

  test("one invalid activation slot still requires the valid slot to match its selected base", async () => {
    const port = new MemoryRepackedPort();
    (await RepackedVfs.open(port, { extentSize: 8192 })).close();
    const stateA = createInitialState(8192);
    const stateB = projectRepack(stateA);
    const baseB = encodeMetadataBase(stateB);
    await replaceDurableFile(port, "metadata-b.bin", baseB);
    const slotB = encodeActivationSlot({
      sequence: 2n,
      metadataFile: "b",
      generation: 2n,
      baseEnd: BigInt(baseB.byteLength),
      baseDigest: metadataBaseDigest(baseB),
    });
    const manifest = new Uint8Array(ACTIVATION_SLOT_BYTES * 2);
    manifest.set(slotB, ACTIVATION_SLOT_BYTES);
    await replaceDurableFile(port, "activation.bin", manifest);

    (await RepackedVfs.open(port)).close();

    manifest[ACTIVATION_SLOT_BYTES + 48] = manifest[ACTIVATION_SLOT_BYTES + 48]! ^ 1;
    await replaceDurableFile(port, "activation.bin", manifest);
    expect(await openingError(port)).toBeInstanceOf(CorruptStoreError);
  });

  test.each([
    { name: "two invalid slots", kind: "invalid" },
    { name: "equal sequences", kind: "equal" },
    { name: "non-consecutive sequences", kind: "skipped" },
    { name: "the same metadata file", kind: "same-file" },
  ] as const)("$name activation layout fails closed without owned-file mutation", async ({ kind }) => {
    const port = new MemoryRepackedPort();
    const vfs = await RepackedVfs.open(port, { extentSize: 8192 });
    vfs.repack();
    vfs.close();
    const baseA = port.durableBytes("metadata-a.bin");
    const baseB = port.durableBytes("metadata-b.bin");
    const manifest = new Uint8Array(ACTIVATION_SLOT_BYTES * 2);
    if (kind !== "invalid") {
      manifest.set(
        encodeActivationSlot({
          sequence: 1n,
          metadataFile: "a",
          generation: 1n,
          baseEnd: BigInt(baseA.byteLength),
          baseDigest: metadataBaseDigest(baseA),
        }),
      );
      const metadataFile = kind === "same-file" ? ("a" as const) : ("b" as const);
      const selectedBase = metadataFile === "a" ? baseA : baseB;
      manifest.set(
        encodeActivationSlot({
          sequence: kind === "equal" ? 1n : kind === "skipped" ? 3n : 2n,
          metadataFile,
          generation: metadataFile === "a" ? 1n : 2n,
          baseEnd: BigInt(selectedBase.byteLength),
          baseDigest: metadataBaseDigest(selectedBase),
        }),
        ACTIVATION_SLOT_BYTES,
      );
    }
    await replaceDurableFile(port, "activation.bin", manifest);
    const before = Object.fromEntries(
      (["activation.bin", "arena.bin", "metadata-a.bin", "metadata-b.bin"] as const).map((name) => [
        name,
        port.durableBytes(name),
      ]),
    ) as Record<OwnedFileName, Uint8Array>;

    expect(await openingError(port)).toBeInstanceOf(CorruptStoreError);
    for (const name of ["activation.bin", "arena.bin", "metadata-a.bin", "metadata-b.bin"] as const) {
      expect(port.durableBytes(name)).toEqual(before[name]);
    }
    await proveAllHandlesReleased(port);
  });

  test("a second valid activation contributes only the immediate predecessor generation", async () => {
    const port = new MemoryRepackedPort();
    (await RepackedVfs.open(port, { extentSize: 8192 })).close();
    const stateB = projectRepack(createInitialState(8192));
    const baseB = encodeMetadataBase(stateB);
    await replaceDurableFile(port, "metadata-b.bin", baseB);
    await replaceDurableFile(
      port,
      "activation.bin",
      concatenate([
        encodeActivationSlot({
          sequence: 1n,
          metadataFile: "a",
          generation: 2n,
          baseEnd: BigInt(METADATA_HEADER_BYTES),
          baseDigest: 0,
        }),
        encodeActivationSlot({
          sequence: 2n,
          metadataFile: "b",
          generation: 2n,
          baseEnd: BigInt(baseB.byteLength),
          baseDigest: metadataBaseDigest(baseB),
        }),
      ]),
    );

    expect(await openingError(port)).toBeInstanceOf(CorruptStoreError);
  });

  test.each(EXTENT_SIZES)(
    "streaming replay truncates a full invalid frame and every later byte only after validation at %i bytes",
    async (extentSize) => {
      const port = new MemoryRepackedPort();
      (await RepackedVfs.open(port, { extentSize })).close();
      const state = createInitialState(extentSize);
      const record = planCreateFile(state, "/kept", { nowMs: 1n }).record;
      const first = encodeTxnFrame({ generation: 1n, sequence: 1n, record });
      applyTxn(state, record);
      const invalid = encodeTxnFrame({
        generation: 1n,
        sequence: 2n,
        record: planResizeFile(state, "/kept", BigInt(extentSize + 1), 2n, "write").record,
      });
      invalid[invalid.byteLength - 1] = invalid[invalid.byteLength - 1]! ^ 1;
      const later = encodeTxnFrame({
        generation: 1n,
        sequence: 3n,
        record: planMkdir(state, "/later", { nowMs: 3n }).record,
      });
      await appendDurableFile(port, "metadata-a.bin", first);
      await appendDurableFile(port, "metadata-a.bin", invalid);
      await appendDurableFile(port, "metadata-a.bin", later);
      const baseEnd =
        port.durableBytes("metadata-a.bin").byteLength - first.byteLength - invalid.byteLength - later.byteLength;

      const recovered = await RepackedVfs.open(port);
      expect(recovered.stat("/kept")).toMatchObject({ kind: "file", size: 0n, mtimeMs: 1n });
      expect(() => recovered.stat("/later")).toThrow(FsError);
      recovered.close();
      expect(port.durableBytes("arena.bin").byteLength).toBe(8192);
      expect(port.durableBytes("metadata-a.bin").byteLength).toBe(baseEnd + first.byteLength);
      (await RepackedVfs.open(port)).close();
    },
  );

  test.each(EXTENT_SIZES)(
    "a huge frame declaration terminates the prefix without allocating from it at %i bytes",
    async (extentSize) => {
      const port = new MemoryRepackedPort();
      (await RepackedVfs.open(port, { extentSize })).close();
      const baseEnd = port.durableBytes("metadata-a.bin").byteLength;
      const header = new Uint8Array(48);
      header.set(new TextEncoder().encode("PGXRPF01"));
      const view = new DataView(header.buffer);
      view.setUint32(8, 1, true);
      view.setUint32(12, 1, true);
      view.setBigUint64(16, 1n, true);
      view.setBigUint64(24, 1n, true);
      view.setUint32(32, 0xffff_ffff, true);
      await appendDurableFile(port, "metadata-a.bin", header);

      (await RepackedVfs.open(port)).close();
      expect(port.durableBytes("metadata-a.bin").byteLength).toBe(baseEnd);
    },
  );

  test.each(EXTENT_SIZES)(
    "a CRC-valid huge transition is discarded before arena growth at %i bytes",
    async (extentSize) => {
      const port = new MemoryRepackedPort();
      (await RepackedVfs.open(port, { extentSize })).close();
      const state = createInitialState(extentSize);
      const create = planCreateFile(state, "/file", { nowMs: 1n }).record;
      const first = encodeTxnFrame({ generation: 1n, sequence: 1n, record: create });
      const huge = encodeTxnFrame({
        generation: 1n,
        sequence: 2n,
        record: {
          kind: "resizeFile",
          operation: "write",
          inodeId: create.inodeId,
          size: MAX_U64,
          allocated: [],
          mtimeMs: 2n,
          ctimeMs: 2n,
        },
      });
      await appendDurableFile(port, "metadata-a.bin", concatenate([first, huge]));

      const recovered = await RepackedVfs.open(port);
      expect(recovered.stat("/file")).toMatchObject({ kind: "file", size: 0n });
      recovered.close();
      expect(port.durableBytes("arena.bin").byteLength).toBe(8192);
      expect(port.durableBytes("metadata-a.bin").byteLength).toBe(
        encodeMetadataBase(createInitialState(extentSize)).byteLength + first.byteLength,
      );
    },
  );

  test.each(EXTENT_SIZES)(
    "many small frames stop at the hard frame bound with fixed-size streaming reads at %i bytes",
    async (extentSize) => {
      const port = new MemoryRepackedPort();
      (await RepackedVfs.open(port, { extentSize })).close();
      const frames = Array.from({ length: MAX_ACTIVE_LOG_FRAMES + 1 }, (_, index) =>
        encodeTxnFrame({
          generation: 1n,
          sequence: BigInt(index + 1),
          record: {
            kind: "changeTimes",
            inodeId: 1n,
            atimeMs: 1n,
            mtimeMs: 1n,
            ctimeMs: 1n,
          },
        }),
      );
      await appendDurableFile(port, "metadata-a.bin", concatenate(frames));
      const baseEnd = encodeMetadataBase(createInitialState(extentSize)).byteLength;
      const acceptedBytes = frames
        .slice(0, MAX_ACTIVE_LOG_FRAMES)
        .reduce((total, frame) => total + frame.byteLength, 0);

      const recovered = await RepackedVfs.open(port);
      expect(recovered.stat("/")).toMatchObject({ mtimeMs: 1n });
      recovered.close();
      expect(port.durableBytes("metadata-a.bin").byteLength).toBe(baseEnd + acceptedBytes);
    },
  );
});
