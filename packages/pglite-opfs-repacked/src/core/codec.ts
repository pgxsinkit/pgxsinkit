import { crc32, crc32WithZeroedRange } from "./checksum";
import { CorruptStoreError, ExtentSizeMismatchError, StoreLimitError, StoreRecreationRequiredError } from "./errors";
import {
  ARENA_HEADER_BYTES,
  FORMAT_VERSION,
  LIMITS_PROFILE_VERSION,
  MAX_COMPONENT_BYTES,
  MAX_EXTENTS_PER_INODE,
  MAX_FRAME_PAYLOAD_BYTES,
  MAX_INODES,
  MAX_METADATA_BASE_READER_BYTES,
  MAX_METADATA_BASE_WRITER_BYTES,
  MAX_TOTAL_EXTENTS,
  checkedU64,
  validateExtentSize,
} from "./limits";
import { validatePathComponent } from "./path";
import { IndexedExtentSet, estimateTxnPayloadBytes, validateState } from "./state-machine";
import type { DirectoryInode, ExtentRun, FileInode, Inode, MetadataFile, TxnRecord, VfsState } from "./state-machine";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

const ARENA_MAGIC = textEncoder.encode("PGXRPA01");
const METADATA_MAGIC = textEncoder.encode("PGXRPM01");
const FRAME_MAGIC = textEncoder.encode("PGXRPF01");
const ACTIVATION_MAGIC = textEncoder.encode("PGXRPK01");

export const ARENA_HEADER_CHECKSUM_OFFSET = 24;
export const METADATA_HEADER_BYTES = 80;
export const TXN_FRAME_HEADER_BYTES = 48;
export const ACTIVATION_SLOT_BYTES = 128;

export const METADATA_HEADER_CHECKSUM_OFFSET = 64;
export const FRAME_CHECKSUM_OFFSET = 40;
export const ACTIVATION_CHECKSUM_OFFSET = 52;

class BinaryWriter {
  readonly bytes: Uint8Array;
  readonly #view: DataView;
  #offset = 0;

  constructor(length: number, initialOffset = 0) {
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      !Number.isSafeInteger(initialOffset) ||
      initialOffset < 0 ||
      initialOffset > length
    ) {
      throw new StoreLimitError("binary output length is invalid");
    }
    this.bytes = new Uint8Array(length);
    this.#view = new DataView(this.bytes.buffer);
    this.#offset = initialOffset;
  }

  u8(value: number): void {
    this.#require(1);
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xff) {
      throw new StoreLimitError("unsigned 8-bit value is out of range");
    }
    this.#view.setUint8(this.#offset, value);
    this.#offset += 1;
  }

  u16(value: number): void {
    this.#require(2);
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff) {
      throw new StoreLimitError("unsigned 16-bit value is out of range");
    }
    this.#view.setUint16(this.#offset, value, true);
    this.#offset += 2;
  }

  u32(value: number): void {
    this.#require(4);
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
      throw new StoreLimitError("unsigned 32-bit value is out of range");
    }
    this.#view.setUint32(this.#offset, value, true);
    this.#offset += 4;
  }

  u64(value: bigint): void {
    this.#require(8);
    this.#view.setBigUint64(this.#offset, checkedU64(value, "encoded integer"), true);
    this.#offset += 8;
  }

  validatedU64(value: bigint): void {
    this.#require(8);
    this.#view.setBigUint64(this.#offset, value, true);
    this.#offset += 8;
  }

  raw(value: Uint8Array): void {
    this.#require(value.byteLength);
    this.bytes.set(value, this.#offset);
    this.#offset += value.byteLength;
  }

  string(value: string): void {
    validatePathComponent(value);
    this.validatedString(textEncoder.encode(value));
  }

  validatedString(encoded: Uint8Array): void {
    this.u16(encoded.byteLength);
    this.raw(encoded);
  }

  finish(): Uint8Array {
    if (this.#offset !== this.bytes.byteLength) {
      throw new StoreLimitError(
        `binary encoder wrote ${this.#offset} bytes into a ${this.bytes.byteLength}-byte output`,
      );
    }
    return this.bytes;
  }

  #require(length: number): void {
    if (this.#offset + length > this.bytes.byteLength) {
      throw new StoreLimitError("binary encoder exceeded its preflighted size");
    }
  }
}

class BinaryReader {
  readonly #bytes: Uint8Array;
  readonly #view: DataView;
  #offset = 0;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get remaining(): number {
    return this.#bytes.byteLength - this.#offset;
  }

  u8(): number {
    this.#require(1);
    const value = this.#view.getUint8(this.#offset);
    this.#offset += 1;
    return value;
  }

  u16(): number {
    this.#require(2);
    const value = this.#view.getUint16(this.#offset, true);
    this.#offset += 2;
    return value;
  }

  u32(): number {
    this.#require(4);
    const value = this.#view.getUint32(this.#offset, true);
    this.#offset += 4;
    return value;
  }

  u64(): bigint {
    this.#require(8);
    const value = this.#view.getBigUint64(this.#offset, true);
    this.#offset += 8;
    return value;
  }

  raw(length: number): Uint8Array {
    this.#require(length);
    const value = this.#bytes.subarray(this.#offset, this.#offset + length);
    this.#offset += length;
    return value;
  }

  string(): string {
    const length = this.u16();
    if (length === 0 || length > MAX_COMPONENT_BYTES) {
      throw new CorruptStoreError("encoded path component length is invalid");
    }
    let value: string;
    try {
      value = textDecoder.decode(this.raw(length));
    } catch (cause) {
      throw new CorruptStoreError("encoded path component is not valid UTF-8", { cause });
    }
    if (textEncoder.encode(value).byteLength !== length) {
      throw new CorruptStoreError("encoded path component is not canonical UTF-8");
    }
    try {
      validatePathComponent(value);
    } catch (cause) {
      throw new CorruptStoreError(`encoded path component is invalid: ${String(cause)}`, { cause });
    }
    return value;
  }

  end(): void {
    if (this.remaining !== 0) {
      throw new CorruptStoreError("binary value has trailing bytes");
    }
  }

  #require(length: number): void {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.remaining) {
      throw new CorruptStoreError("binary value is truncated");
    }
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

function requireMagic(bytes: Uint8Array, magic: Uint8Array, label: string): void {
  if (!bytesEqual(bytes.subarray(0, magic.byteLength), magic)) {
    throw new CorruptStoreError(`${label} magic is invalid`);
  }
}

function requireZero(bytes: Uint8Array, start: number, end: number, label: string): void {
  for (let offset = start; offset < end; offset += 1) {
    if (bytes[offset] !== 0) {
      throw new CorruptStoreError(`${label} padding is not canonical`);
    }
  }
}

function requireChecksum(bytes: Uint8Array, offset: number, label: string): void {
  const stored = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
  const calculated = crc32WithZeroedRange(bytes, offset, 4);
  if (stored !== calculated) {
    throw new CorruptStoreError(`${label} checksum is invalid`);
  }
}

function requireCurrentIdentity(version: number, profile: number): void {
  if (version !== FORMAT_VERSION || profile !== LIMITS_PROFILE_VERSION) {
    throw new StoreRecreationRequiredError(
      `store format ${version}/limits profile ${profile} is unsupported; delete the store and create it fresh`,
    );
  }
}

export interface ArenaHeader {
  extentSize: number;
  limitsProfileVersion: number;
  formatVersion: number;
}

export function encodeArenaHeader(options: { extentSize: number }): Uint8Array {
  const extentSize = validateExtentSize(options.extentSize);
  const bytes = new Uint8Array(ARENA_HEADER_BYTES);
  const view = new DataView(bytes.buffer);
  bytes.set(ARENA_MAGIC, 0);
  view.setUint32(8, FORMAT_VERSION, true);
  view.setUint32(12, LIMITS_PROFILE_VERSION, true);
  view.setUint32(16, extentSize, true);
  view.setUint32(ARENA_HEADER_CHECKSUM_OFFSET, crc32WithZeroedRange(bytes, ARENA_HEADER_CHECKSUM_OFFSET, 4), true);
  return bytes;
}

export function decodeArenaHeader(bytes: Uint8Array, configuredExtentSize?: number): ArenaHeader {
  if (configuredExtentSize !== undefined) {
    validateExtentSize(configuredExtentSize);
  }
  if (bytes.byteLength !== ARENA_HEADER_BYTES) {
    throw new CorruptStoreError("arena header has the wrong length");
  }
  requireMagic(bytes, ARENA_MAGIC, "arena header");
  requireZero(bytes, 20, 24, "arena header");
  requireZero(bytes, 28, bytes.byteLength, "arena header");
  requireChecksum(bytes, ARENA_HEADER_CHECKSUM_OFFSET, "arena header");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const formatVersion = view.getUint32(8, true);
  const limitsProfileVersion = view.getUint32(12, true);
  requireCurrentIdentity(formatVersion, limitsProfileVersion);
  const extentSize = view.getUint32(16, true);
  try {
    validateExtentSize(extentSize);
  } catch (cause) {
    throw new CorruptStoreError("arena header extent size is invalid", { cause });
  }
  if (configuredExtentSize !== undefined && configuredExtentSize !== extentSize) {
    throw new ExtentSizeMismatchError(configuredExtentSize, extentSize);
  }
  return { extentSize, limitsProfileVersion, formatVersion };
}

function metadataFileCode(file: MetadataFile): number {
  return file === "a" ? 0 : 1;
}

function decodeMetadataFile(value: number): MetadataFile {
  if (value === 0) return "a";
  if (value === 1) return "b";
  throw new CorruptStoreError("metadata file selector is invalid");
}

function compareBigint(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareUtf8Names(left: string, right: string): number {
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const leftPoint = left.codePointAt(leftIndex)!;
    const rightPoint = right.codePointAt(rightIndex)!;
    if (leftPoint !== rightPoint) return leftPoint - rightPoint;
    leftIndex += leftPoint > 0xffff ? 2 : 1;
    rightIndex += rightPoint > 0xffff ? 2 : 1;
  }
  return left.length - right.length;
}

function sortIfNeeded<Value>(values: Value[], compare: (left: Value, right: Value) => number): Value[] {
  for (let index = 1; index < values.length; index += 1) {
    if (compare(values[index - 1]!, values[index]!) > 0) {
      values.sort(compare);
      break;
    }
  }
  return values;
}

function writeInode(writer: BinaryWriter, inode: Inode): void {
  writer.validatedU64(inode.id);
  writer.u8(inode.kind === "directory" ? 0 : 1);
  writer.u32(inode.mode);
  writer.validatedU64(inode.atimeMs);
  writer.validatedU64(inode.mtimeMs);
  writer.validatedU64(inode.ctimeMs);
  if (inode.kind === "directory") {
    const children = sortIfNeeded([...inode.children], ([left], [right]) => compareUtf8Names(left, right));
    writer.u32(children.length);
    for (const [name, inodeId] of children) {
      writer.validatedString(textEncoder.encode(name));
      writer.validatedU64(inodeId);
    }
  } else {
    writer.validatedU64(inode.size);
    writer.u32(inode.extents.length);
    for (const extentId of inode.extents) writer.validatedU64(extentId);
  }
}

function encodeMetadataPayload(state: VfsState, length: number, prefixBytes = 0): Uint8Array {
  if (length > MAX_METADATA_BASE_WRITER_BYTES) {
    throw new StoreLimitError(`metadata base payload exceeds ${MAX_METADATA_BASE_WRITER_BYTES} bytes`);
  }
  const writer = new BinaryWriter(prefixBytes + length, prefixBytes);
  writer.validatedU64(state.allocator.totalExtents);
  writer.validatedU64(state.nextInodeId);
  writer.u32(state.inodes.size);
  const inodes = sortIfNeeded([...state.inodes.values()], (left, right) => compareBigint(left.id, right.id));
  for (const inode of inodes) {
    writeInode(writer, inode);
  }
  const available = sortIfNeeded([...state.allocator.available.values()], compareBigint);
  for (const extentId of available) writer.validatedU64(extentId);
  const quarantine = sortIfNeeded([...state.allocator.quarantine], ([left], [right]) => compareBigint(left, right));
  for (const [extentId, generation] of quarantine) {
    writer.validatedU64(extentId);
    writer.validatedU64(generation ?? 0n);
  }
  return writer.finish();
}

export interface DecodedMetadataBase {
  state: VfsState;
  payloadBytes: number;
  baseEnd: bigint;
  baseDigest: number;
}

export interface MetadataBaseHeader {
  formatVersion: number;
  limitsProfileVersion: number;
  generation: bigint;
  extentSize: number;
  metadataFileCode: number;
  rootInodeId: bigint;
  payloadLength: number;
  availableCount: number;
  quarantineCount: number;
  baseEnd: bigint;
}

export function inspectMetadataBaseHeader(header: Uint8Array): MetadataBaseHeader {
  if (header.byteLength !== METADATA_HEADER_BYTES) {
    throw new CorruptStoreError("metadata base header has the wrong length");
  }
  requireMagic(header, METADATA_MAGIC, "metadata base");
  requireZero(header, 29, 32, "metadata base");
  requireZero(header, 52, 56, "metadata base");
  requireZero(header, 68, 80, "metadata base");
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const payloadLength = view.getUint32(40, true);
  if (payloadLength > MAX_METADATA_BASE_READER_BYTES) {
    throw new CorruptStoreError("metadata base payload declaration exceeds the reader limit");
  }
  const baseEnd = view.getBigUint64(56, true);
  if (baseEnd !== BigInt(METADATA_HEADER_BYTES + payloadLength)) {
    throw new CorruptStoreError("metadata base end offset is inconsistent");
  }
  const availableCount = view.getUint32(44, true);
  const quarantineCount = view.getUint32(48, true);
  return {
    formatVersion: view.getUint32(8, true),
    limitsProfileVersion: view.getUint32(12, true),
    generation: view.getBigUint64(16, true),
    extentSize: view.getUint32(24, true),
    metadataFileCode: view.getUint8(28),
    rootInodeId: view.getBigUint64(32, true),
    payloadLength,
    availableCount,
    quarantineCount,
    baseEnd,
  };
}

export function encodeMetadataBase(state: VfsState): Uint8Array {
  validateState(state);
  return encodeValidatedMetadataBase(state);
}

/** @internal The caller must have validated this exact state immediately before encoding it. */
export function encodeValidatedMetadataBase(state: VfsState): Uint8Array {
  const baseEnd = METADATA_HEADER_BYTES + state.basePayloadBytes;
  const bytes = encodeMetadataPayload(state, state.basePayloadBytes, METADATA_HEADER_BYTES);
  const view = new DataView(bytes.buffer);
  bytes.set(METADATA_MAGIC, 0);
  view.setUint32(8, FORMAT_VERSION, true);
  view.setUint32(12, LIMITS_PROFILE_VERSION, true);
  view.setBigUint64(16, state.generation, true);
  view.setUint32(24, state.extentSize, true);
  view.setUint8(28, metadataFileCode(state.activeMetadataFile));
  view.setBigUint64(32, state.rootInodeId, true);
  view.setUint32(40, state.basePayloadBytes, true);
  view.setUint32(44, state.allocator.available.size, true);
  view.setUint32(48, state.allocator.quarantine.size, true);
  view.setBigUint64(56, BigInt(baseEnd), true);
  view.setUint32(
    METADATA_HEADER_CHECKSUM_OFFSET,
    crc32WithZeroedRange(bytes, METADATA_HEADER_CHECKSUM_OFFSET, 4),
    true,
  );
  return bytes;
}

function readBoundedCount(reader: BinaryReader, maximum: number, label: string): number {
  const count = reader.u32();
  if (count > maximum) {
    throw new CorruptStoreError(`${label} count exceeds ${maximum}`);
  }
  return count;
}

function readInode(reader: BinaryReader): Inode {
  const id = reader.u64();
  const kind = reader.u8();
  const mode = reader.u32();
  const atimeMs = reader.u64();
  const mtimeMs = reader.u64();
  const ctimeMs = reader.u64();
  if (kind === 0) {
    const childCount = readBoundedCount(reader, MAX_INODES, "directory child");
    const children = new Map<string, bigint>();
    let previousName: string | undefined;
    for (let index = 0; index < childCount; index += 1) {
      const name = reader.string();
      if (previousName !== undefined && compareUtf8Names(previousName, name) >= 0) {
        throw new CorruptStoreError("directory children are not in canonical order");
      }
      children.set(name, reader.u64());
      previousName = name;
    }
    const inode: DirectoryInode = { id, kind: "directory", mode, atimeMs, mtimeMs, ctimeMs, children };
    return inode;
  }
  if (kind === 1) {
    const size = reader.u64();
    const extentCount = readBoundedCount(reader, MAX_EXTENTS_PER_INODE, "file extent");
    const extents: bigint[] = [];
    for (let index = 0; index < extentCount; index += 1) extents.push(reader.u64());
    const inode: FileInode = { id, kind: "file", mode, atimeMs, mtimeMs, ctimeMs, size, extents };
    return inode;
  }
  throw new CorruptStoreError("inode type is invalid");
}

export function decodeMetadataBase(bytes: Uint8Array): DecodedMetadataBase {
  if (bytes.byteLength < METADATA_HEADER_BYTES) {
    throw new CorruptStoreError("metadata base header is truncated");
  }
  const inspected = inspectMetadataBaseHeader(bytes.subarray(0, METADATA_HEADER_BYTES));
  const { payloadLength, baseEnd } = inspected;
  if (bytes.byteLength !== Number(baseEnd)) {
    throw new CorruptStoreError("metadata base end offset is inconsistent");
  }
  requireChecksum(bytes, METADATA_HEADER_CHECKSUM_OFFSET, "metadata base");
  const payload = bytes.subarray(METADATA_HEADER_BYTES);
  requireCurrentIdentity(inspected.formatVersion, inspected.limitsProfileVersion);
  const { generation, extentSize, rootInodeId, availableCount, quarantineCount } = inspected;
  if (generation === 0n) throw new CorruptStoreError("metadata generation must be positive");
  try {
    validateExtentSize(extentSize);
  } catch (cause) {
    throw new CorruptStoreError("metadata base extent size is invalid", { cause });
  }
  const activeMetadataFile = decodeMetadataFile(inspected.metadataFileCode);
  if (availableCount > MAX_TOTAL_EXTENTS || quarantineCount > MAX_TOTAL_EXTENTS) {
    throw new CorruptStoreError("metadata allocator count exceeds the extent limit");
  }

  try {
    const reader = new BinaryReader(payload);
    const totalExtents = reader.u64();
    if (totalExtents > BigInt(MAX_TOTAL_EXTENTS)) {
      throw new CorruptStoreError("metadata total extent count exceeds the extent limit");
    }
    const nextInodeId = reader.u64();
    const inodeCount = readBoundedCount(reader, MAX_INODES, "inode");
    const inodes = new Map<bigint, Inode>();
    const ownedBy = new Map<bigint, bigint>();
    let previousInodeId: bigint | undefined;
    for (let index = 0; index < inodeCount; index += 1) {
      const inode = readInode(reader);
      if (previousInodeId !== undefined && inode.id <= previousInodeId) {
        throw new CorruptStoreError("inodes are not in canonical order");
      }
      inodes.set(inode.id, inode);
      previousInodeId = inode.id;
      if (inode.kind === "file") {
        for (const extentId of inode.extents) {
          if (ownedBy.has(extentId)) throw new CorruptStoreError("metadata contains duplicate extent ownership");
          ownedBy.set(extentId, inode.id);
        }
      }
    }
    const available = new IndexedExtentSet();
    let previousAvailable: bigint | undefined;
    for (let index = 0; index < availableCount; index += 1) {
      const extentId = reader.u64();
      if (previousAvailable !== undefined && extentId <= previousAvailable) {
        throw new CorruptStoreError("available extents are not in canonical order");
      }
      available.add(extentId);
      previousAvailable = extentId;
    }
    const quarantine = new Map<bigint, bigint | null>();
    let previousQuarantine: bigint | undefined;
    for (let index = 0; index < quarantineCount; index += 1) {
      const extentId = reader.u64();
      const encodedGeneration = reader.u64();
      if (previousQuarantine !== undefined && extentId <= previousQuarantine) {
        throw new CorruptStoreError("quarantine extents are not in canonical order");
      }
      quarantine.set(extentId, encodedGeneration === 0n ? null : encodedGeneration);
      previousQuarantine = extentId;
    }
    reader.end();
    const parentByInode = new Map<bigint, { parentId: bigint; name: string }>();
    for (const inode of inodes.values()) {
      if (inode.kind !== "directory") continue;
      for (const [name, childId] of inode.children) {
        if (parentByInode.has(childId)) {
          throw new CorruptStoreError("metadata inode has multiple directory owners");
        }
        parentByInode.set(childId, { parentId: inode.id, name });
      }
    }
    const retainedGenerations: Record<MetadataFile, bigint | null> = { a: null, b: null };
    retainedGenerations[activeMetadataFile] = generation;
    const state: VfsState = {
      generation,
      nextInodeId,
      rootInodeId,
      extentSize,
      activeMetadataFile,
      retainedGenerations,
      basePayloadBytes: payloadLength,
      inodes,
      parentByInode,
      allocator: { totalExtents, ownedBy, available, quarantine },
    };
    validateState(state);
    return { state, payloadBytes: payloadLength, baseEnd, baseDigest: crc32(bytes) };
  } catch (cause) {
    if (cause instanceof CorruptStoreError) throw cause;
    throw new CorruptStoreError(`metadata base is semantically invalid: ${String(cause)}`, { cause });
  }
}

function writeExtentRuns(writer: BinaryWriter, runs: readonly ExtentRun[]): void {
  writer.u32(runs.length);
  for (const run of runs) {
    writer.u64(run.start);
    writer.u32(run.count);
  }
}

function readExtentRuns(reader: BinaryReader): ExtentRun[] {
  const runCount = readBoundedCount(reader, MAX_EXTENTS_PER_INODE, "extent run");
  const runs: ExtentRun[] = [];
  let extentCount = 0;
  for (let index = 0; index < runCount; index += 1) {
    const start = reader.u64();
    const count = reader.u32();
    if (count === 0 || extentCount + count > MAX_EXTENTS_PER_INODE) {
      throw new CorruptStoreError("extent run count is invalid");
    }
    extentCount += count;
    runs.push({ start, count });
  }
  return runs;
}

const RECORD_CODES: Record<TxnRecord["kind"], number> = {
  createDirectories: 1,
  createFile: 2,
  removeFile: 3,
  changeMode: 4,
  changeTimes: 5,
  resizeFile: 6,
  removeDirectory: 7,
  rename: 8,
  reserveQuarantine: 9,
};

function encodeTxnRecord(record: TxnRecord): Uint8Array {
  const writer = new BinaryWriter(estimateTxnPayloadBytes(record));
  writer.u8(RECORD_CODES[record.kind]);
  switch (record.kind) {
    case "createDirectories":
      writer.u32(record.entries.length);
      for (const entry of record.entries) {
        writer.u64(entry.parentId);
        writer.string(entry.name);
        writer.u64(entry.inodeId);
        writer.u32(entry.mode);
        writer.u64(entry.atimeMs);
        writer.u64(entry.mtimeMs);
        writer.u64(entry.ctimeMs);
      }
      break;
    case "createFile":
      writer.u64(record.parentId);
      writer.string(record.name);
      writer.u64(record.inodeId);
      writer.u32(record.mode);
      writer.u64(record.atimeMs);
      writer.u64(record.mtimeMs);
      writer.u64(record.ctimeMs);
      writer.u64(record.size);
      writeExtentRuns(writer, record.extents);
      break;
    case "removeFile":
    case "removeDirectory":
      writer.u64(record.parentId);
      writer.string(record.name);
      writer.u64(record.parentMtimeMs);
      writer.u64(record.parentCtimeMs);
      break;
    case "changeMode":
      writer.u64(record.inodeId);
      writer.u32(record.mode);
      writer.u64(record.ctimeMs);
      break;
    case "changeTimes":
      writer.u64(record.inodeId);
      writer.u64(record.atimeMs);
      writer.u64(record.mtimeMs);
      writer.u64(record.ctimeMs);
      break;
    case "resizeFile":
      writer.u8(record.operation === "truncate" ? 0 : 1);
      writer.u64(record.inodeId);
      writer.u64(record.size);
      writeExtentRuns(writer, record.allocated);
      writer.u64(record.mtimeMs);
      writer.u64(record.ctimeMs);
      break;
    case "rename":
      writer.u64(record.sourceParentId);
      writer.string(record.sourceName);
      writer.u64(record.destinationParentId);
      writer.string(record.destinationName);
      writer.u64(record.timestampMs);
      break;
    case "reserveQuarantine":
      writeExtentRuns(writer, record.extents);
      break;
  }
  return writer.finish();
}

function decodeTxnRecord(bytes: Uint8Array): TxnRecord {
  const reader = new BinaryReader(bytes);
  const type = reader.u8();
  let record: TxnRecord;
  switch (type) {
    case 1: {
      const count = readBoundedCount(reader, MAX_INODES, "created directory");
      if (count === 0) throw new CorruptStoreError("directory transaction must not be empty");
      const entries = [];
      for (let index = 0; index < count; index += 1) {
        entries.push({
          parentId: reader.u64(),
          name: reader.string(),
          inodeId: reader.u64(),
          mode: reader.u32(),
          atimeMs: reader.u64(),
          mtimeMs: reader.u64(),
          ctimeMs: reader.u64(),
        });
      }
      record = { kind: "createDirectories", entries };
      break;
    }
    case 2:
      record = {
        kind: "createFile",
        parentId: reader.u64(),
        name: reader.string(),
        inodeId: reader.u64(),
        mode: reader.u32(),
        atimeMs: reader.u64(),
        mtimeMs: reader.u64(),
        ctimeMs: reader.u64(),
        size: reader.u64(),
        extents: readExtentRuns(reader),
      };
      break;
    case 3:
    case 7:
      record = {
        kind: type === 3 ? "removeFile" : "removeDirectory",
        parentId: reader.u64(),
        name: reader.string(),
        parentMtimeMs: reader.u64(),
        parentCtimeMs: reader.u64(),
      };
      break;
    case 4:
      record = { kind: "changeMode", inodeId: reader.u64(), mode: reader.u32(), ctimeMs: reader.u64() };
      break;
    case 5:
      record = {
        kind: "changeTimes",
        inodeId: reader.u64(),
        atimeMs: reader.u64(),
        mtimeMs: reader.u64(),
        ctimeMs: reader.u64(),
      };
      break;
    case 6: {
      const operation = reader.u8();
      if (operation !== 0 && operation !== 1) throw new CorruptStoreError("resize operation is invalid");
      record = {
        kind: "resizeFile",
        operation: operation === 0 ? "truncate" : "write",
        inodeId: reader.u64(),
        size: reader.u64(),
        allocated: readExtentRuns(reader),
        mtimeMs: reader.u64(),
        ctimeMs: reader.u64(),
      };
      break;
    }
    case 8:
      record = {
        kind: "rename",
        sourceParentId: reader.u64(),
        sourceName: reader.string(),
        destinationParentId: reader.u64(),
        destinationName: reader.string(),
        timestampMs: reader.u64(),
      };
      break;
    case 9:
      record = { kind: "reserveQuarantine", extents: readExtentRuns(reader) };
      break;
    default:
      throw new CorruptStoreError("transaction record type is invalid");
  }
  reader.end();
  return record;
}

export interface TxnFrame {
  generation: bigint;
  sequence: bigint;
  record: TxnRecord;
}

export interface TxnFrameHeader {
  generation: bigint;
  sequence: bigint;
  payloadLength: number;
  frameBytes: number;
}

export function txnFrameBytes(record: TxnRecord): number {
  const payloadBytes = estimateTxnPayloadBytes(record);
  if (payloadBytes > MAX_FRAME_PAYLOAD_BYTES) {
    throw new StoreLimitError(`transaction payload exceeds ${MAX_FRAME_PAYLOAD_BYTES} bytes`);
  }
  return TXN_FRAME_HEADER_BYTES + payloadBytes;
}

export function inspectTxnFrameHeader(header: Uint8Array): TxnFrameHeader {
  if (header.byteLength !== TXN_FRAME_HEADER_BYTES) {
    throw new CorruptStoreError("transaction frame header has the wrong length");
  }
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  requireMagic(header, FRAME_MAGIC, "transaction frame");
  requireZero(header, 36, 40, "transaction frame");
  requireZero(header, 44, 48, "transaction frame");
  const payloadLength = view.getUint32(32, true);
  if (payloadLength > MAX_FRAME_PAYLOAD_BYTES) {
    throw new CorruptStoreError("transaction payload declaration exceeds the frame limit");
  }
  if (view.getUint32(8, true) !== FORMAT_VERSION || view.getUint32(12, true) !== LIMITS_PROFILE_VERSION) {
    throw new CorruptStoreError("transaction frame format is invalid");
  }
  return {
    generation: view.getBigUint64(16, true),
    sequence: view.getBigUint64(24, true),
    payloadLength,
    frameBytes: TXN_FRAME_HEADER_BYTES + payloadLength,
  };
}

export function encodeTxnFrame(frame: TxnFrame): Uint8Array {
  const payload = encodeTxnRecord(frame.record);
  if (payload.byteLength > MAX_FRAME_PAYLOAD_BYTES) {
    throw new StoreLimitError(`transaction payload exceeds ${MAX_FRAME_PAYLOAD_BYTES} bytes`);
  }
  const bytes = new Uint8Array(TXN_FRAME_HEADER_BYTES + payload.byteLength);
  const view = new DataView(bytes.buffer);
  bytes.set(FRAME_MAGIC, 0);
  view.setUint32(8, FORMAT_VERSION, true);
  view.setUint32(12, LIMITS_PROFILE_VERSION, true);
  view.setBigUint64(16, checkedU64(frame.generation, "frame generation"), true);
  view.setBigUint64(24, checkedU64(frame.sequence, "frame sequence"), true);
  view.setUint32(32, payload.byteLength, true);
  bytes.set(payload, TXN_FRAME_HEADER_BYTES);
  view.setUint32(FRAME_CHECKSUM_OFFSET, crc32WithZeroedRange(bytes, FRAME_CHECKSUM_OFFSET, 4), true);
  return bytes;
}

export function decodeTxnFrame(bytes: Uint8Array): TxnFrame {
  if (bytes.byteLength < TXN_FRAME_HEADER_BYTES) throw new CorruptStoreError("transaction frame is truncated");
  const inspected = inspectTxnFrameHeader(bytes.subarray(0, TXN_FRAME_HEADER_BYTES));
  if (bytes.byteLength !== inspected.frameBytes) {
    throw new CorruptStoreError("transaction frame length is inconsistent");
  }
  requireChecksum(bytes, FRAME_CHECKSUM_OFFSET, "transaction frame");
  return {
    generation: inspected.generation,
    sequence: inspected.sequence,
    record: decodeTxnRecord(bytes.subarray(TXN_FRAME_HEADER_BYTES)),
  };
}

export interface ActivationRecord {
  sequence: bigint;
  metadataFile: MetadataFile;
  generation: bigint;
  baseEnd: bigint;
  baseDigest: number;
}

export function encodeActivationSlot(record: ActivationRecord): Uint8Array {
  if (record.sequence === 0n || record.generation === 0n || record.baseEnd < BigInt(METADATA_HEADER_BYTES)) {
    throw new StoreLimitError("activation identity values are outside the encodable domain");
  }
  const bytes = new Uint8Array(ACTIVATION_SLOT_BYTES);
  const view = new DataView(bytes.buffer);
  bytes.set(ACTIVATION_MAGIC, 0);
  view.setUint32(8, FORMAT_VERSION, true);
  view.setUint32(12, LIMITS_PROFILE_VERSION, true);
  view.setBigUint64(16, checkedU64(record.sequence, "activation sequence"), true);
  view.setUint8(24, metadataFileCode(record.metadataFile));
  view.setBigUint64(32, checkedU64(record.generation, "activation generation"), true);
  view.setBigUint64(40, checkedU64(record.baseEnd, "activation base end"), true);
  if (!Number.isSafeInteger(record.baseDigest) || record.baseDigest < 0 || record.baseDigest > 0xffff_ffff) {
    throw new StoreLimitError("activation base digest is outside the unsigned 32-bit range");
  }
  view.setUint32(48, record.baseDigest, true);
  view.setUint32(ACTIVATION_CHECKSUM_OFFSET, crc32WithZeroedRange(bytes, ACTIVATION_CHECKSUM_OFFSET, 4), true);
  return bytes;
}

export function decodeActivationSlot(bytes: Uint8Array): ActivationRecord {
  if (bytes.byteLength !== ACTIVATION_SLOT_BYTES) {
    throw new CorruptStoreError("activation slot has the wrong length");
  }
  requireMagic(bytes, ACTIVATION_MAGIC, "activation slot");
  requireZero(bytes, 25, 32, "activation slot");
  requireZero(bytes, 56, bytes.byteLength, "activation slot");
  requireChecksum(bytes, ACTIVATION_CHECKSUM_OFFSET, "activation slot");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  requireCurrentIdentity(view.getUint32(8, true), view.getUint32(12, true));
  const sequence = view.getBigUint64(16, true);
  const generation = view.getBigUint64(32, true);
  const baseEnd = view.getBigUint64(40, true);
  if (sequence === 0n || generation === 0n || baseEnd < BigInt(METADATA_HEADER_BYTES)) {
    throw new CorruptStoreError("activation slot contains invalid identity values");
  }
  return {
    sequence,
    metadataFile: decodeMetadataFile(view.getUint8(24)),
    generation,
    baseEnd,
    baseDigest: view.getUint32(48, true),
  };
}

export function tryDecodeActivationSlot(bytes: Uint8Array): ActivationRecord | null {
  try {
    return decodeActivationSlot(bytes);
  } catch (cause) {
    if (cause instanceof CorruptStoreError) return null;
    throw cause;
  }
}

export function selectActivation(leftBytes: Uint8Array, rightBytes: Uint8Array): ActivationRecord {
  return selectActivationPair(leftBytes, rightBytes).selected;
}

export interface ActivationPairSelection {
  selected: ActivationRecord;
  other: ActivationRecord | null;
}

export function selectActivationPair(leftBytes: Uint8Array, rightBytes: Uint8Array): ActivationPairSelection {
  const left = tryDecodeActivationSlot(leftBytes);
  const right = tryDecodeActivationSlot(rightBytes);
  if (left === null && right === null) {
    throw new CorruptStoreError("both activation slots are invalid");
  }
  if (left === null) return { selected: right!, other: null };
  if (right === null) return { selected: left, other: null };
  const older = left.sequence < right.sequence ? left : right;
  const newer = older === left ? right : left;
  if (newer.sequence !== older.sequence + 1n || newer.metadataFile === older.metadataFile) {
    throw new CorruptStoreError("activation slots do not form one exact alternating progression");
  }
  return { selected: newer, other: older };
}

export function metadataBaseDigest(bytes: Uint8Array): number {
  return crc32(bytes);
}
