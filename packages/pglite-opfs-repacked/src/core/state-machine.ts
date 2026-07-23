import { FsError, StoreLimitError } from "./errors";
import {
  MAX_EXTENTS_PER_INODE,
  MAX_INODES,
  MAX_FRAME_PAYLOAD_BYTES,
  MAX_METADATA_BASE_WRITER_BYTES,
  MAX_PATH_BYTES,
  MAX_PATH_DEPTH,
  MAX_TOTAL_EXTENTS,
  MAX_U64,
  checkedAdd,
  checkedU64,
  validateExtentSize,
} from "./limits";
import { encodedUtf8Length, parsePath, validatePathComponent } from "./path";

export type InodeId = bigint;
export type ExtentId = bigint;
export type MetadataFile = "a" | "b";

export function otherMetadataFile(file: MetadataFile): MetadataFile {
  return file === "a" ? "b" : "a";
}

interface BaseInode {
  id: InodeId;
  mode: number;
  atimeMs: bigint;
  mtimeMs: bigint;
  ctimeMs: bigint;
}

export interface DirectoryInode extends BaseInode {
  kind: "directory";
  children: Map<string, InodeId>;
}

export interface FileInode extends BaseInode {
  kind: "file";
  size: bigint;
  extents: ExtentId[];
}

export type Inode = DirectoryInode | FileInode;

export interface OrphanRecord {
  inodeId: InodeId;
  mode: number;
  atimeMs: bigint;
  mtimeMs: bigint;
  ctimeMs: bigint;
  size: bigint;
  extents: ExtentId[];
}

export function makeOrphanRecord(inode: FileInode): OrphanRecord {
  return {
    inodeId: inode.id,
    mode: inode.mode,
    atimeMs: inode.atimeMs,
    mtimeMs: inode.mtimeMs,
    ctimeMs: inode.ctimeMs,
    size: inode.size,
    extents: [...inode.extents],
  };
}

export class IndexedExtentSet {
  readonly #items: ExtentId[] = [];
  readonly #indexes = new Map<ExtentId, number>();

  get size(): number {
    return this.#items.length;
  }

  has(extentId: ExtentId): boolean {
    return this.#indexes.has(extentId);
  }

  add(extentId: ExtentId): void {
    if (this.#indexes.has(extentId)) {
      return;
    }
    this.#indexes.set(extentId, this.#items.length);
    this.#items.push(extentId);
  }

  delete(extentId: ExtentId): boolean {
    const index = this.#indexes.get(extentId);
    if (index === undefined) {
      return false;
    }
    const last = this.#items.pop();
    this.#indexes.delete(extentId);
    if (last !== undefined && index < this.#items.length) {
      this.#items[index] = last;
      this.#indexes.set(last, index);
    }
    return true;
  }

  values(): readonly ExtentId[] {
    return this.#items;
  }

  peekLast(count: number): ExtentId[] {
    if (!Number.isSafeInteger(count) || count < 0 || count > this.#items.length) {
      throw new StoreLimitError("invalid available-extent selection count");
    }
    return this.#items.slice(this.#items.length - count).reverse();
  }

  clone(): IndexedExtentSet {
    const copy = new IndexedExtentSet();
    for (const extentId of this.#items) {
      copy.add(extentId);
    }
    return copy;
  }
}

export interface AllocatorState {
  totalExtents: bigint;
  ownedBy: Map<ExtentId, InodeId>;
  available: IndexedExtentSet;
  quarantine: Map<ExtentId, bigint | null>;
}

export interface VfsState {
  generation: bigint;
  nextInodeId: bigint;
  rootInodeId: bigint;
  extentSize: number;
  activeMetadataFile: MetadataFile;
  retainedGenerations: Record<MetadataFile, bigint | null>;
  basePayloadBytes: number;
  inodes: Map<InodeId, Inode>;
  parentByInode: Map<InodeId, { parentId: InodeId; name: string }>;
  allocator: AllocatorState;
}

export interface CreateDirectoryChoice {
  parentId: InodeId;
  name: string;
  inodeId: InodeId;
  mode: number;
  atimeMs: bigint;
  mtimeMs: bigint;
  ctimeMs: bigint;
}

export interface ExtentRun {
  start: ExtentId;
  count: number;
}

export type TxnRecord =
  | {
      kind: "createDirectories";
      entries: readonly CreateDirectoryChoice[];
    }
  | {
      kind: "createFile";
      parentId: InodeId;
      name: string;
      inodeId: InodeId;
      mode: number;
      atimeMs: bigint;
      mtimeMs: bigint;
      ctimeMs: bigint;
      size: bigint;
      extents: readonly ExtentRun[];
    }
  | {
      kind: "removeFile";
      parentId: InodeId;
      name: string;
      parentMtimeMs: bigint;
      parentCtimeMs: bigint;
    }
  | {
      kind: "changeMode";
      inodeId: InodeId;
      mode: number;
      ctimeMs: bigint;
    }
  | {
      kind: "changeTimes";
      inodeId: InodeId;
      atimeMs: bigint;
      mtimeMs: bigint;
      ctimeMs: bigint;
    }
  | {
      kind: "resizeFile";
      operation: "truncate" | "write";
      inodeId: InodeId;
      size: bigint;
      allocated: readonly ExtentRun[];
      mtimeMs: bigint;
      ctimeMs: bigint;
    }
  | {
      kind: "removeDirectory";
      parentId: InodeId;
      name: string;
      parentMtimeMs: bigint;
      parentCtimeMs: bigint;
    }
  | {
      kind: "rename";
      sourceParentId: InodeId;
      sourceName: string;
      destinationParentId: InodeId;
      destinationName: string;
      timestampMs: bigint;
    }
  | {
      kind: "reserveQuarantine";
      extents: readonly ExtentRun[];
    };

export interface TxnPlan<RecordType extends TxnRecord = TxnRecord> {
  record: RecordType;
}

export interface PreflightLimits {
  maxFramePayloadBytes: number;
  maxBasePayloadBytes: number;
}

const BASE_STATE_FIXED_BYTES = 20;
const DIRECTORY_INODE_FIXED_BYTES = 41;
const FILE_INODE_FIXED_BYTES = 49;
const CHILD_FIXED_BYTES = 10;

function childBaseBytes(name: string): number {
  return CHILD_FIXED_BYTES + encodedUtf8Length(name);
}

function inodeBaseBytes(inode: Inode): number {
  if (inode.kind === "file") {
    return FILE_INODE_FIXED_BYTES + inode.extents.length * 8;
  }
  let bytes = DIRECTORY_INODE_FIXED_BYTES;
  for (const name of inode.children.keys()) {
    bytes += childBaseBytes(name);
  }
  return bytes;
}

export function estimateMetadataBasePayloadBytes(state: VfsState): number {
  let bytes = BASE_STATE_FIXED_BYTES;
  for (const inode of state.inodes.values()) {
    bytes += inodeBaseBytes(inode);
  }
  bytes += state.allocator.available.size * 8;
  bytes += state.allocator.quarantine.size * 16;
  return bytes;
}

function extentRunsPayloadBytes(runs: readonly ExtentRun[]): number {
  return 4 + runs.length * 12;
}

export function estimateTxnPayloadBytes(record: TxnRecord): number {
  switch (record.kind) {
    case "createDirectories":
      return 5 + record.entries.reduce((bytes, entry) => bytes + 8 + 2 + encodedUtf8Length(entry.name) + 8 + 4 + 24, 0);
    case "createFile":
      return 1 + 8 + 2 + encodedUtf8Length(record.name) + 8 + 4 + 24 + 8 + extentRunsPayloadBytes(record.extents);
    case "removeFile":
    case "removeDirectory":
      return 1 + 8 + 2 + encodedUtf8Length(record.name) + 16;
    case "changeMode":
      return 1 + 8 + 4 + 8;
    case "changeTimes":
      return 1 + 8 + 24;
    case "resizeFile":
      return 1 + 1 + 8 + 8 + extentRunsPayloadBytes(record.allocated) + 16;
    case "rename":
      return 1 + 8 + 2 + encodedUtf8Length(record.sourceName) + 8 + 2 + encodedUtf8Length(record.destinationName) + 8;
    case "reserveQuarantine":
      return 1 + extentRunsPayloadBytes(record.extents);
  }
}

function selectedExtentsAlreadyAvailable(state: VfsState, runs: readonly ExtentRun[]): number {
  let count = 0;
  for (const extentId of expandExtentRuns(runs, MAX_EXTENTS_PER_INODE)) {
    if (extentId < state.allocator.totalExtents) {
      count += 1;
    }
  }
  return count;
}

function projectedBaseDelta(state: VfsState, record: TxnRecord): number {
  switch (record.kind) {
    case "createDirectories":
      return record.entries.reduce(
        (bytes, entry) => bytes + DIRECTORY_INODE_FIXED_BYTES + childBaseBytes(entry.name),
        0,
      );
    case "createFile": {
      const extentCount = expandExtentRuns(record.extents, MAX_EXTENTS_PER_INODE).length;
      const reused = selectedExtentsAlreadyAvailable(state, record.extents);
      return FILE_INODE_FIXED_BYTES + extentCount * 8 + childBaseBytes(record.name) - reused * 8;
    }
    case "removeFile": {
      const parent = directoryById(state, record.parentId);
      const inodeId = parent.children.get(record.name);
      const inode = inodeId === undefined ? undefined : state.inodes.get(inodeId);
      if (inode?.kind !== "file") {
        throw new FsError("ENOENT", "file does not exist");
      }
      return -inodeBaseBytes(inode) - childBaseBytes(record.name) + inode.extents.length * 16;
    }
    case "changeMode":
    case "changeTimes":
      return 0;
    case "resizeFile": {
      const inode = fileById(state, record.inodeId);
      const required = extentCountForSize(record.size, state.extentSize);
      const allocatedCount = Math.max(0, required - inode.extents.length);
      const releasedCount = Math.max(0, inode.extents.length - required);
      const reused = selectedExtentsAlreadyAvailable(state, record.allocated);
      return (allocatedCount - releasedCount) * 8 - reused * 8 + releasedCount * 16;
    }
    case "removeDirectory": {
      const parent = directoryById(state, record.parentId);
      const inodeId = parent.children.get(record.name);
      const inode = inodeId === undefined ? undefined : state.inodes.get(inodeId);
      if (inode?.kind !== "directory") {
        throw new FsError("ENOENT", "directory does not exist");
      }
      return -inodeBaseBytes(inode) - childBaseBytes(record.name);
    }
    case "rename": {
      const sourceParent = directoryById(state, record.sourceParentId);
      const destinationParent = directoryById(state, record.destinationParentId);
      const destinationId = destinationParent.children.get(record.destinationName);
      const destination = destinationId === undefined ? undefined : state.inodes.get(destinationId);
      let delta = -childBaseBytes(record.sourceName);
      if (destination === undefined) {
        delta += childBaseBytes(record.destinationName);
      } else {
        delta -= inodeBaseBytes(destination);
        if (destination.kind === "file") {
          delta += destination.extents.length * 16;
        }
      }
      const sourceId = sourceParent.children.get(record.sourceName);
      if (sourceId === undefined) {
        throw new FsError("ENOENT", "rename source does not exist");
      }
      return delta;
    }
    case "reserveQuarantine": {
      const count = expandExtentRuns(record.extents, MAX_EXTENTS_PER_INODE).length;
      const reused = selectedExtentsAlreadyAvailable(state, record.extents);
      return count * 16 - reused * 8;
    }
  }
}

export function preflightTxn(
  state: VfsState,
  record: TxnRecord,
  limits: PreflightLimits = {
    maxFramePayloadBytes: MAX_FRAME_PAYLOAD_BYTES,
    maxBasePayloadBytes: MAX_METADATA_BASE_WRITER_BYTES,
  },
): number {
  const payloadBytes = estimateTxnPayloadBytes(record);
  if (payloadBytes > limits.maxFramePayloadBytes) {
    throw new StoreLimitError(`transaction payload would exceed ${limits.maxFramePayloadBytes} bytes`);
  }
  const projected = state.basePayloadBytes + projectedBaseDelta(state, record);
  if (!Number.isSafeInteger(projected) || projected < 0 || projected > limits.maxBasePayloadBytes) {
    throw new StoreLimitError(`metadata base would exceed ${limits.maxBasePayloadBytes} bytes`);
  }
  return projected;
}

const PREPARED_TXN_PROJECTION = Symbol("prepared transaction projection");

export interface PreparedTxnProjection {
  readonly projectedBasePayloadBytes: number;
  readonly state: VfsState;
  readonly record: TxnRecord;
  readonly [PREPARED_TXN_PROJECTION]: true;
}

/** @internal Bind one projected size to the exact live state and record it preflighted. */
export function prepareTxnProjection(state: VfsState, record: TxnRecord): PreparedTxnProjection {
  return {
    projectedBasePayloadBytes: preflightTxn(state, record),
    state,
    record,
    [PREPARED_TXN_PROJECTION]: true,
  };
}

function checkedPlan<RecordType extends TxnRecord>(state: VfsState, record: RecordType): TxnPlan<RecordType> {
  preflightTxn(state, record);
  return { record };
}

export function createInitialState(extentSize: number): VfsState {
  validateExtentSize(extentSize);
  const root: DirectoryInode = {
    id: 1n,
    kind: "directory",
    mode: 0o40777,
    atimeMs: 0n,
    mtimeMs: 0n,
    ctimeMs: 0n,
    children: new Map(),
  };
  return {
    generation: 1n,
    nextInodeId: 2n,
    rootInodeId: root.id,
    extentSize,
    activeMetadataFile: "a",
    retainedGenerations: { a: 1n, b: null },
    basePayloadBytes: BASE_STATE_FIXED_BYTES + DIRECTORY_INODE_FIXED_BYTES,
    inodes: new Map([[root.id, root]]),
    parentByInode: new Map(),
    allocator: {
      totalExtents: 0n,
      ownedBy: new Map(),
      available: new IndexedExtentSet(),
      quarantine: new Map(),
    },
  };
}

function validateMode(mode: number): number {
  if (!Number.isSafeInteger(mode) || mode < 0 || mode > 0xffff_ffff) {
    throw new FsError("EINVAL", "mode must be an unsigned 32-bit integer");
  }
  return mode;
}

function validateTimestamp(timestamp: bigint): bigint {
  return checkedU64(timestamp, "timestamp");
}

function advanceNextInodeId(inodeId: InodeId): InodeId {
  if (inodeId === MAX_U64) {
    throw new StoreLimitError("next inode ID is exhausted; the store must be recreated");
  }
  return checkedAdd(inodeId, 1n, "next inode ID");
}

function directoryById(state: VfsState, inodeId: InodeId): DirectoryInode {
  const inode = state.inodes.get(inodeId);
  if (inode === undefined) {
    throw new FsError("ENOENT", "directory does not exist");
  }
  if (inode.kind !== "directory") {
    throw new FsError("ENOTDIR", "path component is not a directory");
  }
  return inode;
}

function inodeById(state: VfsState, inodeId: InodeId): Inode {
  const inode = state.inodes.get(inodeId);
  if (inode === undefined) {
    throw new FsError("ENOENT", "inode does not exist");
  }
  return inode;
}

function fileById(state: VfsState, inodeId: InodeId): FileInode {
  const inode = inodeById(state, inodeId);
  if (inode.kind !== "file") {
    throw new FsError("EISDIR", "inode is a directory");
  }
  return inode;
}

function parentAndName(state: VfsState, path: string): { parent: DirectoryInode; name: string } {
  const components = parsePath(path);
  const name = components.pop();
  if (name === undefined) {
    throw new FsError("EINVAL", "operation is not permitted on root", { path });
  }
  let parent = directoryById(state, state.rootInodeId);
  for (const component of components) {
    const childId = parent.children.get(component);
    if (childId === undefined) {
      throw new FsError("ENOENT", "parent directory does not exist", { path });
    }
    parent = directoryById(state, childId);
  }
  return { parent, name };
}

function extentCountForSize(size: bigint, extentSize: number): number {
  checkedU64(size, "file size");
  if (size === 0n) {
    return 0;
  }
  const count = (size + BigInt(extentSize) - 1n) / BigInt(extentSize);
  if (count > BigInt(MAX_EXTENTS_PER_INODE)) {
    throw new StoreLimitError(`file would exceed ${MAX_EXTENTS_PER_INODE} extents`);
  }
  return Number(count);
}

export function toExtentRuns(extents: readonly ExtentId[]): ExtentRun[] {
  const runs: ExtentRun[] = [];
  for (const extentId of extents) {
    checkedU64(extentId, "extent ID");
    const last = runs.at(-1);
    if (last !== undefined && last.start + BigInt(last.count) === extentId && last.count < 0xffff_ffff) {
      last.count += 1;
    } else {
      runs.push({ start: extentId, count: 1 });
    }
  }
  return runs;
}

export function expandExtentRuns(runs: readonly ExtentRun[], maximum: number): ExtentId[] {
  const extents: ExtentId[] = [];
  for (const run of runs) {
    checkedU64(run.start, "extent run start");
    if (!Number.isSafeInteger(run.count) || run.count <= 0) {
      throw new FsError("EINVAL", "extent run count must be a positive safe integer");
    }
    if (extents.length + run.count > maximum) {
      throw new StoreLimitError(`extent list exceeds ${maximum} entries`);
    }
    for (let offset = 0; offset < run.count; offset += 1) {
      extents.push(checkedAdd(run.start, BigInt(offset), "extent ID"));
    }
  }
  return extents;
}

function chooseExtents(state: VfsState, count: number): ExtentId[] {
  if (count > MAX_EXTENTS_PER_INODE) {
    throw new StoreLimitError(`allocation exceeds ${MAX_EXTENTS_PER_INODE} extents`);
  }
  const availableCount = Math.min(count, state.allocator.available.size);
  const chosen = state.allocator.available.peekLast(availableCount);
  const freshCount = count - availableCount;
  if (state.allocator.totalExtents + BigInt(freshCount) > BigInt(MAX_TOTAL_EXTENTS)) {
    throw new StoreLimitError(`total extent count would exceed ${MAX_TOTAL_EXTENTS}`);
  }
  for (let offset = 0; offset < freshCount; offset += 1) {
    chosen.push(state.allocator.totalExtents + BigInt(offset));
  }
  return chosen;
}

export function getInodeAtPath(state: VfsState, path: string): Inode {
  const components = parsePath(path);
  let inode = state.inodes.get(state.rootInodeId);
  if (inode === undefined) {
    throw new StoreLimitError("root inode is missing");
  }
  for (const component of components) {
    if (inode.kind !== "directory") {
      throw new FsError("ENOTDIR", "path component is not a directory", { path });
    }
    const childId = inode.children.get(component);
    if (childId === undefined) {
      throw new FsError("ENOENT", "path does not exist", { path });
    }
    const child = state.inodes.get(childId);
    if (child === undefined) {
      throw new StoreLimitError("directory entry references a missing inode");
    }
    inode = child;
  }
  return inode;
}

export function planMkdir(
  state: VfsState,
  path: string,
  options: { recursive?: boolean; mode?: number; nowMs: bigint },
): TxnPlan<Extract<TxnRecord, { kind: "createDirectories" }>> {
  const components = parsePath(path);
  if (components.length === 0) {
    throw new FsError("EEXIST", "root directory already exists", { operation: "mkdir", path });
  }
  const mode = validateMode(options.mode ?? 0o40777);
  const nowMs = validateTimestamp(options.nowMs);
  const entries: CreateDirectoryChoice[] = [];
  let parent = directoryById(state, state.rootInodeId);
  let nextInodeId = state.nextInodeId;

  for (let index = 0; index < components.length; index += 1) {
    const name = components[index]!;
    const existingId = parent.children.get(name);
    if (existingId !== undefined) {
      const existing = state.inodes.get(existingId);
      if (existing?.kind !== "directory") {
        throw new FsError("ENOTDIR", "path component is not a directory", { operation: "mkdir", path });
      }
      if (index === components.length - 1) {
        throw new FsError("EEXIST", "path already exists", { operation: "mkdir", path });
      }
      parent = existing;
      continue;
    }
    if (!options.recursive && index !== components.length - 1) {
      throw new FsError("ENOENT", "parent directory does not exist", { operation: "mkdir", path });
    }
    if (state.inodes.size + entries.length >= MAX_INODES) {
      throw new StoreLimitError(`inode count would exceed ${MAX_INODES}`);
    }
    checkedU64(nextInodeId, "next inode ID");
    const followingInodeId = advanceNextInodeId(nextInodeId);
    const entry: CreateDirectoryChoice = {
      parentId: parent.id,
      name,
      inodeId: nextInodeId,
      mode,
      atimeMs: nowMs,
      mtimeMs: nowMs,
      ctimeMs: nowMs,
    };
    entries.push(entry);
    parent = { ...entry, kind: "directory", id: entry.inodeId, children: new Map() };
    nextInodeId = followingInodeId;
  }

  if (entries.length === 0) {
    throw new FsError("EEXIST", "path already exists", { operation: "mkdir", path });
  }
  return checkedPlan(state, { kind: "createDirectories", entries });
}

export function planCreateFile(
  state: VfsState,
  path: string,
  options: { mode?: number; nowMs: bigint; size?: bigint },
): TxnPlan<Extract<TxnRecord, { kind: "createFile" }>> {
  const { parent, name } = parentAndName(state, path);
  if (parent.children.has(name)) {
    throw new FsError("EEXIST", "path already exists", { operation: "writeFile", path });
  }
  if (state.inodes.size >= MAX_INODES) {
    throw new StoreLimitError(`inode count would exceed ${MAX_INODES}`);
  }
  const inodeId = checkedU64(state.nextInodeId, "next inode ID");
  advanceNextInodeId(inodeId);
  const mode = validateMode(options.mode ?? 0o100666);
  const nowMs = validateTimestamp(options.nowMs);
  const size = checkedU64(options.size ?? 0n, "file size");
  const extents = toExtentRuns(chooseExtents(state, extentCountForSize(size, state.extentSize)));
  return checkedPlan(state, {
    kind: "createFile",
    parentId: parent.id,
    name,
    inodeId,
    mode,
    atimeMs: nowMs,
    mtimeMs: nowMs,
    ctimeMs: nowMs,
    size,
    extents,
  });
}

export function planUnlink(
  state: VfsState,
  path: string,
  nowMs: bigint,
): TxnPlan<Extract<TxnRecord, { kind: "removeFile" }>> {
  const { parent, name } = parentAndName(state, path);
  const inodeId = parent.children.get(name);
  const inode = inodeId === undefined ? undefined : state.inodes.get(inodeId);
  if (inode === undefined) {
    throw new FsError("ENOENT", "path does not exist", { operation: "unlink", path });
  }
  if (inode.kind !== "file") {
    throw new FsError("EISDIR", "path is a directory", { operation: "unlink", path });
  }
  const timestamp = validateTimestamp(nowMs);
  return checkedPlan(state, {
    kind: "removeFile",
    parentId: parent.id,
    name,
    parentMtimeMs: timestamp,
    parentCtimeMs: timestamp,
  });
}

export function planChmod(
  state: VfsState,
  path: string,
  mode: number,
  nowMs: bigint,
): TxnPlan<Extract<TxnRecord, { kind: "changeMode" }>> {
  const inode = getInodeAtPath(state, path);
  return checkedPlan(state, {
    kind: "changeMode",
    inodeId: inode.id,
    mode: validateMode(mode),
    ctimeMs: validateTimestamp(nowMs),
  });
}

export function planUtimes(
  state: VfsState,
  path: string,
  atimeMs: bigint,
  mtimeMs: bigint,
  ctimeMs: bigint,
): TxnPlan<Extract<TxnRecord, { kind: "changeTimes" }>> {
  const inode = getInodeAtPath(state, path);
  return checkedPlan(state, {
    kind: "changeTimes",
    inodeId: inode.id,
    atimeMs: validateTimestamp(atimeMs),
    mtimeMs: validateTimestamp(mtimeMs),
    ctimeMs: validateTimestamp(ctimeMs),
  });
}

export function planResizeFile(
  state: VfsState,
  path: string,
  size: bigint,
  nowMs: bigint,
  operation: "truncate" | "write",
): TxnPlan<Extract<TxnRecord, { kind: "resizeFile" }>> {
  const inode = getInodeAtPath(state, path);
  if (inode.kind !== "file") {
    throw new FsError("EISDIR", "path is a directory", { operation, path });
  }
  return planResizeFileForInode(state, inode, size, nowMs, operation);
}

/** @internal Inode-first planner for descriptor operations that already resolved the file. */
export function planResizeFileForInode(
  state: VfsState,
  inode: FileInode,
  size: bigint,
  nowMs: bigint,
  operation: "truncate" | "write",
): TxnPlan<Extract<TxnRecord, { kind: "resizeFile" }>> {
  if (state.inodes.get(inode.id) !== inode) {
    throw new StoreLimitError("resize planner requires the current file inode");
  }
  const checkedSize = checkedU64(size, "file size");
  const required = extentCountForSize(checkedSize, state.extentSize);
  const additional = Math.max(0, required - inode.extents.length);
  const timestamp = validateTimestamp(nowMs);
  return checkedPlan(state, {
    kind: "resizeFile",
    operation,
    inodeId: inode.id,
    size: checkedSize,
    allocated: toExtentRuns(chooseExtents(state, additional)),
    mtimeMs: timestamp,
    ctimeMs: timestamp,
  });
}

export function planRmdir(
  state: VfsState,
  path: string,
  nowMs: bigint,
): TxnPlan<Extract<TxnRecord, { kind: "removeDirectory" }>> {
  const { parent, name } = parentAndName(state, path);
  const inodeId = parent.children.get(name);
  const inode = inodeId === undefined ? undefined : state.inodes.get(inodeId);
  if (inode === undefined) {
    throw new FsError("ENOENT", "directory does not exist", { operation: "rmdir", path });
  }
  if (inode.kind !== "directory") {
    throw new FsError("ENOTDIR", "path is not a directory", { operation: "rmdir", path });
  }
  if (inode.children.size !== 0) {
    throw new FsError("ENOTEMPTY", "directory is not empty", { operation: "rmdir", path });
  }
  const timestamp = validateTimestamp(nowMs);
  return checkedPlan(state, {
    kind: "removeDirectory",
    parentId: parent.id,
    name,
    parentMtimeMs: timestamp,
    parentCtimeMs: timestamp,
  });
}

function directoryContains(state: VfsState, directory: DirectoryInode, candidateId: InodeId): boolean {
  if (directory.id === candidateId) {
    return true;
  }
  for (const childId of directory.children.values()) {
    const child = inodeById(state, childId);
    if (child.kind === "directory" && directoryContains(state, child, candidateId)) {
      return true;
    }
  }
  return false;
}

interface PathMetrics {
  depth: number;
  bytes: number;
}

function childPathMetrics(parent: PathMetrics, name: string): PathMetrics {
  return {
    depth: parent.depth + 1,
    bytes: parent.bytes + (parent.depth === 0 ? 0 : 1) + encodedUtf8Length(name),
  };
}

function findPathMetrics(state: VfsState, targetId: InodeId): PathMetrics {
  let currentId = targetId;
  let depth = 0;
  let componentBytes = 0;
  const visited = new Set<InodeId>();
  while (currentId !== state.rootInodeId) {
    if (visited.has(currentId)) {
      throw new StoreLimitError("inode parent index contains a cycle");
    }
    visited.add(currentId);
    const entry = state.parentByInode.get(currentId);
    if (entry === undefined) {
      throw new StoreLimitError("inode parent index does not reach root");
    }
    depth += 1;
    componentBytes += encodedUtf8Length(entry.name);
    currentId = entry.parentId;
  }
  return { depth, bytes: 1 + componentBytes + Math.max(0, depth - 1) };
}

function validateRenamedSubtreeBounds(
  state: VfsState,
  source: Inode,
  destinationParent: DirectoryInode,
  destinationName: string,
): void {
  const visit = (inode: Inode, metrics: PathMetrics): void => {
    if (metrics.depth > MAX_PATH_DEPTH) {
      throw new FsError("EINVAL", `rename would exceed ${MAX_PATH_DEPTH} path components`);
    }
    if (metrics.bytes > MAX_PATH_BYTES) {
      throw new FsError("EINVAL", `rename would exceed ${MAX_PATH_BYTES} UTF-8 path bytes`);
    }
    if (inode.kind === "directory") {
      for (const [name, childId] of inode.children) {
        visit(inodeById(state, childId), childPathMetrics(metrics, name));
      }
    }
  };
  const destinationMetrics = findPathMetrics(state, destinationParent.id);
  visit(source, childPathMetrics(destinationMetrics, destinationName));
}

function validateRenameTypes(source: Inode, destination: Inode | undefined): void {
  if (destination === undefined) {
    return;
  }
  if (source.kind === "file" && destination.kind === "directory") {
    throw new FsError("EISDIR", "cannot replace a directory with a file");
  }
  if (source.kind === "directory" && destination.kind === "file") {
    throw new FsError("ENOTDIR", "cannot replace a file with a directory");
  }
  if (destination.kind === "directory" && destination.children.size !== 0) {
    throw new FsError("ENOTEMPTY", "destination directory is not empty");
  }
}

export function planRename(
  state: VfsState,
  oldPath: string,
  newPath: string,
  nowMs: bigint,
): TxnPlan<Extract<TxnRecord, { kind: "rename" }>> {
  if (oldPath === newPath) {
    throw new FsError("EINVAL", "source and destination are identical", { operation: "rename", path: oldPath });
  }
  const sourceLocation = parentAndName(state, oldPath);
  const destinationLocation = parentAndName(state, newPath);
  const sourceId = sourceLocation.parent.children.get(sourceLocation.name);
  if (sourceId === undefined) {
    throw new FsError("ENOENT", "rename source does not exist", { operation: "rename", path: oldPath });
  }
  const source = inodeById(state, sourceId);
  const destinationId = destinationLocation.parent.children.get(destinationLocation.name);
  const destination = destinationId === undefined ? undefined : inodeById(state, destinationId);
  validateRenameTypes(source, destination);
  if (source.kind === "directory" && directoryContains(state, source, destinationLocation.parent.id)) {
    throw new FsError("EINVAL", "cannot move a directory into itself", { operation: "rename", path: newPath });
  }
  validateRenamedSubtreeBounds(state, source, destinationLocation.parent, destinationLocation.name);
  return checkedPlan(state, {
    kind: "rename",
    sourceParentId: sourceLocation.parent.id,
    sourceName: sourceLocation.name,
    destinationParentId: destinationLocation.parent.id,
    destinationName: destinationLocation.name,
    timestampMs: validateTimestamp(nowMs),
  });
}

export function planReserveQuarantine(
  state: VfsState,
  count: number,
): TxnPlan<Extract<TxnRecord, { kind: "reserveQuarantine" }>> {
  if (!Number.isSafeInteger(count) || count <= 0 || count > MAX_EXTENTS_PER_INODE) {
    throw new StoreLimitError(`orphan reservation must contain 1 to ${MAX_EXTENTS_PER_INODE} extents`);
  }
  return checkedPlan(state, {
    kind: "reserveQuarantine",
    extents: toExtentRuns(chooseExtents(state, count)),
  });
}

function validateCreateDirectories(state: VfsState, entries: readonly CreateDirectoryChoice[]): void {
  if (entries.length === 0) {
    throw new FsError("EINVAL", "createDirectories record is empty");
  }
  const staged = new Map<InodeId, DirectoryInode>();
  const stagedDirectory = (inodeId: InodeId): DirectoryInode => {
    const alreadyStaged = staged.get(inodeId);
    if (alreadyStaged !== undefined) {
      return alreadyStaged;
    }
    const existing = directoryById(state, inodeId);
    const copy = { ...existing, children: new Map(existing.children) };
    staged.set(inodeId, copy);
    return copy;
  };
  let expectedInodeId = state.nextInodeId;
  for (const entry of entries) {
    validatePathComponent(entry.name);
    validateMode(entry.mode);
    validateTimestamp(entry.atimeMs);
    validateTimestamp(entry.mtimeMs);
    validateTimestamp(entry.ctimeMs);
    if (entry.inodeId !== expectedInodeId || entry.inodeId > MAX_U64) {
      throw new FsError("EINVAL", "createDirectories record has a non-canonical inode sequence");
    }
    const parent = stagedDirectory(entry.parentId);
    if (parent.children.has(entry.name)) {
      throw new FsError("EEXIST", "directory entry already exists");
    }
    const created: DirectoryInode = {
      id: entry.inodeId,
      kind: "directory",
      mode: entry.mode,
      atimeMs: entry.atimeMs,
      mtimeMs: entry.mtimeMs,
      ctimeMs: entry.ctimeMs,
      children: new Map(),
    };
    parent.children.set(entry.name, entry.inodeId);
    staged.set(entry.inodeId, created);
    expectedInodeId = advanceNextInodeId(expectedInodeId);
  }
  if (state.inodes.size + entries.length > MAX_INODES) {
    throw new StoreLimitError(`inode count would exceed ${MAX_INODES}`);
  }
}

function validateExtentAssignment(state: VfsState, runs: readonly ExtentRun[], expectedCount: number): ExtentId[] {
  const extents = expandExtentRuns(runs, MAX_EXTENTS_PER_INODE);
  if (extents.length !== expectedCount) {
    throw new FsError("EINVAL", "extent choices do not cover the file size exactly");
  }
  const unique = new Set(extents);
  if (unique.size !== extents.length) {
    throw new FsError("EINVAL", "extent choices contain a duplicate");
  }
  let nextFresh = state.allocator.totalExtents;
  for (const extentId of extents) {
    if (extentId < state.allocator.totalExtents) {
      if (!state.allocator.available.has(extentId)) {
        throw new FsError("EINVAL", "extent choice is not safely available");
      }
      continue;
    }
    if (extentId !== nextFresh) {
      throw new FsError("EINVAL", "fresh extent choices must grow the arena contiguously");
    }
    nextFresh += 1n;
  }
  if (nextFresh > BigInt(MAX_TOTAL_EXTENTS)) {
    throw new StoreLimitError(`total extent count would exceed ${MAX_TOTAL_EXTENTS}`);
  }
  return extents;
}

function applyCreateFile(state: VfsState, record: Extract<TxnRecord, { kind: "createFile" }>): void {
  validatePathComponent(record.name);
  const parent = directoryById(state, record.parentId);
  if (parent.children.has(record.name)) {
    throw new FsError("EEXIST", "directory entry already exists");
  }
  if (record.inodeId !== state.nextInodeId || state.inodes.has(record.inodeId)) {
    throw new FsError("EINVAL", "createFile record has a non-canonical inode ID");
  }
  const nextInodeId = advanceNextInodeId(record.inodeId);
  validateMode(record.mode);
  validateTimestamp(record.atimeMs);
  validateTimestamp(record.mtimeMs);
  validateTimestamp(record.ctimeMs);
  const size = checkedU64(record.size, "file size");
  const extents = validateExtentAssignment(state, record.extents, extentCountForSize(size, state.extentSize));
  if (state.inodes.size >= MAX_INODES) {
    throw new StoreLimitError(`inode count would exceed ${MAX_INODES}`);
  }

  const inode: FileInode = {
    id: record.inodeId,
    kind: "file",
    mode: record.mode,
    atimeMs: record.atimeMs,
    mtimeMs: record.mtimeMs,
    ctimeMs: record.ctimeMs,
    size,
    extents,
  };
  for (const extentId of extents) {
    if (extentId < state.allocator.totalExtents) {
      state.allocator.available.delete(extentId);
    } else {
      state.allocator.totalExtents += 1n;
    }
    state.allocator.ownedBy.set(extentId, inode.id);
  }
  parent.children.set(record.name, inode.id);
  state.inodes.set(inode.id, inode);
  state.parentByInode.set(inode.id, { parentId: parent.id, name: record.name });
  state.nextInodeId = nextInodeId;
}

function applyRemoveFile(state: VfsState, record: Extract<TxnRecord, { kind: "removeFile" }>): void {
  validatePathComponent(record.name);
  validateTimestamp(record.parentMtimeMs);
  validateTimestamp(record.parentCtimeMs);
  const parent = directoryById(state, record.parentId);
  const inodeId = parent.children.get(record.name);
  const inode = inodeId === undefined ? undefined : state.inodes.get(inodeId);
  if (inode === undefined) {
    throw new FsError("ENOENT", "file does not exist");
  }
  if (inode.kind !== "file") {
    throw new FsError("EISDIR", "path is a directory");
  }
  for (const extentId of inode.extents) {
    if (state.allocator.ownedBy.get(extentId) !== inode.id || state.allocator.quarantine.has(extentId)) {
      throw new StoreLimitError("file extent ownership is inconsistent");
    }
  }

  parent.children.delete(record.name);
  parent.mtimeMs = record.parentMtimeMs;
  parent.ctimeMs = record.parentCtimeMs;
  state.inodes.delete(inode.id);
  state.parentByInode.delete(inode.id);
  for (const extentId of inode.extents) {
    state.allocator.ownedBy.delete(extentId);
    state.allocator.quarantine.set(extentId, null);
  }
}

function applyChangeMode(state: VfsState, record: Extract<TxnRecord, { kind: "changeMode" }>): void {
  const inode = inodeById(state, record.inodeId);
  const mode = validateMode(record.mode);
  const ctimeMs = validateTimestamp(record.ctimeMs);
  inode.mode = mode;
  inode.ctimeMs = ctimeMs;
}

function applyChangeTimes(state: VfsState, record: Extract<TxnRecord, { kind: "changeTimes" }>): void {
  const inode = inodeById(state, record.inodeId);
  const atimeMs = validateTimestamp(record.atimeMs);
  const mtimeMs = validateTimestamp(record.mtimeMs);
  const ctimeMs = validateTimestamp(record.ctimeMs);
  inode.atimeMs = atimeMs;
  inode.mtimeMs = mtimeMs;
  inode.ctimeMs = ctimeMs;
}

function applyResizeFile(state: VfsState, record: Extract<TxnRecord, { kind: "resizeFile" }>): void {
  const inode = fileById(state, record.inodeId);
  const size = checkedU64(record.size, "file size");
  const required = extentCountForSize(size, state.extentSize);
  const additionalCount = Math.max(0, required - inode.extents.length);
  const allocated = validateExtentAssignment(state, record.allocated, additionalCount);
  const retained = required >= inode.extents.length ? inode.extents : inode.extents.slice(0, required);
  const released = inode.extents.slice(required);
  for (const extentId of released) {
    if (state.allocator.ownedBy.get(extentId) !== inode.id || state.allocator.quarantine.has(extentId)) {
      throw new StoreLimitError("file extent ownership is inconsistent");
    }
  }
  const mtimeMs = validateTimestamp(record.mtimeMs);
  const ctimeMs = validateTimestamp(record.ctimeMs);

  for (const extentId of allocated) {
    if (extentId < state.allocator.totalExtents) {
      state.allocator.available.delete(extentId);
    } else {
      state.allocator.totalExtents += 1n;
    }
    state.allocator.ownedBy.set(extentId, inode.id);
    retained.push(extentId);
  }
  for (const extentId of released) {
    state.allocator.ownedBy.delete(extentId);
    state.allocator.quarantine.set(extentId, null);
  }
  inode.size = size;
  inode.extents = retained;
  inode.mtimeMs = mtimeMs;
  inode.ctimeMs = ctimeMs;
}

function applyRemoveDirectory(state: VfsState, record: Extract<TxnRecord, { kind: "removeDirectory" }>): void {
  validatePathComponent(record.name);
  const parent = directoryById(state, record.parentId);
  const inodeId = parent.children.get(record.name);
  const inode = inodeId === undefined ? undefined : state.inodes.get(inodeId);
  if (inode === undefined) {
    throw new FsError("ENOENT", "directory does not exist");
  }
  if (inode.kind !== "directory") {
    throw new FsError("ENOTDIR", "path is not a directory");
  }
  if (inode.children.size !== 0) {
    throw new FsError("ENOTEMPTY", "directory is not empty");
  }
  const mtimeMs = validateTimestamp(record.parentMtimeMs);
  const ctimeMs = validateTimestamp(record.parentCtimeMs);
  parent.children.delete(record.name);
  parent.mtimeMs = mtimeMs;
  parent.ctimeMs = ctimeMs;
  state.inodes.delete(inode.id);
  state.parentByInode.delete(inode.id);
}

function applyRename(state: VfsState, record: Extract<TxnRecord, { kind: "rename" }>): void {
  validatePathComponent(record.sourceName);
  validatePathComponent(record.destinationName);
  if (record.sourceParentId === record.destinationParentId && record.sourceName === record.destinationName) {
    throw new FsError("EINVAL", "rename source and destination are identical");
  }
  const timestampMs = validateTimestamp(record.timestampMs);
  const sourceParent = directoryById(state, record.sourceParentId);
  const destinationParent = directoryById(state, record.destinationParentId);
  const sourceId = sourceParent.children.get(record.sourceName);
  if (sourceId === undefined) {
    throw new FsError("ENOENT", "rename source does not exist");
  }
  const source = inodeById(state, sourceId);
  const destinationId = destinationParent.children.get(record.destinationName);
  const destination = destinationId === undefined ? undefined : inodeById(state, destinationId);
  validateRenameTypes(source, destination);
  if (source.kind === "directory" && directoryContains(state, source, destinationParent.id)) {
    throw new FsError("EINVAL", "cannot move a directory into itself");
  }
  validateRenamedSubtreeBounds(state, source, destinationParent, record.destinationName);
  if (destination?.kind === "file") {
    for (const extentId of destination.extents) {
      if (state.allocator.ownedBy.get(extentId) !== destination.id || state.allocator.quarantine.has(extentId)) {
        throw new StoreLimitError("replacement extent ownership is inconsistent");
      }
    }
  }

  sourceParent.children.delete(record.sourceName);
  if (destination !== undefined) {
    destinationParent.children.delete(record.destinationName);
    state.inodes.delete(destination.id);
    state.parentByInode.delete(destination.id);
    if (destination.kind === "file") {
      for (const extentId of destination.extents) {
        state.allocator.ownedBy.delete(extentId);
        state.allocator.quarantine.set(extentId, null);
      }
    }
  }
  destinationParent.children.set(record.destinationName, source.id);
  state.parentByInode.set(source.id, {
    parentId: destinationParent.id,
    name: record.destinationName,
  });
  source.ctimeMs = timestampMs;
  sourceParent.mtimeMs = timestampMs;
  sourceParent.ctimeMs = timestampMs;
  destinationParent.mtimeMs = timestampMs;
  destinationParent.ctimeMs = timestampMs;
}

function applyReserveQuarantine(state: VfsState, record: Extract<TxnRecord, { kind: "reserveQuarantine" }>): void {
  const declaredCount = record.extents.reduce((sum, run) => sum + run.count, 0);
  if (declaredCount <= 0 || declaredCount > MAX_EXTENTS_PER_INODE) {
    throw new StoreLimitError("orphan reservation extent count is outside limits");
  }
  const extents = validateExtentAssignment(state, record.extents, declaredCount);
  for (const extentId of extents) {
    if (extentId < state.allocator.totalExtents) {
      state.allocator.available.delete(extentId);
    } else {
      state.allocator.totalExtents += 1n;
    }
    state.allocator.quarantine.set(extentId, null);
  }
}

export function applyTxn(state: VfsState, record: TxnRecord, prepared?: PreparedTxnProjection): void {
  if (
    prepared !== undefined &&
    (prepared[PREPARED_TXN_PROJECTION] !== true || prepared.state !== state || prepared.record !== record)
  ) {
    throw new StoreLimitError("prepared transaction projection does not match the live transition");
  }
  const projectedBasePayloadBytes = prepared?.projectedBasePayloadBytes ?? preflightTxn(state, record);
  switch (record.kind) {
    case "createDirectories":
      validateCreateDirectories(state, record.entries);
      for (const entry of record.entries) {
        const parent = directoryById(state, entry.parentId);
        const created: DirectoryInode = {
          id: entry.inodeId,
          kind: "directory",
          mode: entry.mode,
          atimeMs: entry.atimeMs,
          mtimeMs: entry.mtimeMs,
          ctimeMs: entry.ctimeMs,
          children: new Map(),
        };
        parent.children.set(entry.name, created.id);
        state.inodes.set(created.id, created);
        state.parentByInode.set(created.id, { parentId: parent.id, name: entry.name });
        state.nextInodeId = advanceNextInodeId(created.id);
      }
      break;
    case "createFile":
      applyCreateFile(state, record);
      break;
    case "removeFile":
      applyRemoveFile(state, record);
      break;
    case "changeMode":
      applyChangeMode(state, record);
      break;
    case "changeTimes":
      applyChangeTimes(state, record);
      break;
    case "resizeFile":
      applyResizeFile(state, record);
      break;
    case "removeDirectory":
      applyRemoveDirectory(state, record);
      break;
    case "rename":
      applyRename(state, record);
      break;
    case "reserveQuarantine":
      applyReserveQuarantine(state, record);
      break;
  }
  state.basePayloadBytes = projectedBasePayloadBytes;
}

function cloneState(state: VfsState): VfsState {
  return {
    ...state,
    retainedGenerations: { ...state.retainedGenerations },
    inodes: new Map(
      [...state.inodes].map(([inodeId, inode]) => [
        inodeId,
        inode.kind === "directory"
          ? { ...inode, children: new Map(inode.children) }
          : { ...inode, extents: [...inode.extents] },
      ]),
    ),
    parentByInode: new Map([...state.parentByInode].map(([inodeId, entry]) => [inodeId, { ...entry }])),
    allocator: {
      totalExtents: state.allocator.totalExtents,
      ownedBy: new Map(state.allocator.ownedBy),
      available: state.allocator.available.clone(),
      quarantine: new Map(state.allocator.quarantine),
    },
  };
}

function projectRepackFromCopy(
  state: VfsState,
  projected: VfsState,
  pinnedQuarantine: ReadonlySet<ExtentId>,
): VfsState {
  // Activated/recovered state and every live reducer transition are already validated.
  // The projected result is validated below before its canonical base can be activated.
  if (state.generation === MAX_U64) {
    throw new StoreLimitError("generation is exhausted; the store must be recreated");
  }
  let projectedBasePayloadBytes = state.basePayloadBytes;
  const nextGeneration = state.generation + 1n;
  const target = otherMetadataFile(state.activeMetadataFile);
  const targetPreviousGeneration = state.retainedGenerations[target];
  for (const [extentId, firstExcludedGeneration] of projected.allocator.quarantine) {
    if (pinnedQuarantine.has(extentId)) {
      projected.allocator.quarantine.set(extentId, null);
    } else if (firstExcludedGeneration === null) {
      projected.allocator.quarantine.set(extentId, nextGeneration);
    } else if (targetPreviousGeneration === null || targetPreviousGeneration < firstExcludedGeneration) {
      projected.allocator.quarantine.delete(extentId);
      projected.allocator.available.add(extentId);
      projectedBasePayloadBytes -= 8;
    }
  }
  while (projected.allocator.totalExtents > 0n) {
    const tail = projected.allocator.totalExtents - 1n;
    if (!projected.allocator.available.delete(tail)) break;
    projected.allocator.totalExtents = tail;
    projectedBasePayloadBytes -= 8;
  }
  projected.generation = nextGeneration;
  projected.activeMetadataFile = target;
  projected.retainedGenerations[target] = nextGeneration;
  projected.basePayloadBytes = projectedBasePayloadBytes;
  validateState(projected);
  return projected;
}

export function projectRepack(state: VfsState, pinnedQuarantine: ReadonlySet<ExtentId> = new Set()): VfsState {
  return projectRepackFromCopy(state, cloneState(state), pinnedQuarantine);
}

/**
 * @internal Activation-only projection. Structures repack never mutates are shared read-only until
 * durable activation; allocator and generation structures remain isolated from the live state.
 */
export function projectRepackForActivation(
  state: VfsState,
  pinnedQuarantine: ReadonlySet<ExtentId> = new Set(),
): VfsState {
  const projected: VfsState = {
    ...state,
    retainedGenerations: { ...state.retainedGenerations },
    inodes: state.inodes,
    parentByInode: state.parentByInode,
    allocator: {
      totalExtents: state.allocator.totalExtents,
      ownedBy: state.allocator.ownedBy,
      available: state.allocator.available.clone(),
      quarantine: new Map(state.allocator.quarantine),
    },
  };
  return projectRepackFromCopy(state, projected, pinnedQuarantine);
}

export function validateState(state: VfsState): void {
  validateExtentSize(state.extentSize);
  checkedU64(state.generation, "generation");
  if (state.generation === 0n) {
    throw new StoreLimitError("generation must be positive");
  }
  checkedU64(state.nextInodeId, "next inode ID");
  const root = state.inodes.get(state.rootInodeId);
  if (root?.kind !== "directory") {
    throw new StoreLimitError("root inode is missing or is not a directory");
  }
  if (state.parentByInode.has(state.rootInodeId)) {
    throw new StoreLimitError("root inode must not have a parent entry");
  }
  if (state.inodes.size > MAX_INODES) {
    throw new StoreLimitError(`inode count exceeds ${MAX_INODES}`);
  }
  checkedU64(state.allocator.totalExtents, "total extent count");
  if (state.allocator.totalExtents > BigInt(MAX_TOTAL_EXTENTS)) {
    throw new StoreLimitError(`total extent count exceeds ${MAX_TOTAL_EXTENTS}`);
  }
  const classified = new Uint8Array(Number(state.allocator.totalExtents));
  let classifiedCount = 0;
  const classify = (extentId: ExtentId, label: string): void => {
    if (extentId < 0n || extentId >= state.allocator.totalExtents) {
      throw new StoreLimitError(`${label} extent is out of range or multiply classified`);
    }
    const index = Number(extentId);
    if (classified[index] !== 0) {
      throw new StoreLimitError(`${label} extent is out of range or multiply classified`);
    }
    classified[index] = 1;
    classifiedCount += 1;
  };
  const reached = new Set<InodeId>();
  let calculatedBasePayloadBytes = BASE_STATE_FIXED_BYTES;
  const visit = (inodeKey: InodeId, inode: Inode, metrics: PathMetrics): void => {
    checkedU64(inodeKey, "inode map key");
    checkedU64(inode.id, "inode ID");
    if (inodeKey !== inode.id) {
      throw new StoreLimitError("inode map key does not match the inode ID");
    }
    if (inode.id >= state.nextInodeId) {
      throw new StoreLimitError("inode ID is not below the unused next inode ID");
    }
    if (reached.has(inode.id)) {
      throw new StoreLimitError("inode has more than one directory owner");
    }
    reached.add(inode.id);
    validateMode(inode.mode);
    validateTimestamp(inode.atimeMs);
    validateTimestamp(inode.mtimeMs);
    validateTimestamp(inode.ctimeMs);
    if (inode.kind === "directory") {
      calculatedBasePayloadBytes += DIRECTORY_INODE_FIXED_BYTES;
      for (const [name, childId] of inode.children) {
        const nameBytes = validatePathComponent(name);
        calculatedBasePayloadBytes += CHILD_FIXED_BYTES + nameBytes;
        const parentEntry = state.parentByInode.get(childId);
        if (parentEntry?.parentId !== inode.id || parentEntry.name !== name) {
          throw new StoreLimitError("inode parent index does not match its directory entry");
        }
        const childMetrics = {
          depth: metrics.depth + 1,
          bytes: metrics.bytes + (metrics.depth === 0 ? 0 : 1) + nameBytes,
        };
        if (childMetrics.depth > MAX_PATH_DEPTH) {
          throw new StoreLimitError(`inode path exceeds ${MAX_PATH_DEPTH} components`);
        }
        if (childMetrics.bytes > MAX_PATH_BYTES) {
          throw new StoreLimitError(`inode path exceeds ${MAX_PATH_BYTES} UTF-8 bytes`);
        }
        const child = state.inodes.get(childId);
        if (child === undefined) {
          throw new StoreLimitError("directory entry references a missing inode");
        }
        visit(childId, child, childMetrics);
      }
    } else {
      calculatedBasePayloadBytes += FILE_INODE_FIXED_BYTES + inode.extents.length * 8;
      if (inode.extents.length !== extentCountForSize(inode.size, state.extentSize)) {
        throw new StoreLimitError("file extent count does not cover its size exactly");
      }
      for (const extentId of inode.extents) {
        classify(extentId, "owned");
        if (state.allocator.ownedBy.get(extentId) !== inode.id) {
          throw new StoreLimitError("owned extent does not map back to its inode");
        }
      }
    }
  };
  visit(state.rootInodeId, root, { depth: 0, bytes: 1 });
  if (reached.size !== state.inodes.size) {
    throw new StoreLimitError("inode graph contains unreachable inodes");
  }
  if (state.parentByInode.size !== state.inodes.size - 1) {
    throw new StoreLimitError("inode parent index does not cover every non-root inode");
  }
  if (classifiedCount !== state.allocator.ownedBy.size) {
    throw new StoreLimitError("allocator contains an owner not referenced by a file");
  }
  calculatedBasePayloadBytes += state.allocator.available.size * 8 + state.allocator.quarantine.size * 16;
  if (state.basePayloadBytes !== calculatedBasePayloadBytes) {
    throw new StoreLimitError("tracked metadata-base size does not match canonical state size");
  }
  if (state.basePayloadBytes > MAX_METADATA_BASE_WRITER_BYTES) {
    throw new StoreLimitError(`metadata base exceeds ${MAX_METADATA_BASE_WRITER_BYTES} bytes`);
  }
  if (state.retainedGenerations[state.activeMetadataFile] !== state.generation) {
    throw new StoreLimitError("active metadata identity does not match the state generation");
  }
  const inactiveMetadataFile = otherMetadataFile(state.activeMetadataFile);
  const inactiveGeneration = state.retainedGenerations[inactiveMetadataFile];
  if (inactiveGeneration !== null) {
    checkedU64(inactiveGeneration, "inactive retained generation");
    if (inactiveGeneration === 0n || inactiveGeneration + 1n !== state.generation) {
      throw new StoreLimitError("inactive retained generation is not the immediate predecessor");
    }
  }
  for (const extentId of state.allocator.available.values()) {
    classify(extentId, "available");
  }
  for (const [extentId, firstExcludedGeneration] of state.allocator.quarantine) {
    classify(extentId, "quarantined");
    if (firstExcludedGeneration !== null && firstExcludedGeneration !== state.generation) {
      throw new StoreLimitError("quarantine generation is inconsistent with retained metadata");
    }
  }
  if (BigInt(classifiedCount) !== state.allocator.totalExtents) {
    throw new StoreLimitError("allocator partition does not cover every extent");
  }
}

export function canonicalStateView(state: VfsState) {
  const inodes = [...state.inodes.values()]
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    .map((inode) =>
      inode.kind === "directory"
        ? {
            ...inode,
            children: [...inode.children.entries()].sort(([left], [right]) => left.localeCompare(right)),
          }
        : { ...inode, extents: [...inode.extents] },
    );
  return {
    generation: state.generation,
    nextInodeId: state.nextInodeId,
    rootInodeId: state.rootInodeId,
    extentSize: state.extentSize,
    activeMetadataFile: state.activeMetadataFile,
    retainedGenerations: { ...state.retainedGenerations },
    basePayloadBytes: state.basePayloadBytes,
    inodes,
    parentByInode: [...state.parentByInode.entries()].sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
    allocator: {
      totalExtents: state.allocator.totalExtents,
      ownedBy: [...state.allocator.ownedBy.entries()].sort(([left], [right]) => (left < right ? -1 : 1)),
      available: [...state.allocator.available.values()].sort((left, right) => (left < right ? -1 : 1)),
      quarantine: [...state.allocator.quarantine.entries()].sort(([left], [right]) => (left < right ? -1 : 1)),
    },
  };
}
