import { describe, expect, test } from "bun:test";

import { crc32, crc32WithZeroedRange } from "../../packages/pglite-opfs-repacked/src/core/checksum";
import {
  ACTIVATION_SLOT_BYTES,
  ARENA_HEADER_CHECKSUM_OFFSET,
  FRAME_CHECKSUM_OFFSET,
  METADATA_HEADER_BYTES,
  METADATA_HEADER_CHECKSUM_OFFSET,
  decodeActivationSlot,
  decodeArenaHeader,
  decodeMetadataBase,
  decodeTxnFrame,
  encodeActivationSlot,
  encodeArenaHeader,
  encodeMetadataBase,
  encodeValidatedMetadataBase,
  encodeTxnFrame,
  inspectMetadataBaseHeader,
  inspectTxnFrameHeader,
  metadataBaseDigest,
  selectActivation,
  selectActivationPair,
  txnFrameBytes,
} from "../../packages/pglite-opfs-repacked/src/core/codec";
import {
  CorruptStoreError,
  ExtentSizeMismatchError,
  StoreLimitError,
  StoreRecreationRequiredError,
} from "../../packages/pglite-opfs-repacked/src/core/errors";
import { ARENA_HEADER_BYTES, MAX_COMPONENT_BYTES } from "../../packages/pglite-opfs-repacked/src/core/limits";
import {
  applyTxn,
  createInitialState,
  estimateMetadataBasePayloadBytes,
  planCreateFile,
  planChmod,
  planMkdir,
  planRename,
  planReserveQuarantine,
  planResizeFile,
  planRmdir,
  planUnlink,
  planUtimes,
  projectRepack,
  canonicalStateView,
  validateState,
} from "../../packages/pglite-opfs-repacked/src/core/state-machine";
import type { TxnRecord, VfsState } from "../../packages/pglite-opfs-repacked/src/core/state-machine";

const EXTENT_SIZES = [8192, 64 * 1024];

function referenceCrc32(bytes: Uint8Array): number {
  let remainder = 0xffff_ffff;
  for (const byte of bytes) {
    remainder ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      remainder = (remainder & 1) === 1 ? 0xedb8_8320 ^ (remainder >>> 1) : remainder >>> 1;
    }
  }
  return (remainder ^ 0xffff_ffff) >>> 0;
}

describe("opfs-repacked checksums", () => {
  test("matches the CRC-32 reference across sliced and zeroed ranges", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf4_3926);

    const bytes = Uint8Array.from({ length: 8197 }, (_, index) => (index * 131 + 17) & 0xff);
    expect(crc32(bytes)).toBe(referenceCrc32(bytes));

    for (const [offset, length] of [
      [0, 0],
      [0, 4],
      [3, 7],
      [64, 4],
      [8189, 8],
    ] as const) {
      const expected = bytes.slice();
      expected.fill(0, offset, offset + length);
      expect(crc32WithZeroedRange(bytes, offset, length)).toBe(referenceCrc32(expected));
    }
  });
});

function rewriteArenaChecksum(bytes: Uint8Array): void {
  const checksum = crc32WithZeroedRange(bytes, ARENA_HEADER_CHECKSUM_OFFSET, 4);
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(
    ARENA_HEADER_CHECKSUM_OFFSET,
    checksum,
    true,
  );
}

function persistentStateView(state: VfsState): unknown {
  const {
    activeMetadataFile: _activeMetadataFile,
    retainedGenerations: _retainedGenerations,
    ...persistent
  } = canonicalStateView(state);
  return persistent;
}

function buildState(extentSize: number): VfsState {
  const state = createInitialState(extentSize);
  applyTxn(state, planMkdir(state, "/dir", { mode: 0, nowMs: 1n }).record);
  applyTxn(state, planCreateFile(state, "/dir/a", { mode: 0, nowMs: 2n, size: BigInt(extentSize + 1) }).record);
  applyTxn(state, planResizeFile(state, "/dir/a", 1n, 3n, "truncate").record);
  applyTxn(state, planCreateFile(state, "/victim", { nowMs: 4n, size: 1n }).record);
  applyTxn(state, planRename(state, "/dir/a", "/victim", 5n).record);
  validateState(state);
  return state;
}

describe.each(EXTENT_SIZES)("opfs-repacked format-version-1 codecs at extent size %i", (extentSize) => {
  test("arena identity is canonical", () => {
    const bytes = encodeArenaHeader({ extentSize });
    expect(bytes.byteLength).toBe(ARENA_HEADER_BYTES);
    expect(decodeArenaHeader(bytes)).toEqual({ extentSize, limitsProfileVersion: 1, formatVersion: 1 });
    expect(decodeArenaHeader(bytes, extentSize)).toEqual({
      extentSize,
      limitsProfileVersion: 1,
      formatVersion: 1,
    });
    expect(() => decodeArenaHeader(bytes, extentSize === 8192 ? 64 * 1024 : 8192)).toThrow(ExtentSizeMismatchError);

    const wrongVersion = bytes.slice();
    new DataView(wrongVersion.buffer).setUint32(8, 2, true);
    rewriteArenaChecksum(wrongVersion);
    expect(() => decodeArenaHeader(wrongVersion)).toThrow(StoreRecreationRequiredError);

    const invalidEnvelope = wrongVersion.slice();
    invalidEnvelope[100] = 1;
    expect(() => decodeArenaHeader(invalidEnvelope)).toThrow(CorruptStoreError);
    expect(() => decodeArenaHeader(invalidEnvelope)).not.toThrow(StoreRecreationRequiredError);
  });

  test("metadata base round-trips and has exact projected size", () => {
    let state = buildState(extentSize);
    for (let iteration = 0; iteration < 3; iteration += 1) {
      const encoded = encodeMetadataBase(state);
      expect(encodeValidatedMetadataBase(state)).toEqual(encoded);
      const decoded = decodeMetadataBase(encoded);
      expect(decoded.payloadBytes).toBe(estimateMetadataBasePayloadBytes(state));
      expect(decoded.payloadBytes).toBe(state.basePayloadBytes);
      expect(persistentStateView(decoded.state)).toEqual(persistentStateView(state));
      const record = planChmod(state, "/victim", iteration, BigInt(iteration + 20)).record;
      expect(decodeTxnFrame(encodeTxnFrame({ generation: state.generation, sequence: 1n, record }))).toEqual({
        generation: state.generation,
        sequence: 1n,
        record,
      });
      const activation = {
        sequence: BigInt(iteration + 1),
        metadataFile: state.activeMetadataFile,
        generation: state.generation,
        baseEnd: BigInt(encoded.byteLength),
        baseDigest: metadataBaseDigest(encoded),
      } as const;
      expect(decodeActivationSlot(encodeActivationSlot(activation))).toEqual(activation);
      state = projectRepack(state);
      validateState(state);
    }
  });

  test("canonical child ordering follows UTF-8 scalar order across surrogate pairs", () => {
    const state = createInitialState(extentSize);
    const supplementary = "\u{10000}";
    const privateUseBmp = "\ue000";
    applyTxn(state, planCreateFile(state, `/${supplementary}`, { nowMs: 1n, size: 0n }).record);
    applyTxn(state, planCreateFile(state, `/${privateUseBmp}`, { nowMs: 2n, size: 0n }).record);

    const decoded = decodeMetadataBase(encodeMetadataBase(state)).state;
    const root = decoded.inodes.get(decoded.rootInodeId);
    expect(root?.kind).toBe("directory");
    if (root?.kind !== "directory") throw new Error("decoded root is not a directory");
    expect([...root.children.keys()]).toEqual([privateUseBmp, supplementary]);
  });

  test("bounded header inspection owns metadata and frame length declarations", () => {
    const state = buildState(extentSize);
    const base = encodeMetadataBase(state);
    const baseHeader = inspectMetadataBaseHeader(base.subarray(0, METADATA_HEADER_BYTES));
    expect(baseHeader.baseEnd).toBe(BigInt(base.byteLength));
    expect(baseHeader.payloadLength).toBe(base.byteLength - METADATA_HEADER_BYTES);

    const frame = encodeTxnFrame({
      generation: state.generation,
      sequence: 1n,
      record: planChmod(state, "/victim", 0, 20n).record,
    });
    const frameHeader = inspectTxnFrameHeader(frame.subarray(0, 48));
    expect(txnFrameBytes(planChmod(state, "/victim", 0, 20n).record)).toBe(frame.byteLength);
    expect(frameHeader.frameBytes).toBe(frame.byteLength);
    expect(frameHeader.payloadLength).toBe(frame.byteLength - 48);

    const oversizedBase = base.slice(0, METADATA_HEADER_BYTES);
    const oversizedBaseView = new DataView(oversizedBase.buffer);
    oversizedBaseView.setUint32(40, 64 * 1024 * 1024 + 1, true);
    oversizedBaseView.setBigUint64(56, BigInt(METADATA_HEADER_BYTES + 64 * 1024 * 1024 + 1), true);
    expect(() => inspectMetadataBaseHeader(oversizedBase)).toThrow(CorruptStoreError);

    const oversizedFrame = frame.slice(0, 48);
    new DataView(oversizedFrame.buffer).setUint32(32, 1024 * 1024 + 1, true);
    expect(() => inspectTxnFrameHeader(oversizedFrame)).toThrow(CorruptStoreError);
  });

  test("all transaction record variants close over the canonical frame codec", () => {
    const state = createInitialState(extentSize);
    const records: TxnRecord[] = [];
    const recordAndApply = (record: TxnRecord) => {
      records.push(record);
      applyTxn(state, record);
    };
    recordAndApply(planMkdir(state, "/dir/nested", { nowMs: 1n, recursive: true }).record);
    recordAndApply(planCreateFile(state, "/dir/nested/a", { nowMs: 2n, size: BigInt(extentSize) + 1n }).record);
    recordAndApply(planChmod(state, "/dir/nested/a", 0, 3n).record);
    recordAndApply(planUtimes(state, "/dir/nested/a", 4n, 5n, 6n).record);
    recordAndApply(planResizeFile(state, "/dir/nested/a", 1n, 7n, "write").record);
    recordAndApply(planCreateFile(state, "/destination", { nowMs: 8n }).record);
    recordAndApply(planRename(state, "/dir/nested/a", "/destination", 9n).record);
    recordAndApply(planUnlink(state, "/destination", 10n).record);
    recordAndApply(planRmdir(state, "/dir/nested", 11n).record);
    recordAndApply(planReserveQuarantine(state, 1).record);

    for (const [index, record] of records.entries()) {
      const frame = encodeTxnFrame({ generation: 1n, sequence: BigInt(index + 1), record });
      expect(decodeTxnFrame(frame)).toEqual({
        generation: 1n,
        sequence: BigInt(index + 1),
        record,
      });
    }
  });

  test("random transitions keep the running base size equal to canonical bytes", () => {
    let seed = 0x6d2b79f5;
    const random = (maximum: number) => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return seed % maximum;
    };
    let state = createInitialState(extentSize);
    const paths: string[] = [];
    let nextName = 0;
    for (let step = 0; step < 200; step += 1) {
      const choice = paths.length === 0 ? 0 : random(4);
      if (choice === 0) {
        const path = `/f${nextName++}`;
        applyTxn(state, planCreateFile(state, path, { nowMs: BigInt(step + 1), size: BigInt(random(24_000)) }).record);
        paths.push(path);
      } else if (choice === 1) {
        const index = random(paths.length);
        applyTxn(state, planResizeFile(state, paths[index]!, BigInt(random(24_000)), BigInt(step + 1), "write").record);
      } else if (choice === 2) {
        const index = random(paths.length);
        applyTxn(state, planUnlink(state, paths[index]!, BigInt(step + 1)).record);
        paths.splice(index, 1);
      } else {
        state = projectRepack(state);
      }
      validateState(state);
      expect(encodeMetadataBase(state).byteLength - METADATA_HEADER_BYTES).toBe(state.basePayloadBytes);
    }
  });

  test("transaction-frame version bytes never claim store identity", () => {
    const record = planMkdir(createInitialState(extentSize), "/a", { nowMs: 1n }).record;
    const frame = encodeTxnFrame({ generation: 1n, sequence: 1n, record });
    const wrongVersion = frame.slice();
    new DataView(wrongVersion.buffer).setUint32(8, 2, true);
    expect(() => decodeTxnFrame(wrongVersion)).toThrow(CorruptStoreError);
    expect(() => decodeTxnFrame(wrongVersion)).not.toThrow(StoreRecreationRequiredError);
  });

  test("transaction writers reject path components their reader cannot accept", () => {
    const baseRecord = {
      kind: "removeFile" as const,
      parentId: 1n,
      parentMtimeMs: 1n,
      parentCtimeMs: 1n,
    };
    for (const name of ["x".repeat(MAX_COMPONENT_BYTES + 1), "", ".", "a/b", "\ud800"]) {
      expect(() =>
        encodeTxnFrame({
          generation: 1n,
          sequence: 1n,
          record: { ...baseRecord, name },
        }),
      ).toThrow();
    }
  });

  test("activation slots round-trip and only an exact consecutive alternating pair selects", () => {
    const state = buildState(extentSize);
    const baseA = encodeMetadataBase(state);
    const slotA = encodeActivationSlot({
      sequence: 1n,
      metadataFile: "a",
      generation: state.generation,
      baseEnd: BigInt(baseA.byteLength),
      baseDigest: 123,
    });
    const next = projectRepack(state);
    const baseB = encodeMetadataBase(next);
    const slotB = encodeActivationSlot({
      sequence: 2n,
      metadataFile: "b",
      generation: next.generation,
      baseEnd: BigInt(baseB.byteLength),
      baseDigest: 456,
    });

    expect(slotA.byteLength).toBe(ACTIVATION_SLOT_BYTES);
    expect(decodeActivationSlot(slotA)).toEqual({
      sequence: 1n,
      metadataFile: "a",
      generation: state.generation,
      baseEnd: BigInt(baseA.byteLength),
      baseDigest: 123,
    });
    expect(selectActivation(slotA, slotB)).toEqual(decodeActivationSlot(slotB));
    expect(selectActivationPair(slotA, slotB)).toEqual({
      selected: decodeActivationSlot(slotB),
      other: decodeActivationSlot(slotA),
    });
    expect(selectActivation(slotA, new Uint8Array(ACTIVATION_SLOT_BYTES))).toEqual(decodeActivationSlot(slotA));

    const sameSequence = encodeActivationSlot({
      sequence: 1n,
      metadataFile: "b",
      generation: next.generation,
      baseEnd: BigInt(baseB.byteLength),
      baseDigest: 456,
    });
    expect(() => selectActivation(slotA, sameSequence)).toThrow(CorruptStoreError);

    const skipped = encodeActivationSlot({
      sequence: 3n,
      metadataFile: "b",
      generation: next.generation,
      baseEnd: BigInt(baseB.byteLength),
      baseDigest: 456,
    });
    expect(() => selectActivation(slotA, skipped)).toThrow(CorruptStoreError);

    const sameFile = encodeActivationSlot({
      sequence: 2n,
      metadataFile: "a",
      generation: next.generation,
      baseEnd: BigInt(baseB.byteLength),
      baseDigest: 456,
    });
    expect(() => selectActivation(slotA, sameFile)).toThrow(CorruptStoreError);
    expect(() =>
      selectActivation(new Uint8Array(ACTIVATION_SLOT_BYTES), new Uint8Array(ACTIVATION_SLOT_BYTES)),
    ).toThrow(CorruptStoreError);

    const jumpedGeneration = encodeActivationSlot({
      sequence: 2n,
      metadataFile: "b",
      generation: 99n,
      baseEnd: BigInt(baseB.byteLength),
      baseDigest: 456,
    });
    expect(selectActivation(slotA, jumpedGeneration).generation).toBe(99n);
  });

  test("activation writers reject values their reader cannot accept", () => {
    const valid = { sequence: 1n, metadataFile: "a" as const, generation: 1n, baseEnd: 80n, baseDigest: 0 };
    expect(() => encodeActivationSlot({ ...valid, sequence: 0n })).toThrow(StoreLimitError);
    expect(() => encodeActivationSlot({ ...valid, generation: 0n })).toThrow(StoreLimitError);
    expect(() => encodeActivationSlot({ ...valid, baseEnd: 79n })).toThrow(StoreLimitError);
    const maximum = encodeActivationSlot({
      ...valid,
      sequence: (1n << 64n) - 1n,
      generation: (1n << 64n) - 1n,
      baseEnd: (1n << 64n) - 1n,
    });
    expect(decodeActivationSlot(maximum)).toEqual({
      ...valid,
      sequence: (1n << 64n) - 1n,
      generation: (1n << 64n) - 1n,
      baseEnd: (1n << 64n) - 1n,
    });
  });

  test("metadata decoder rejects semantically equal but non-canonical collection order", () => {
    const state = createInitialState(extentSize);
    applyTxn(state, planCreateFile(state, "/a", { nowMs: 1n, size: BigInt(extentSize) * 2n }).record);
    applyTxn(state, planUnlink(state, "/a", 2n).record);
    const available = projectRepack(projectRepack(state));
    const reordered = encodeMetadataBase(available).slice();
    const firstOffset = reordered.byteLength - 16;
    const first = reordered.slice(firstOffset, firstOffset + 8);
    reordered.copyWithin(firstOffset, firstOffset + 8, firstOffset + 16);
    reordered.set(first, firstOffset + 8);
    new DataView(reordered.buffer).setUint32(
      METADATA_HEADER_CHECKSUM_OFFSET,
      crc32WithZeroedRange(reordered, METADATA_HEADER_CHECKSUM_OFFSET, 4),
      true,
    );
    expect(() => decodeMetadataBase(reordered)).toThrow(CorruptStoreError);
  });

  test("canonical envelopes reject padding, trailing bytes, bad types, and oversized declarations", () => {
    const state = buildState(extentSize);
    const base = encodeMetadataBase(state);
    const badPadding = base.slice();
    badPadding[68] = 1;
    const badPaddingView = new DataView(badPadding.buffer);
    badPaddingView.setUint32(
      METADATA_HEADER_CHECKSUM_OFFSET,
      crc32WithZeroedRange(badPadding, METADATA_HEADER_CHECKSUM_OFFSET, 4),
      true,
    );
    expect(() => decodeMetadataBase(badPadding)).toThrow(CorruptStoreError);
    const trailing = new Uint8Array(base.byteLength + 1);
    trailing.set(base);
    expect(() => decodeMetadataBase(trailing)).toThrow(CorruptStoreError);

    const wrongVersion = base.slice();
    const wrongVersionView = new DataView(wrongVersion.buffer);
    wrongVersionView.setUint32(8, 2, true);
    wrongVersionView.setBigUint64(16, 0n, true);
    wrongVersionView.setUint32(24, 1, true);
    wrongVersionView.setUint8(28, 255);
    wrongVersionView.setUint32(44, 0xffff_ffff, true);
    wrongVersionView.setUint32(48, 0xffff_ffff, true);
    wrongVersionView.setUint32(
      METADATA_HEADER_CHECKSUM_OFFSET,
      crc32WithZeroedRange(wrongVersion, METADATA_HEADER_CHECKSUM_OFFSET, 4),
      true,
    );
    expect(() => decodeMetadataBase(wrongVersion)).toThrow(StoreRecreationRequiredError);

    const record = planMkdir(createInitialState(extentSize), "/a", { nowMs: 1n }).record;
    const frame = encodeTxnFrame({ generation: 1n, sequence: 1n, record });
    const badType = frame.slice();
    badType[48] = 255;
    new DataView(badType.buffer).setUint32(
      FRAME_CHECKSUM_OFFSET,
      crc32WithZeroedRange(badType, FRAME_CHECKSUM_OFFSET, 4),
      true,
    );
    expect(() => decodeTxnFrame(badType)).toThrow(CorruptStoreError);

    const oversized = frame.slice(0, 48);
    const oversizedView = new DataView(oversized.buffer);
    oversizedView.setUint32(32, 1024 * 1024 + 1, true);
    oversizedView.setUint32(FRAME_CHECKSUM_OFFSET, crc32WithZeroedRange(oversized, FRAME_CHECKSUM_OFFSET, 4), true);
    expect(() => decodeTxnFrame(oversized)).toThrow(CorruptStoreError);
  });
});
