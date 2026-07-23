import {
  ACTIVATION_SLOT_BYTES,
  METADATA_HEADER_BYTES,
  TXN_FRAME_HEADER_BYTES,
  decodeArenaHeader,
  decodeMetadataBase,
  decodeTxnFrame,
  encodeActivationSlot,
  encodeArenaHeader,
  encodeMetadataBase,
  inspectMetadataBaseHeader,
  inspectTxnFrameHeader,
  metadataBaseDigest,
  selectActivationPair,
  tryDecodeActivationSlot,
} from "./codec";
import type { ActivationRecord } from "./codec";
import {
  CorruptStoreError,
  ExtentSizeMismatchError,
  FsError,
  StoreLimitError,
  StoreRecreationRequiredError,
  UnexpectedStoreEntryError,
} from "./errors";
import {
  ARENA_HEADER_BYTES,
  DEFAULT_EXTENT_BYTES,
  MAX_ACTIVE_LOG_BYTES,
  MAX_ACTIVE_LOG_FRAMES,
  MAX_EXTENT_BYTES,
  MAX_METADATA_BASE_READER_BYTES,
  MIN_EXTENT_BYTES,
  checkedAdd,
  checkedMultiply,
  checkedSafeNumber,
  validateExtentSize,
} from "./limits";
import { OWNED_FILE_NAMES, metadataFileName, readExact, truncateChecked, writeExact } from "./port";
import type { OwnedFileName, RepackedFileHandle, RepackedPort, RepackedPortEntry } from "./port";
import { applyTxn, createInitialState, otherMetadataFile, validateState } from "./state-machine";
import type { MetadataFile, VfsState } from "./state-machine";

export interface OpenedMetadataStore {
  handles: Record<OwnedFileName, RepackedFileHandle>;
  state: VfsState;
  activeLogEnd: bigint;
  nextSequence: bigint;
  activeLogBytes: number;
  activeLogFrames: number;
  activationSequence: bigint;
  arenaHighWaterExtents: bigint;
  arenaSize: number;
  arenaDirty: boolean;
  activeMetadataDirty: boolean;
}

function validateEntries(entries: readonly RepackedPortEntry[]): void {
  for (const entry of entries) {
    if (!(OWNED_FILE_NAMES as readonly string[]).includes(entry.name) || entry.kind !== "file") {
      throw new UnexpectedStoreEntryError(entry.name);
    }
  }
}

function closeHandles(handles: readonly RepackedFileHandle[]): void {
  for (let index = handles.length - 1; index >= 0; index -= 1) {
    try {
      handles[index]!.close();
    } catch {
      // Failed-open cleanup preserves the opening error; lifecycle closes aggregate later.
    }
  }
}

async function acquireHandles(port: RepackedPort): Promise<Record<OwnedFileName, RepackedFileHandle>> {
  validateEntries(await port.enumerate("store.enumerate.initial"));
  const acquired: RepackedFileHandle[] = [];
  try {
    const activation = await port.acquire("activation.bin", "store.acquire.activation");
    acquired.push(activation);
    validateEntries(await port.enumerate("store.enumerate.locked"));
    for (const name of ["arena.bin", "metadata-a.bin", "metadata-b.bin"] as const) {
      acquired.push(await port.acquire(name, `store.acquire.${name}`));
    }
    return Object.fromEntries(acquired.map((handle) => [handle.name, handle])) as Record<
      OwnedFileName,
      RepackedFileHandle
    >;
  } catch (cause) {
    closeHandles(acquired);
    throw cause;
  }
}

function getSizes(handles: Record<OwnedFileName, RepackedFileHandle>): Record<OwnedFileName, number> {
  return Object.fromEntries(
    OWNED_FILE_NAMES.map((name) => [name, handles[name].getSize(`store.size.${name}`)]),
  ) as Record<OwnedFileName, number>;
}

function readSlot(handle: RepackedFileHandle, size: number, index: number): Uint8Array {
  const offset = index * ACTIVATION_SLOT_BYTES;
  if (offset >= size) return new Uint8Array();
  const length = Math.min(ACTIVATION_SLOT_BYTES, size - offset);
  return readExact(handle, BigInt(offset), length, ACTIVATION_SLOT_BYTES, `activation.read.slot-${index}`);
}

function isPrefix(bytes: Uint8Array, canonical: Uint8Array): boolean {
  if (bytes.byteLength > canonical.byteLength) return false;
  for (let index = 0; index < bytes.byteLength; index += 1) {
    if (bytes[index] !== canonical[index]) return false;
  }
  return true;
}

function readWhole(handle: RepackedFileHandle, size: number, maximum: number, label: string): Uint8Array {
  return readExact(handle, 0n, size, maximum, label);
}

function bootstrapExtentSize(
  arena: RepackedFileHandle,
  arenaSize: number,
  configuredExtentSize: number | undefined,
): number {
  if (arenaSize === 0) return configuredExtentSize ?? DEFAULT_EXTENT_BYTES;
  if (arenaSize >= ARENA_HEADER_BYTES) {
    const header = readExact(arena, 0n, ARENA_HEADER_BYTES, ARENA_HEADER_BYTES, "arena.read.bootstrap");
    const extentSize = decodeArenaHeader(header).extentSize;
    if (arenaSize > ARENA_HEADER_BYTES) {
      throw new CorruptStoreError("unactivated arena contains extent payload");
    }
    return extentSize;
  }
  const bytes = readWhole(arena, arenaSize, ARENA_HEADER_BYTES, "arena.read.bootstrap");
  let partialExtentSize: number | undefined;
  if (arenaSize >= 20) {
    const declared = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(16, true);
    try {
      partialExtentSize = validateExtentSize(declared);
    } catch (cause) {
      if (!(cause instanceof TypeError)) throw cause;
      partialExtentSize = undefined;
    }
  }
  // Candidate order is significance order: an ambiguous short prefix (fewer
  // than 20 bytes never fixes the extent-size field) must resolve to the
  // configured size or the creation default, never to the smallest candidate
  // that happens to share the prefix.
  const candidates = new Set<number>();
  if (configuredExtentSize !== undefined) candidates.add(configuredExtentSize);
  if (partialExtentSize !== undefined) candidates.add(partialExtentSize);
  candidates.add(DEFAULT_EXTENT_BYTES);
  if (arenaSize < 20) {
    for (let candidate = MIN_EXTENT_BYTES; candidate <= MAX_EXTENT_BYTES; candidate += ARENA_HEADER_BYTES) {
      candidates.add(candidate);
    }
  }
  const matchingExtentSize = [...candidates].find((candidate) =>
    isPrefix(bytes, encodeArenaHeader({ extentSize: candidate })),
  );
  if (matchingExtentSize === undefined) {
    throw new CorruptStoreError("unactivated arena is not canonical bootstrap residue");
  }
  return partialExtentSize ?? matchingExtentSize;
}

function detectArenaVersion(handle: RepackedFileHandle, size: number): void {
  if (size < ARENA_HEADER_BYTES) return;
  const bytes = readExact(handle, 0n, ARENA_HEADER_BYTES, ARENA_HEADER_BYTES, "arena.inspect.identity");
  try {
    decodeArenaHeader(bytes);
  } catch (cause) {
    if (cause instanceof StoreRecreationRequiredError) throw cause;
    if (!(cause instanceof CorruptStoreError)) throw cause;
  }
}

function detectCompleteMetadataVersion(handle: RepackedFileHandle, size: number, label: string): void {
  if (size < METADATA_HEADER_BYTES) return;
  let header;
  try {
    header = inspectMetadataBaseHeader(readExact(handle, 0n, METADATA_HEADER_BYTES, METADATA_HEADER_BYTES, label));
  } catch (cause) {
    if (cause instanceof CorruptStoreError) return;
    throw cause;
  }
  if (header.baseEnd > BigInt(size)) return;
  const base = readExact(
    handle,
    0n,
    Number(header.baseEnd),
    METADATA_HEADER_BYTES + MAX_METADATA_BASE_READER_BYTES,
    `${label}.base`,
  );
  try {
    decodeMetadataBase(base);
  } catch (cause) {
    if (cause instanceof StoreRecreationRequiredError) throw cause;
    if (!(cause instanceof CorruptStoreError)) throw cause;
  }
}

function classifyBootstrapResidue(
  handles: Record<OwnedFileName, RepackedFileHandle>,
  sizes: Record<OwnedFileName, number>,
  configuredExtentSize: number | undefined,
): number {
  const extentSize = bootstrapExtentSize(handles["arena.bin"], sizes["arena.bin"], configuredExtentSize);
  const initialA = createInitialState(extentSize);
  const baseA = encodeMetadataBase(initialA);
  const initialB = createInitialState(extentSize);
  initialB.activeMetadataFile = "b";
  initialB.retainedGenerations = { a: null, b: 1n };
  const baseB = encodeMetadataBase(initialB);
  for (const [name, canonical] of [
    ["metadata-a.bin", baseA],
    ["metadata-b.bin", baseB],
  ] as const) {
    const size = sizes[name];
    detectCompleteMetadataVersion(handles[name], size, `${name}.inspect.bootstrap`);
    if (size > canonical.byteLength) {
      throw new CorruptStoreError(`${name} exceeds the empty-root bootstrap envelope`);
    }
    const bytes = readWhole(handles[name], size, canonical.byteLength, `${name}.read.bootstrap`);
    if (!isPrefix(bytes, canonical)) {
      throw new CorruptStoreError(`${name} is not canonical bootstrap residue`);
    }
  }
  if (sizes["activation.bin"] > ACTIVATION_SLOT_BYTES * 2) {
    throw new CorruptStoreError("unactivated manifest exceeds its fixed envelope");
  }
  const initialSlot = encodeActivationSlot({
    sequence: 1n,
    metadataFile: "a",
    generation: 1n,
    baseEnd: BigInt(baseA.byteLength),
    baseDigest: metadataBaseDigest(baseA),
  });
  const canonicalManifest = new Uint8Array(ACTIVATION_SLOT_BYTES * 2);
  canonicalManifest.set(initialSlot);
  const manifest = readWhole(
    handles["activation.bin"],
    sizes["activation.bin"],
    canonicalManifest.byteLength,
    "activation.read.bootstrap",
  );
  if (!isPrefix(manifest, canonicalManifest)) {
    throw new CorruptStoreError("manifest is not canonical bootstrap residue");
  }
  if (
    sizes["arena.bin"] === ARENA_HEADER_BYTES &&
    configuredExtentSize !== undefined &&
    configuredExtentSize !== extentSize
  ) {
    throw new ExtentSizeMismatchError(configuredExtentSize, extentSize);
  }
  return sizes["arena.bin"] < ARENA_HEADER_BYTES && configuredExtentSize !== undefined
    ? configuredExtentSize
    : extentSize;
}

function bootstrap(handles: Record<OwnedFileName, RepackedFileHandle>, extentSize: number): OpenedMetadataStore {
  const state = createInitialState(extentSize);
  const arenaBytes = encodeArenaHeader({ extentSize });
  const baseBytes = encodeMetadataBase(state);
  const activationBytes = encodeActivationSlot({
    sequence: 1n,
    metadataFile: "a",
    generation: 1n,
    baseEnd: BigInt(baseBytes.byteLength),
    baseDigest: metadataBaseDigest(baseBytes),
  });
  const arena = handles["arena.bin"];
  arena.truncate(0, "bootstrap.arena.reset");
  writeExact(arena, 0n, arenaBytes, "bootstrap.arena.write");
  arena.flush("bootstrap.arena.flush");
  const metadataA = handles["metadata-a.bin"];
  metadataA.truncate(0, "bootstrap.metadata-a.reset");
  writeExact(metadataA, 0n, baseBytes, "bootstrap.metadata-a.write");
  metadataA.flush("bootstrap.metadata-a.flush");
  handles["metadata-b.bin"].truncate(0, "bootstrap.metadata-b.reset");
  const activation = handles["activation.bin"];
  activation.truncate(0, "bootstrap.activation.reset");
  writeExact(activation, 0n, activationBytes, "bootstrap.activation.write");
  activation.flush("bootstrap.activation.flush");
  const decoded = decodeMetadataBase(baseBytes);
  return {
    handles,
    state: decoded.state,
    activeLogEnd: decoded.baseEnd,
    nextSequence: 1n,
    activeLogBytes: 0,
    activeLogFrames: 0,
    activationSequence: 1n,
    arenaHighWaterExtents: 0n,
    arenaSize: arenaBytes.byteLength,
    arenaDirty: false,
    activeMetadataDirty: false,
  };
}

function metadataHandle(handles: Record<OwnedFileName, RepackedFileHandle>, file: MetadataFile): RepackedFileHandle {
  return handles[metadataFileName(file)];
}

function verifyInactiveVersion(
  handles: Record<OwnedFileName, RepackedFileHandle>,
  sizes: Record<OwnedFileName, number>,
  selectedFile: MetadataFile,
): void {
  const inactiveName = metadataFileName(otherMetadataFile(selectedFile));
  detectCompleteMetadataVersion(handles[inactiveName], sizes[inactiveName], `${inactiveName}.inspect.inactive`);
}

function readSelectedBase(
  handle: RepackedFileHandle,
  fileSize: number,
  selected: ActivationRecord,
): ReturnType<typeof decodeMetadataBase> & { header: ReturnType<typeof inspectMetadataBaseHeader> } {
  if (fileSize < METADATA_HEADER_BYTES) throw new CorruptStoreError("selected metadata base is missing or short");
  const headerBytes = readExact(handle, 0n, METADATA_HEADER_BYTES, METADATA_HEADER_BYTES, "metadata.read.header");
  const header = inspectMetadataBaseHeader(headerBytes);
  if (header.baseEnd !== selected.baseEnd || header.baseEnd > BigInt(fileSize)) {
    throw new CorruptStoreError("selected metadata base end does not match activation");
  }
  const baseBytes = readExact(
    handle,
    0n,
    Number(header.baseEnd),
    METADATA_HEADER_BYTES + MAX_METADATA_BASE_READER_BYTES,
    "metadata.read.base",
  );
  const decoded = decodeMetadataBase(baseBytes);
  if (
    decoded.state.activeMetadataFile !== selected.metadataFile ||
    decoded.state.generation !== selected.generation ||
    decoded.baseEnd !== selected.baseEnd ||
    decoded.baseDigest !== selected.baseDigest
  ) {
    throw new CorruptStoreError("selected metadata base identity does not match activation");
  }
  return { ...decoded, header };
}

function requiredArenaEnd(state: VfsState): bigint {
  return checkedAdd(
    BigInt(ARENA_HEADER_BYTES),
    checkedMultiply(state.allocator.totalExtents, BigInt(state.extentSize), "required arena bytes"),
    "required arena end",
  );
}

function replayLog(
  handle: RepackedFileHandle,
  fileSize: number,
  state: VfsState,
  baseEnd: bigint,
): { validEnd: bigint; nextSequence: bigint; requiredArenaEnd: bigint } {
  let cursor = checkedSafeNumber(baseEnd, "active log start");
  let sequence = 1n;
  let frameCount = 0;
  while (cursor < fileSize && frameCount < MAX_ACTIVE_LOG_FRAMES) {
    const logBytes = cursor - Number(baseEnd);
    const remaining = fileSize - cursor;
    if (remaining < TXN_FRAME_HEADER_BYTES || logBytes + TXN_FRAME_HEADER_BYTES > MAX_ACTIVE_LOG_BYTES) break;
    const headerBytes = readExact(
      handle,
      BigInt(cursor),
      TXN_FRAME_HEADER_BYTES,
      TXN_FRAME_HEADER_BYTES,
      "metadata.log.read-header",
    );
    let inspected;
    try {
      inspected = inspectTxnFrameHeader(headerBytes);
    } catch (cause) {
      if (cause instanceof CorruptStoreError) break;
      throw cause;
    }
    if (inspected.frameBytes > remaining || logBytes + inspected.frameBytes > MAX_ACTIVE_LOG_BYTES) break;
    const frameBytes = readExact(
      handle,
      BigInt(cursor),
      inspected.frameBytes,
      TXN_FRAME_HEADER_BYTES + inspected.payloadLength,
      "metadata.log.read-frame",
    );
    try {
      const frame = decodeTxnFrame(frameBytes);
      if (frame.generation !== state.generation || frame.sequence !== sequence) break;
      applyTxn(state, frame.record);
    } catch (cause) {
      if (cause instanceof CorruptStoreError || cause instanceof FsError || cause instanceof StoreLimitError) {
        break;
      }
      throw cause;
    }
    cursor += inspected.frameBytes;
    sequence += 1n;
    frameCount += 1;
  }
  validateState(state);
  return { validEnd: BigInt(cursor), nextSequence: sequence, requiredArenaEnd: requiredArenaEnd(state) };
}

function recoverActivated(
  handles: Record<OwnedFileName, RepackedFileHandle>,
  sizes: Record<OwnedFileName, number>,
  leftBytes: Uint8Array,
  rightBytes: Uint8Array,
  configuredExtentSize: number | undefined,
): OpenedMetadataStore {
  if (sizes["arena.bin"] < ARENA_HEADER_BYTES) {
    throw new CorruptStoreError("activated arena header is missing or short");
  }
  const arenaHeader = decodeArenaHeader(
    readExact(handles["arena.bin"], 0n, ARENA_HEADER_BYTES, ARENA_HEADER_BYTES, "arena.read.header"),
  );
  const selection = selectActivationPair(leftBytes, rightBytes);
  verifyInactiveVersion(handles, sizes, selection.selected.metadataFile);
  const selectedHandle = metadataHandle(handles, selection.selected.metadataFile);
  const selectedName = selectedHandle.name;
  const decoded = readSelectedBase(selectedHandle, sizes[selectedName], selection.selected);
  if (
    decoded.state.extentSize !== arenaHeader.extentSize ||
    decoded.header.limitsProfileVersion !== arenaHeader.limitsProfileVersion
  ) {
    throw new CorruptStoreError("arena and metadata identities disagree");
  }
  if (selection.other !== null) {
    decoded.state.retainedGenerations[selection.other.metadataFile] = selection.other.generation;
  }
  try {
    validateState(decoded.state);
  } catch (cause) {
    if (cause instanceof StoreLimitError) {
      throw new CorruptStoreError(`activation retained-generation facts are invalid: ${cause.message}`, { cause });
    }
    throw cause;
  }
  const replayed = replayLog(selectedHandle, sizes[selectedName], decoded.state, decoded.baseEnd);
  if (configuredExtentSize !== undefined && configuredExtentSize !== arenaHeader.extentSize) {
    throw new ExtentSizeMismatchError(configuredExtentSize, arenaHeader.extentSize);
  }
  const requiredEnd = checkedSafeNumber(replayed.requiredArenaEnd, "required arena end");
  const arenaDirty = sizes["arena.bin"] < requiredEnd;
  if (arenaDirty) {
    truncateChecked(handles["arena.bin"], replayed.requiredArenaEnd, "recovery.arena.grow");
  }
  const activeMetadataDirty = replayed.validEnd < BigInt(sizes[selectedName]);
  if (activeMetadataDirty) {
    truncateChecked(selectedHandle, replayed.validEnd, "recovery.metadata.discard-suffix");
  }
  const physicalArenaExtents =
    (BigInt(Math.max(0, sizes["arena.bin"] - ARENA_HEADER_BYTES)) + BigInt(arenaHeader.extentSize) - 1n) /
    BigInt(arenaHeader.extentSize);
  return {
    handles,
    state: decoded.state,
    activeLogEnd: replayed.validEnd,
    nextSequence: replayed.nextSequence,
    activeLogBytes: Number(replayed.validEnd - decoded.baseEnd),
    activeLogFrames: Number(replayed.nextSequence - 1n),
    activationSequence: selection.selected.sequence,
    arenaHighWaterExtents:
      physicalArenaExtents > decoded.state.allocator.totalExtents
        ? physicalArenaExtents
        : decoded.state.allocator.totalExtents,
    arenaSize: arenaDirty ? requiredEnd : sizes["arena.bin"],
    arenaDirty,
    activeMetadataDirty,
  };
}

export async function openMetadataStore(
  port: RepackedPort,
  options: { extentSize?: number },
): Promise<OpenedMetadataStore> {
  const configuredExtentSize = options.extentSize;
  if (configuredExtentSize !== undefined) validateExtentSize(configuredExtentSize);
  const handles = await acquireHandles(port);
  try {
    const sizes = getSizes(handles);
    const leftBytes = readSlot(handles["activation.bin"], sizes["activation.bin"], 0);
    const rightBytes = readSlot(handles["activation.bin"], sizes["activation.bin"], 1);
    detectArenaVersion(handles["arena.bin"], sizes["arena.bin"]);
    detectCompleteMetadataVersion(
      handles["metadata-a.bin"],
      sizes["metadata-a.bin"],
      "metadata-a.bin.inspect.identity",
    );
    detectCompleteMetadataVersion(
      handles["metadata-b.bin"],
      sizes["metadata-b.bin"],
      "metadata-b.bin.inspect.identity",
    );
    const left = tryDecodeActivationSlot(leftBytes);
    const right = tryDecodeActivationSlot(rightBytes);
    if (sizes["activation.bin"] > ACTIVATION_SLOT_BYTES * 2) {
      throw new CorruptStoreError("manifest exceeds its fixed envelope");
    }
    if (left !== null || right !== null) {
      return recoverActivated(handles, sizes, leftBytes, rightBytes, configuredExtentSize);
    }
    const extentSize = classifyBootstrapResidue(handles, sizes, configuredExtentSize);
    return bootstrap(handles, extentSize);
  } catch (cause) {
    closeHandles(Object.values(handles));
    throw cause;
  }
}
