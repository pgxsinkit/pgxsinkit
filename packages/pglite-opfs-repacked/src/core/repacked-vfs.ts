import {
  ACTIVATION_SLOT_BYTES,
  encodeActivationSlot,
  encodeValidatedMetadataBase,
  encodeTxnFrame,
  metadataBaseDigest,
  txnFrameBytes,
} from "./codec";
import { CorruptStoreError, FS_ERRNO, FsError, StoreClosedError, StoreFailedError, StoreLimitError } from "./errors";
import {
  ARENA_HEADER_BYTES,
  MAX_ACTIVE_LOG_BYTES,
  MAX_ACTIVE_LOG_FRAMES,
  MAX_EXTENTS_PER_INODE,
  MAX_METADATA_BASE_WRITER_BYTES,
  SOFT_ACTIVE_LOG_BYTES,
  SOFT_ACTIVE_LOG_FRAMES,
  checkedAdd,
  checkedMultiply,
  checkedSafeNumber,
  checkedU64,
} from "./limits";
import { openMetadataStore } from "./metadata-store";
import type { OpenedMetadataStore } from "./metadata-store";
import { PortWriteError, arenaByteOffset, metadataFileName, truncateChecked, writeExact } from "./port";
import type { RepackedFileHandle, RepackedPort } from "./port";
import {
  applyTxn,
  expandExtentRuns,
  getInodeAtPath,
  makeOrphanRecord,
  planChmod,
  planCreateFile,
  planMkdir,
  planRename,
  planReserveQuarantine,
  planResizeFile,
  planResizeFileForInode,
  planRmdir,
  planUnlink,
  planUtimes,
  prepareTxnProjection,
  projectRepackForActivation,
} from "./state-machine";
import type { ExtentRun, FileInode, OrphanRecord, PreparedTxnProjection, TxnRecord } from "./state-machine";

interface Descriptor {
  inodeId: bigint;
  offset: bigint;
  readable: boolean;
  writable: boolean;
  append: boolean;
  orphan?: OrphanRecord;
}

interface ParsedFlags {
  readable: boolean;
  writable: boolean;
  create: boolean;
  exclusive: boolean;
  truncate: boolean;
  append: boolean;
}

interface WriteProgress {
  bytes: number;
  error?: unknown;
}

interface PreparedCommit {
  readonly frame: Uint8Array | undefined;
  readonly frameBytes: number;
  readonly projection: PreparedTxnProjection;
  readonly materializedRecord: TxnRecord;
  readonly deferResize: boolean;
  readonly replacesPendingResize: boolean;
}

interface PendingResizeCommit {
  readonly record: Extract<TxnRecord, { kind: "resizeFile" }>;
  readonly frameBytes: number;
  readonly sequence: bigint;
}

type FlushKind = "amortized" | "arena" | "metadata" | "zeroBarrier" | "manifest";
const REPACK_INTERVAL_MS = 30_000;
const AMORTIZED_ARENA_FLUSH_BYTES = 4 * 1024 * 1024;
const BASE_REPACK_PRESSURE_BYTES = Math.floor(MAX_METADATA_BASE_WRITER_BYTES * 0.75);
const QUARANTINE_PRESSURE_EXTENTS = 64;

class ArenaGrowthQuotaError extends Error {
  override readonly cause: unknown;

  constructor(cause: unknown) {
    super("arena growth exhausted the storage quota");
    this.name = "ArenaGrowthQuotaError";
    this.cause = cause;
  }
}

function isQuotaExceeded(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && "name" in cause && cause.name === "QuotaExceededError";
}

function mergeExtentRuns(left: readonly ExtentRun[], right: readonly ExtentRun[]): ExtentRun[] {
  const merged = left.map((run) => ({ ...run }));
  for (const run of right) {
    const last = merged.at(-1);
    if (last !== undefined && last.start + BigInt(last.count) === run.start && last.count + run.count <= 0xffff_ffff) {
      last.count += run.count;
    } else {
      merged.push({ ...run });
    }
  }
  return merged;
}

export interface RepackedVfsOpenOptions {
  /** Creation extent size: 8 KiB–16 MiB in 8 KiB steps. Defaults to 64 KiB. */
  extentSize?: number;
}

export interface RepackedStat {
  readonly kind: "directory" | "file";
  readonly mode: number;
  readonly size: bigint;
  readonly atimeMs: bigint;
  readonly mtimeMs: bigint;
  readonly ctimeMs: bigint;
}

export type RepackReason =
  | "manual"
  | "time"
  | "log-bytes"
  | "log-frames"
  | "writer-limit"
  | "quarantine-pressure"
  | "quota";

export interface RepackedVfsMetrics {
  readonly generation: bigint;
  readonly totalExtents: bigint;
  readonly availableExtents: number;
  readonly quarantineExtents: number;
  readonly quarantineBytes: bigint;
  readonly activeLogBytes: number;
  readonly activeLogFrames: number;
  readonly lastRepackReason: RepackReason | null;
  readonly lastRepackDurationMs: number | null;
  readonly repackCount: number;
  readonly pendingRepackReason: RepackReason | null;
  readonly flushes: Readonly<{
    amortized: number;
    arena: number;
    metadata: number;
    zeroBarrier: number;
    manifest: number;
  }>;
}

export class RepackedVfs {
  readonly #store: OpenedMetadataStore;
  #status: "open" | "failed" | "closed" = "open";
  #failure: unknown;
  readonly #descriptors = new Map<number, Descriptor>();
  #nextDescriptor = 3;
  #pendingResizeCommit: PendingResizeCommit | undefined;
  #arenaSize: number | undefined;
  #arenaDirty: boolean;
  #arenaDirtyBytesSinceFlush = 0;
  #metadataDirtySinceFlush: boolean;
  #repacking = false;
  #lastRepackReason: RepackReason | null = null;
  #lastRepackDurationMs: number | null = null;
  #pendingRepackReason: RepackReason | null = null;
  #repackCount = 0;
  #lastRepackAtMs = Date.now();
  readonly #flushes = { amortized: 0, arena: 0, metadata: 0, zeroBarrier: 0, manifest: 0 };

  private constructor(store: OpenedMetadataStore) {
    this.#store = store;
    this.#arenaSize = store.arenaSize;
    this.#arenaDirty = store.arenaDirty;
    this.#metadataDirtySinceFlush = store.activeMetadataDirty;
  }

  static async open(port: RepackedPort, options: RepackedVfsOpenOptions = {}): Promise<RepackedVfs> {
    return new RepackedVfs(await openMetadataStore(port, options));
  }

  strictSync(): void {
    this.#assertOpen();
    try {
      if (this.#arenaDirty) this.#flush(this.#store.handles["arena.bin"], "sync.arena.flush", "arena");
      this.#materializePendingResize();
      if (this.#metadataDirtySinceFlush) {
        const activeName = metadataFileName(this.#store.state.activeMetadataFile);
        this.#flush(this.#store.handles[activeName], "sync.metadata.flush", "metadata");
      }
      this.#arenaDirty = false;
      this.#arenaDirtyBytesSinceFlush = 0;
      this.#metadataDirtySinceFlush = false;
    } catch (cause) {
      this.#poison(cause);
      throw cause;
    }
  }

  assertHealthy(): void {
    this.#assertOpen();
  }

  fail(cause: unknown): never {
    this.#assertOpen();
    this.#poison(cause);
    throw cause;
  }

  cleanupFailedInit(): void {
    if (this.#status === "closed") return;
    this.#status = "closed";
    this.#descriptors.clear();
    const closeError = this.#closeHandles();
    if (closeError !== undefined) throw closeError;
  }

  metrics(): RepackedVfsMetrics {
    this.#assertOpen();
    return {
      generation: this.#store.state.generation,
      totalExtents: this.#store.state.allocator.totalExtents,
      availableExtents: this.#store.state.allocator.available.size,
      quarantineExtents: this.#store.state.allocator.quarantine.size,
      quarantineBytes: BigInt(this.#store.state.allocator.quarantine.size) * BigInt(this.#store.state.extentSize),
      activeLogBytes: this.#store.activeLogBytes,
      activeLogFrames: this.#store.activeLogFrames,
      lastRepackReason: this.#lastRepackReason,
      lastRepackDurationMs: this.#lastRepackDurationMs,
      repackCount: this.#repackCount,
      pendingRepackReason: this.#pendingRepackReason,
      flushes: { ...this.#flushes },
    };
  }

  repack(reason: RepackReason = "manual"): void {
    this.#assertOpen();
    if (this.#repacking) throw new Error("OPFS repacked VFS repack is already running");
    checkedAdd(this.#store.state.generation, 1n, "generation");
    const activationSequence = checkedAdd(this.#store.activationSequence, 1n, "activation sequence");
    this.#repacking = true;
    const startedAt = performance.now();
    try {
      this.#materializePendingResize();
      const pinned = new Set<bigint>();
      for (const descriptor of this.#descriptors.values()) {
        if (descriptor.orphan === undefined) continue;
        for (const extentId of descriptor.orphan.extents) pinned.add(extentId);
      }
      const projected = projectRepackForActivation(this.#store.state, pinned);
      const base = encodeValidatedMetadataBase(projected);
      const activation = encodeActivationSlot({
        sequence: activationSequence,
        metadataFile: projected.activeMetadataFile,
        generation: projected.generation,
        baseEnd: BigInt(base.byteLength),
        baseDigest: metadataBaseDigest(base),
      });

      this.#flush(this.#store.handles["arena.bin"], "repack.arena.flush", "arena");
      this.#arenaDirty = false;
      this.#arenaDirtyBytesSinceFlush = 0;
      const inactiveName = metadataFileName(projected.activeMetadataFile);
      const inactive = this.#store.handles[inactiveName];
      inactive.truncate(0, "repack.metadata.reset");
      writeExact(inactive, 0n, base, "repack.metadata.write");
      this.#flush(inactive, "repack.metadata.flush", "metadata");

      const activationOffset = ((activationSequence - 1n) % 2n) * BigInt(ACTIVATION_SLOT_BYTES);
      try {
        writeExact(this.#store.handles["activation.bin"], activationOffset, activation, "repack.activation.write");
        this.#flush(this.#store.handles["activation.bin"], "repack.activation.flush", "manifest");
      } catch (cause) {
        this.#poison(cause);
        throw cause;
      }

      try {
        this.#store.state = projected;
        this.#store.activeLogEnd = BigInt(base.byteLength);
        this.#store.nextSequence = 1n;
        this.#store.activeLogBytes = 0;
        this.#store.activeLogFrames = 0;
        this.#store.activationSequence = activationSequence;
        this.#metadataDirtySinceFlush = false;
        this.#lastRepackReason = reason;
        this.#pendingRepackReason = null;
        this.#repackCount += 1;
        this.#lastRepackAtMs = Date.now();
        this.#scheduleRepack();
      } catch (cause) {
        this.#poison(cause);
        throw cause;
      }

      const requiredArenaEnd = checkedAdd(
        BigInt(ARENA_HEADER_BYTES),
        checkedMultiply(projected.allocator.totalExtents, BigInt(projected.extentSize), "arena byte length"),
        "arena byte length",
      );
      try {
        if (BigInt(this.#arenaSizeChecked("repack.arena.size-before-trim")) > requiredArenaEnd) {
          this.#arenaDirty = true;
          this.#truncateArena(requiredArenaEnd, "repack.arena.trim");
        }
      } catch {
        // The activated allocator no longer names this physical tail; recovery can trim it later.
      }
      this.#lastRepackDurationMs = performance.now() - startedAt;
    } finally {
      this.#repacking = false;
    }
  }

  runScheduledRepack(nowMs = Date.now()): boolean {
    this.#assertOpen();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new TypeError("repack scheduler time is invalid");
    this.#materializePendingResize();
    if (this.#arenaDirtyBytesSinceFlush >= AMORTIZED_ARENA_FLUSH_BYTES) {
      try {
        this.#flush(this.#store.handles["arena.bin"], "sync.arena.amortized.flush", "amortized");
        this.#arenaDirty = false;
        this.#arenaDirtyBytesSinceFlush = 0;
      } catch (cause) {
        this.#poison(cause);
        throw cause;
      }
    }
    const reason = this.#dueRepackReason(nowMs);
    if (reason === null) return false;
    this.repack(reason);
    this.#lastRepackAtMs = nowMs;
    return true;
  }

  stat(path: string): RepackedStat {
    return this.lstat(path);
  }

  lstat(path: string): RepackedStat {
    this.#assertOpen();
    const inode = getInodeAtPath(this.#store.state, path);
    return this.#statValue(inode);
  }

  readdir(path: string): string[] {
    this.#assertOpen();
    const inode = getInodeAtPath(this.#store.state, path);
    if (inode.kind !== "directory") throw new FsError("ENOTDIR", "path is not a directory", { path });
    return [...inode.children.keys()].sort();
  }

  mkdir(path: string, options: { recursive?: boolean; mode?: number; nowMs: bigint }): void {
    this.#assertOpen();
    this.#commit(planMkdir(this.#store.state, path, options).record);
  }

  writeFile(
    path: string,
    data: string | Uint8Array,
    options: { encoding?: string; mode?: number; flag?: string; nowMs: bigint },
  ): void {
    this.#assertOpen();
    const flags = this.#parseFlags(options.flag ?? "w");
    if (!flags.writable)
      throw new FsError("EBADF", "writeFile flags are not writable", { operation: "writeFile", path });
    let bytes: Uint8Array;
    if (typeof data === "string") {
      this.#validateEncoding(options.encoding ?? "utf8", path);
      bytes = new TextEncoder().encode(data);
    } else {
      bytes = data;
    }
    checkedU64(options.nowMs, "timestamp");
    let existing: FileInode | undefined;
    try {
      const inode = getInodeAtPath(this.#store.state, path);
      if (inode.kind !== "file") throw new FsError("EISDIR", "path is a directory", { path });
      existing = inode;
    } catch (cause) {
      if (!(cause instanceof FsError) || cause.code !== FS_ERRNO.ENOENT) throw cause;
    }
    if (existing !== undefined && flags.create && flags.exclusive) {
      throw new FsError("EEXIST", "path already exists", { operation: "writeFile", path });
    }
    if (existing === undefined && !flags.create) {
      throw new FsError("ENOENT", "path does not exist", { operation: "writeFile", path });
    }
    const wasExisting = existing !== undefined;
    if (bytes.byteLength === 0 && existing !== undefined && !flags.truncate) return;
    const buildPlan = () => {
      let current: FileInode | undefined;
      if (wasExisting) {
        const inode = getInodeAtPath(this.#store.state, path);
        if (inode.kind !== "file") throw new FsError("EISDIR", "path is a directory", { path });
        current = inode;
      }
      const currentStart = current !== undefined && flags.append ? current.size : 0n;
      const targetSize =
        current === undefined
          ? BigInt(bytes.byteLength)
          : flags.append
            ? checkedAdd(current.size, BigInt(bytes.byteLength), "writeFile size")
            : flags.truncate
              ? BigInt(bytes.byteLength)
              : current.size > BigInt(bytes.byteLength)
                ? current.size
                : BigInt(bytes.byteLength);
      const currentPlan =
        current === undefined
          ? planCreateFile(this.#store.state, path, {
              ...(options.mode === undefined ? {} : { mode: options.mode }),
              nowMs: options.nowMs,
              size: targetSize,
            })
          : planResizeFile(this.#store.state, path, targetSize, options.nowMs, "write");
      return {
        existing: current,
        start: currentStart,
        plan: currentPlan,
        preparedCommit: this.#preflightCommit(currentPlan.record),
        allocated: expandExtentRuns(
          currentPlan.record.kind === "createFile" ? currentPlan.record.extents : currentPlan.record.allocated,
          MAX_EXTENTS_PER_INODE,
        ),
      };
    };
    const prepared = this.#prepareAllocationWithQuotaRetry(buildPlan(), buildPlan);
    existing = prepared.existing;
    const { start, plan, preparedCommit, allocated } = prepared;
    if (bytes.byteLength === 0) {
      this.#commit(plan.record, preparedCommit);
      return;
    }
    const progress = this.#writeLogical(existing?.extents ?? [], start, bytes, "arena.write-file", allocated);
    if (progress.bytes === 0) throw progress.error;
    const partialSize =
      existing !== undefined && !flags.truncate
        ? existing.size > checkedAdd(start, BigInt(progress.bytes), "partial writeFile size")
          ? existing.size
          : checkedAdd(start, BigInt(progress.bytes), "partial writeFile size")
        : BigInt(progress.bytes);
    const committedPlan =
      progress.bytes === bytes.byteLength
        ? plan
        : existing === undefined
          ? planCreateFile(this.#store.state, path, {
              ...(options.mode === undefined ? {} : { mode: options.mode }),
              nowMs: options.nowMs,
              size: partialSize,
            })
          : planResizeFile(this.#store.state, path, partialSize, options.nowMs, "write");
    if (progress.error === undefined || partialSize !== existing?.size) {
      this.#commit(committedPlan.record, committedPlan === plan ? preparedCommit : undefined);
    }
    if (progress.error !== undefined) throw progress.error;
  }

  readFile(path: string): Uint8Array {
    this.#assertOpen();
    const inode = getInodeAtPath(this.#store.state, path);
    if (inode.kind !== "file") throw new FsError("EISDIR", "path is a directory", { path });
    const output = new Uint8Array(checkedSafeNumber(inode.size, "file read size"));
    this.#readLogical(inode.extents, 0n, output);
    return output;
  }

  truncate(path: string, size: bigint, nowMs: bigint): void {
    this.#assertOpen();
    let inode = getInodeAtPath(this.#store.state, path);
    if (inode.kind !== "file") throw new FsError("EISDIR", "path is a directory", { path });
    if (size === inode.size) return;
    let plan = planResizeFile(this.#store.state, path, size, nowMs, "truncate");
    let preparedCommit = this.#preflightCommit(plan.record);
    if (size > inode.size) {
      const buildPlan = () => {
        const current = getInodeAtPath(this.#store.state, path);
        if (current.kind !== "file") throw new FsError("EISDIR", "path is a directory", { path });
        const currentPlan = planResizeFile(this.#store.state, path, size, nowMs, "truncate");
        return {
          inode: current,
          plan: currentPlan,
          preparedCommit: this.#preflightCommit(currentPlan.record),
          allocated: expandExtentRuns(currentPlan.record.allocated, MAX_EXTENTS_PER_INODE),
          arenaSizeBefore: this.#arenaSizeChecked("arena.size.before-extension"),
        };
      };
      const prepared = this.#prepareAllocationWithQuotaRetry(
        {
          inode,
          plan,
          preparedCommit,
          allocated: expandExtentRuns(plan.record.allocated, MAX_EXTENTS_PER_INODE),
          arenaSizeBefore: this.#arenaSizeChecked("arena.size.before-extension"),
        },
        buildPlan,
      );
      inode = prepared.inode;
      plan = prepared.plan;
      preparedCommit = prepared.preparedCommit;
      const touchedExisting = this.#zeroLogical(
        inode.extents,
        inode.size,
        size - inode.size,
        prepared.arenaSizeBefore,
        prepared.allocated,
      );
      if (touchedExisting) this.#flushPreparedArena("arena.gap-zero.flush");
    }
    this.#commit(plan.record, preparedCommit);
  }

  open(path: string, flags = "r", mode = 0o100666, nowMs = 0n): number {
    this.#assertOpen();
    const parsed = this.#parseFlags(flags);
    let inode: FileInode;
    try {
      const found = getInodeAtPath(this.#store.state, path);
      if (found.kind !== "file") throw new FsError("EISDIR", "path is a directory", { path });
      if (parsed.exclusive && parsed.create) throw new FsError("EEXIST", "path already exists", { path });
      inode = found;
      if (parsed.truncate) {
        this.truncate(path, 0n, nowMs);
        inode = getInodeAtPath(this.#store.state, path) as FileInode;
      }
    } catch (cause) {
      if (!(cause instanceof FsError) || cause.code !== FS_ERRNO.ENOENT || !parsed.create) throw cause;
      this.#commit(planCreateFile(this.#store.state, path, { mode, nowMs, size: 0n }).record);
      inode = getInodeAtPath(this.#store.state, path) as FileInode;
    }
    const fd = this.#nextDescriptor++;
    this.#descriptors.set(fd, {
      inodeId: inode.id,
      offset: parsed.append ? inode.size : 0n,
      readable: parsed.readable,
      writable: parsed.writable,
      append: parsed.append,
    });
    return fd;
  }

  fstat(fd: number): RepackedStat {
    this.#assertOpen();
    const descriptor = this.#descriptor(fd);
    const inode = descriptor.orphan ?? this.#linkedFile(descriptor.inodeId);
    return this.#statValue(inode);
  }

  read(fd: number, buffer: Uint8Array, offset: number, length: number, position?: bigint): number {
    this.#assertOpen();
    this.#validateBufferRange(buffer, offset, length);
    const descriptor = this.#descriptor(fd);
    if (!descriptor.readable) throw new FsError("EBADF", "descriptor is not readable");
    const inode = descriptor.orphan ?? this.#linkedFile(descriptor.inodeId);
    const start = position ?? descriptor.offset;
    if (start < 0n) throw new FsError("EINVAL", "read position is negative");
    const available = start >= inode.size ? 0 : Math.min(length, checkedSafeNumber(inode.size - start, "read length"));
    if (available > 0) this.#readLogical(inode.extents, start, buffer.subarray(offset, offset + available));
    if (position === undefined) descriptor.offset = start + BigInt(available);
    return available;
  }

  write(
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: bigint | undefined,
    nowMs: bigint,
  ): number {
    this.#assertOpen();
    this.#validateBufferRange(buffer, offset, length);
    checkedU64(nowMs, "timestamp");
    const descriptor = this.#descriptor(fd);
    if (!descriptor.writable) throw new FsError("EBADF", "descriptor is not writable");
    if (descriptor.orphan !== undefined) {
      return this.#writeOrphan(descriptor, buffer.subarray(offset, offset + length), position, nowMs);
    }
    let inode = this.#linkedFile(descriptor.inodeId);
    const start = descriptor.append ? inode.size : (position ?? descriptor.offset);
    if (start < 0n) throw new FsError("EINVAL", "write position is negative");
    if (length === 0) return 0;
    const requestedEnd = checkedAdd(start, BigInt(length), "write end");
    let admittedLength = length;
    let allocated: readonly bigint[] = [];
    let plan: ReturnType<typeof planResizeFile> | undefined;
    let preparedCommit: PreparedCommit | undefined;
    if (requestedEnd > inode.size) {
      const buildPlan = () => {
        const current = this.#linkedFile(descriptor.inodeId);
        const admitted = this.#planLinkedWrite(current, start, length, nowMs);
        return {
          inode: current,
          admitted,
          allocated:
            admitted.plan === undefined ? [] : expandExtentRuns(admitted.plan.record.allocated, MAX_EXTENTS_PER_INODE),
          arenaSizeBefore: start > current.size ? this.#arenaSizeChecked("arena.size.before-write-extension") : 0,
        };
      };
      const prepared = this.#prepareAllocationWithQuotaRetry(buildPlan(), buildPlan);
      inode = prepared.inode;
      plan = prepared.admitted.plan;
      preparedCommit = prepared.admitted.preparedCommit;
      admittedLength = prepared.admitted.length;
      if (plan !== undefined) {
        allocated = prepared.allocated;
        if (start > inode.size) {
          const touchedExisting = this.#zeroLogical(
            inode.extents,
            inode.size,
            start - inode.size,
            prepared.arenaSizeBefore,
            allocated,
          );
          if (touchedExisting) this.#flushPreparedArena("arena.gap-zero.flush");
        }
      }
    }
    const source = buffer.subarray(offset, offset + admittedLength);
    const progress = this.#writeLogical(inode.extents, start, source, "arena.write", allocated);
    if (progress.bytes === 0) throw progress.error;
    const completedEnd = checkedAdd(start, BigInt(progress.bytes), "completed write end");
    if (completedEnd > inode.size) {
      const committedPlan =
        plan !== undefined && completedEnd === plan.record.size
          ? plan
          : planResizeFileForInode(this.#store.state, inode, completedEnd, nowMs, "write");
      this.#commit(committedPlan.record, committedPlan === plan ? preparedCommit : undefined);
    }
    if (position === undefined) descriptor.offset = completedEnd;
    return progress.bytes;
  }

  chmod(path: string, mode: number, nowMs: bigint): void {
    this.#assertOpen();
    this.#commit(planChmod(this.#store.state, path, mode, nowMs).record);
  }

  utimes(path: string, atimeMs: bigint, mtimeMs: bigint, ctimeMs: bigint): void {
    this.#assertOpen();
    this.#commit(planUtimes(this.#store.state, path, atimeMs, mtimeMs, ctimeMs).record);
  }

  unlink(path: string, nowMs: bigint): void {
    this.#assertOpen();
    const inode = getInodeAtPath(this.#store.state, path);
    if (inode.kind !== "file") throw new FsError("EISDIR", "path is a directory", { path });
    const affected = [...this.#descriptors.values()].filter(
      (descriptor) => descriptor.orphan === undefined && descriptor.inodeId === inode.id,
    );
    const orphan = affected.length > 0 ? makeOrphanRecord(inode) : undefined;
    this.#commit(planUnlink(this.#store.state, path, nowMs).record);
    if (orphan !== undefined) for (const descriptor of affected) descriptor.orphan = orphan;
  }

  rmdir(path: string, nowMs: bigint): void {
    this.#assertOpen();
    this.#commit(planRmdir(this.#store.state, path, nowMs).record);
  }

  rename(oldPath: string, newPath: string, nowMs: bigint): void {
    this.#assertOpen();
    let destination: FileInode | undefined;
    try {
      const inode = getInodeAtPath(this.#store.state, newPath);
      if (inode.kind === "file") destination = inode;
    } catch (cause) {
      if (!(cause instanceof FsError) || cause.code !== FS_ERRNO.ENOENT) throw cause;
    }
    const affected =
      destination === undefined
        ? []
        : [...this.#descriptors.values()].filter(
            (descriptor) => descriptor.orphan === undefined && descriptor.inodeId === destination.id,
          );
    const orphan = destination !== undefined && affected.length > 0 ? makeOrphanRecord(destination) : undefined;
    this.#commit(planRename(this.#store.state, oldPath, newPath, nowMs).record);
    if (orphan !== undefined) for (const descriptor of affected) descriptor.orphan = orphan;
  }

  close(): void;
  close(fd: number): void;
  close(fd?: number): void {
    if (fd !== undefined) {
      this.#assertOpen();
      if (!this.#descriptors.delete(fd)) throw new FsError("EBADF", "descriptor is invalid");
      return;
    }
    if (this.#status === "closed") return;
    let firstError: unknown;
    if (this.#status === "open") {
      try {
        this.strictSync();
      } catch (cause) {
        firstError = cause;
      }
    } else {
      firstError = new StoreFailedError(this.#failure);
    }
    this.#status = "closed";
    this.#descriptors.clear();
    const closeError = this.#closeHandles();
    firstError ??= closeError;
    if (firstError !== undefined) throw firstError;
  }

  #closeHandles(): unknown {
    let firstError: unknown;
    for (const name of ["metadata-b.bin", "metadata-a.bin", "arena.bin", "activation.bin"] as const) {
      try {
        this.#store.handles[name].close();
      } catch (cause) {
        firstError ??= cause;
      }
    }
    return firstError;
  }

  #prepareAllocated(extents: readonly bigint[]): void {
    if (extents.length === 0) return;
    const totalBefore = this.#store.state.allocator.totalExtents;
    const highWaterBefore = this.#store.arenaHighWaterExtents;
    const fresh = extents.filter((extentId) => extentId >= totalBefore);
    const arenaSizeBefore = this.#arenaSizeChecked("arena.size.before-allocation");
    if (fresh.length > 0) {
      const last = fresh[fresh.length - 1]!;
      const requiredExtents = checkedAdd(last, 1n, "arena extent count");
      const requiredEnd = checkedAdd(
        BigInt(ARENA_HEADER_BYTES),
        checkedMultiply(requiredExtents, BigInt(this.#store.state.extentSize), "arena byte length"),
        "arena byte length",
      );
      if (requiredEnd > BigInt(arenaSizeBefore)) {
        this.#arenaDirty = true;
        if (requiredExtents > this.#store.arenaHighWaterExtents) {
          this.#store.arenaHighWaterExtents = requiredExtents;
        }
        try {
          this.#truncateArena(requiredEnd, "arena.grow");
        } catch (cause) {
          if (isQuotaExceeded(cause)) throw new ArenaGrowthQuotaError(cause);
          throw cause;
        }
      }
    }

    const reused = extents.filter((extentId) => extentId < totalBefore || extentId < highWaterBefore);
    if (reused.length === 0) return;
    const zeros = new Uint8Array(Math.min(this.#store.state.extentSize, 64 * 1024));
    for (const extentId of reused) {
      let within = 0;
      while (within < this.#store.state.extentSize) {
        const count = Math.min(zeros.byteLength, this.#store.state.extentSize - within);
        this.#arenaDirty = true;
        this.#writeArenaExact(
          arenaByteOffset(extentId, this.#store.state.extentSize, within),
          zeros.subarray(0, count),
          "arena.allocation.zero",
        );
        this.#recordArenaWrite(count);
        within += count;
      }
    }
    this.#flushPreparedArena("arena.allocation.flush");
  }

  #readLogical(extents: readonly bigint[], position: bigint, target: Uint8Array): void {
    checkedU64(position, "read position");
    let completed = 0;
    while (completed < target.byteLength) {
      const logical = checkedAdd(position, BigInt(completed), "read position");
      const extentIndex = checkedSafeNumber(logical / BigInt(this.#store.state.extentSize), "extent index");
      const extentId = this.#extentAt(extents, [], extentIndex);
      if (extentId === undefined) throw new CorruptStoreError("file metadata does not cover its visible data");
      const within = Number(logical % BigInt(this.#store.state.extentSize));
      const count = Math.min(target.byteLength - completed, this.#store.state.extentSize - within);
      let extentCompleted = 0;
      while (extentCompleted < count) {
        const read = this.#store.handles["arena.bin"].read(
          target.subarray(completed + extentCompleted, completed + count),
          checkedSafeNumber(
            arenaByteOffset(extentId, this.#store.state.extentSize, within + extentCompleted),
            "arena read offset",
          ),
          "arena.read",
        );
        if (!Number.isSafeInteger(read) || read <= 0 || read > count - extentCompleted) {
          throw new CorruptStoreError("arena data ended before the visible file range");
        }
        extentCompleted += read;
      }
      completed += count;
    }
  }

  #writeLogical(
    extents: readonly bigint[],
    position: bigint,
    source: Uint8Array,
    label: string,
    allocated: readonly bigint[] = [],
  ): WriteProgress {
    checkedU64(position, "write position");
    let completed = 0;
    while (completed < source.byteLength) {
      const logical = checkedAdd(position, BigInt(completed), "write position");
      const extentIndex = checkedSafeNumber(logical / BigInt(this.#store.state.extentSize), "extent index");
      const extentId = this.#extentAt(extents, allocated, extentIndex);
      if (extentId === undefined) throw new StoreLimitError("planned extents do not cover the write range");
      const within = Number(logical % BigInt(this.#store.state.extentSize));
      const requested = Math.min(source.byteLength - completed, this.#store.state.extentSize - within);
      try {
        this.#arenaDirty = true;
        const written = this.#writeArena(
          source.subarray(completed, completed + requested),
          checkedSafeNumber(arenaByteOffset(extentId, this.#store.state.extentSize, within), "arena write offset"),
          label,
        );
        if (!Number.isSafeInteger(written) || written <= 0 || written > requested) {
          throw new PortWriteError(label);
        }
        this.#recordArenaWrite(written);
        completed += written;
      } catch (error) {
        return { bytes: completed, error };
      }
    }
    return { bytes: completed };
  }

  #zeroLogical(
    extents: readonly bigint[],
    position: bigint,
    length: bigint,
    arenaSizeBefore: number,
    allocated: readonly bigint[] = [],
  ): boolean {
    checkedU64(position, "zero position");
    checkedU64(length, "zero length");
    const zeros = new Uint8Array(64 * 1024);
    const previousEnd = BigInt(arenaSizeBefore);
    let completed = 0n;
    let touchedExisting = false;
    while (completed < length) {
      const logical = checkedAdd(position, completed, "zero position");
      const extentIndex = checkedSafeNumber(logical / BigInt(this.#store.state.extentSize), "extent index");
      const extentId = this.#extentAt(extents, allocated, extentIndex);
      if (extentId === undefined) throw new StoreLimitError("planned extents do not cover the zero range");
      const within = Number(logical % BigInt(this.#store.state.extentSize));
      const remainingInExtent = this.#store.state.extentSize - within;
      const count = Math.min(
        zeros.byteLength,
        remainingInExtent,
        checkedSafeNumber(length - completed, "remaining zero length"),
      );
      const physical = arenaByteOffset(extentId, this.#store.state.extentSize, within);
      if (physical < previousEnd) {
        const existingCount = Math.min(count, checkedSafeNumber(previousEnd - physical, "existing zero length"));
        this.#arenaDirty = true;
        this.#writeArenaExact(physical, zeros.subarray(0, existingCount), "arena.gap-zero.write");
        this.#recordArenaWrite(existingCount);
        touchedExisting = true;
      }
      completed += BigInt(count);
    }
    return touchedExisting;
  }

  #extentAt(head: readonly bigint[], tail: readonly bigint[], index: number): bigint | undefined {
    return index < head.length ? head[index] : tail[index - head.length];
  }

  #planLinkedWrite(
    inode: FileInode,
    start: bigint,
    requestedLength: number,
    nowMs: bigint,
  ): {
    length: number;
    plan: ReturnType<typeof planResizeFile> | undefined;
    preparedCommit: PreparedCommit | undefined;
  } {
    const attempt = (
      length: number,
    ): { plan: ReturnType<typeof planResizeFile>; preparedCommit: PreparedCommit } | undefined => {
      const end = checkedAdd(start, BigInt(length), "write end");
      if (end <= inode.size) return undefined;
      const plan = planResizeFileForInode(this.#store.state, inode, end, nowMs, "write");
      return { plan, preparedCommit: this.#preflightCommit(plan.record) };
    };
    try {
      const admitted = attempt(requestedLength);
      return {
        length: requestedLength,
        plan: admitted?.plan,
        preparedCommit: admitted?.preparedCommit,
      };
    } catch (cause) {
      if (!(cause instanceof StoreLimitError)) throw cause;
      let low = 0;
      let high = requestedLength - 1;
      let admitted = 0;
      let admittedPlan: ReturnType<typeof planResizeFile> | undefined;
      let admittedCommit: PreparedCommit | undefined;
      while (low <= high) {
        const candidate = low + Math.floor((high - low) / 2);
        try {
          const candidatePlan = attempt(candidate);
          admitted = candidate;
          admittedPlan = candidatePlan?.plan;
          admittedCommit = candidatePlan?.preparedCommit;
          low = candidate + 1;
        } catch (candidateCause) {
          if (!(candidateCause instanceof StoreLimitError)) throw candidateCause;
          high = candidate - 1;
        }
      }
      if (admitted === 0) throw cause;
      return { length: admitted, plan: admittedPlan, preparedCommit: admittedCommit };
    }
  }

  #writeOrphan(descriptor: Descriptor, source: Uint8Array, position: bigint | undefined, nowMs: bigint): number {
    const orphan = descriptor.orphan!;
    const start = descriptor.append ? orphan.size : (position ?? descriptor.offset);
    if (start < 0n) throw new FsError("EINVAL", "write position is negative");
    if (source.byteLength === 0) return 0;
    const buildPlan = () => {
      const admitted = this.#planOrphanWrite(orphan, start, source.byteLength);
      return {
        admitted,
        allocated:
          admitted.reservation === undefined
            ? []
            : expandExtentRuns(admitted.reservation.record.extents, MAX_EXTENTS_PER_INODE),
        arenaSizeBefore: this.#arenaSizeChecked("arena.size.before-orphan-extension"),
      };
    };
    const prepared = this.#prepareAllocationWithQuotaRetry(buildPlan(), buildPlan);
    const { admitted, allocated, arenaSizeBefore } = prepared;
    if (admitted.reservation !== undefined) {
      this.#commit(admitted.reservation.record);
      orphan.extents.push(...allocated);
    }
    if (start > orphan.size) {
      const touchedExisting = this.#zeroLogical(orphan.extents, orphan.size, start - orphan.size, arenaSizeBefore);
      if (touchedExisting) this.#flushPreparedArena("arena.gap-zero.flush");
    }
    const progress = this.#writeLogical(orphan.extents, start, source.subarray(0, admitted.length), "arena.write");
    if (progress.bytes === 0) throw progress.error;
    const completedEnd = checkedAdd(start, BigInt(progress.bytes), "completed orphan write end");
    if (completedEnd > orphan.size) orphan.size = completedEnd;
    orphan.mtimeMs = nowMs;
    orphan.ctimeMs = nowMs;
    if (position === undefined) descriptor.offset = completedEnd;
    return progress.bytes;
  }

  #planOrphanWrite(
    orphan: OrphanRecord,
    start: bigint,
    requestedLength: number,
  ): { length: number; reservation: ReturnType<typeof planReserveQuarantine> | undefined } {
    const attempt = (length: number): ReturnType<typeof planReserveQuarantine> | undefined => {
      const end = checkedAdd(start, BigInt(length), "orphan write end");
      const required = this.#extentCount(end);
      const additional = Math.max(0, required - orphan.extents.length);
      if (additional === 0) return undefined;
      const reservation = planReserveQuarantine(this.#store.state, additional);
      this.#preflightCommit(reservation.record);
      return reservation;
    };
    try {
      return { length: requestedLength, reservation: attempt(requestedLength) };
    } catch (cause) {
      if (!(cause instanceof StoreLimitError)) throw cause;
      let low = 0;
      let high = requestedLength - 1;
      let admitted = 0;
      let reservation: ReturnType<typeof planReserveQuarantine> | undefined;
      while (low <= high) {
        const candidate = low + Math.floor((high - low) / 2);
        try {
          const candidateReservation = attempt(candidate);
          admitted = candidate;
          reservation = candidateReservation;
          low = candidate + 1;
        } catch (candidateCause) {
          if (!(candidateCause instanceof StoreLimitError)) throw candidateCause;
          high = candidate - 1;
        }
      }
      if (admitted === 0) throw cause;
      return { length: admitted, reservation };
    }
  }

  #extentCount(size: bigint): number {
    checkedU64(size, "file size");
    if (size === 0n) return 0;
    const count = (size + BigInt(this.#store.state.extentSize) - 1n) / BigInt(this.#store.state.extentSize);
    const result = checkedSafeNumber(count, "file extent count");
    if (result > MAX_EXTENTS_PER_INODE) {
      throw new StoreLimitError(`file extent count exceeds ${MAX_EXTENTS_PER_INODE}`);
    }
    return result;
  }

  #parseFlags(flags: string): ParsedFlags {
    const parsed: Record<string, ParsedFlags> = {
      r: { readable: true, writable: false, create: false, exclusive: false, truncate: false, append: false },
      "r+": { readable: true, writable: true, create: false, exclusive: false, truncate: false, append: false },
      w: { readable: false, writable: true, create: true, exclusive: false, truncate: true, append: false },
      "w+": { readable: true, writable: true, create: true, exclusive: false, truncate: true, append: false },
      wx: { readable: false, writable: true, create: true, exclusive: true, truncate: true, append: false },
      "wx+": { readable: true, writable: true, create: true, exclusive: true, truncate: true, append: false },
      a: { readable: false, writable: true, create: true, exclusive: false, truncate: false, append: true },
      "a+": { readable: true, writable: true, create: true, exclusive: false, truncate: false, append: true },
      ax: { readable: false, writable: true, create: true, exclusive: true, truncate: false, append: true },
      "ax+": { readable: true, writable: true, create: true, exclusive: true, truncate: false, append: true },
    };
    const result = parsed[flags];
    if (result === undefined) throw new FsError("EINVAL", `unsupported open flags: ${flags}`);
    return result;
  }

  #validateEncoding(encoding: string, path: string): "utf8" {
    if (encoding !== "utf8" && encoding !== "utf-8") {
      throw new FsError("EINVAL", `unsupported writeFile encoding: ${encoding}`, { operation: "writeFile", path });
    }
    return "utf8";
  }

  #flushPreparedArena(label: string): void {
    this.#flush(this.#store.handles["arena.bin"], label, "zeroBarrier");
    this.#arenaDirty = false;
    this.#arenaDirtyBytesSinceFlush = 0;
  }

  #recordArenaWrite(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new TypeError("arena dirty byte count is invalid");
    this.#arenaDirtyBytesSinceFlush = Math.min(Number.MAX_SAFE_INTEGER, this.#arenaDirtyBytesSinceFlush + bytes);
  }

  #arenaSizeChecked(label: string): number {
    if (this.#arenaSize !== undefined) return this.#arenaSize;
    const size = this.#store.handles["arena.bin"].getSize(label);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`${label} returned an invalid arena size`);
    this.#arenaSize = size;
    return size;
  }

  #writeArena(source: Uint8Array, at: number, label: string): number {
    const sizeBefore = this.#arenaSize;
    this.#arenaSize = undefined;
    const written = this.#store.handles["arena.bin"].write(source, at, label);
    if (sizeBefore !== undefined && Number.isSafeInteger(written) && written >= 0 && written <= source.byteLength) {
      const end = at + written;
      if (!Number.isSafeInteger(end)) return written;
      this.#arenaSize = Math.max(sizeBefore, end);
    }
    return written;
  }

  #writeArenaExact(at: bigint, source: Uint8Array, label: string): void {
    const sizeBefore = this.#arenaSize;
    this.#arenaSize = undefined;
    writeExact(this.#store.handles["arena.bin"], at, source, label);
    if (sizeBefore !== undefined) {
      this.#arenaSize = Math.max(
        sizeBefore,
        checkedSafeNumber(checkedAdd(at, BigInt(source.byteLength), "arena write end"), "arena write end"),
      );
    }
  }

  #truncateArena(size: bigint, label: string): void {
    this.#arenaSize = undefined;
    truncateChecked(this.#store.handles["arena.bin"], size, label);
    this.#arenaSize = checkedSafeNumber(size, "arena truncate size");
  }

  #flush(handle: RepackedFileHandle, label: string, kind: FlushKind): void {
    this.#flushes[kind] += 1;
    handle.flush(label);
  }

  #prepareAllocationWithQuotaRetry<T extends { allocated: readonly bigint[] }>(initial: T, retry: () => T): T {
    try {
      this.#prepareAllocated(initial.allocated);
      return initial;
    } catch (cause) {
      if (!(cause instanceof ArenaGrowthQuotaError)) throw cause;
      this.repack("quota");
      this.repack("quota");
      const retried = retry();
      try {
        this.#prepareAllocated(retried.allocated);
      } catch (retryCause) {
        if (retryCause instanceof ArenaGrowthQuotaError) throw retryCause.cause;
        throw retryCause;
      }
      return retried;
    }
  }

  #descriptor(fd: number): Descriptor {
    if (!Number.isSafeInteger(fd)) throw new FsError("EBADF", "descriptor is invalid");
    const descriptor = this.#descriptors.get(fd);
    if (descriptor === undefined) throw new FsError("EBADF", "descriptor is invalid");
    return descriptor;
  }

  #linkedFile(inodeId: bigint): FileInode {
    const inode = this.#store.state.inodes.get(inodeId);
    if (inode?.kind !== "file") throw new FsError("EBADF", "descriptor no longer references a file");
    return inode;
  }

  #statValue(
    inode:
      | FileInode
      | OrphanRecord
      | { kind: "directory"; mode: number; atimeMs: bigint; mtimeMs: bigint; ctimeMs: bigint },
  ): RepackedStat {
    const kind = "kind" in inode ? inode.kind : "file";
    return {
      kind,
      mode: inode.mode,
      size: kind === "file" ? (inode as FileInode | OrphanRecord).size : 0n,
      atimeMs: inode.atimeMs,
      mtimeMs: inode.mtimeMs,
      ctimeMs: inode.ctimeMs,
    };
  }

  #validateBufferRange(buffer: Uint8Array, offset: number, length: number): void {
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0 ||
      offset + length > buffer.byteLength
    ) {
      throw new FsError("EINVAL", "buffer range is invalid");
    }
  }

  #preflightCommit(record: TxnRecord): PreparedCommit {
    this.#assertOpen();
    const projection = prepareTxnProjection(this.#store.state, record);
    const deferResize = this.#isDeferrableResize(record);
    const pending = this.#pendingResizeCommit;
    const replacesPendingResize =
      deferResize && pending !== undefined && record.kind === "resizeFile" && pending.record.inodeId === record.inodeId;
    const materializedRecord: TxnRecord = replacesPendingResize
      ? {
          ...record,
          allocated: mergeExtentRuns(pending.record.allocated, record.allocated),
        }
      : record;
    const sequence = replacesPendingResize ? pending.sequence : this.#store.nextSequence;
    const frameBytes = txnFrameBytes(materializedRecord);
    const frame = deferResize
      ? undefined
      : encodeTxnFrame({
          generation: this.#store.state.generation,
          sequence,
          record: materializedRecord,
        });
    const projectedLogBytes = replacesPendingResize
      ? this.#store.activeLogBytes - pending.frameBytes + frameBytes
      : this.#store.activeLogBytes + frameBytes;
    if (
      (!replacesPendingResize && this.#store.activeLogFrames >= MAX_ACTIVE_LOG_FRAMES) ||
      projectedLogBytes > MAX_ACTIVE_LOG_BYTES
    ) {
      throw new StoreLimitError("active metadata log reached its hard limit");
    }
    return {
      frame,
      frameBytes,
      projection,
      materializedRecord,
      deferResize,
      replacesPendingResize,
    };
  }

  #commit(record: TxnRecord, preparedCommit?: PreparedCommit): void {
    this.#assertOpen();
    const prepared = preparedCommit ?? this.#preflightCommit(record);
    if (prepared.replacesPendingResize) {
      const pending = this.#pendingResizeCommit;
      if (pending === undefined || prepared.materializedRecord.kind !== "resizeFile") {
        const cause = new Error("pending resize preflight no longer matches live state");
        this.#poison(cause);
        throw cause;
      }
      try {
        applyTxn(this.#store.state, record, prepared.projection);
      } catch (cause) {
        this.#poison(cause);
        throw cause;
      }
      this.#store.activeLogBytes += prepared.frameBytes - pending.frameBytes;
      this.#pendingResizeCommit = {
        record: prepared.materializedRecord,
        frameBytes: prepared.frameBytes,
        sequence: pending.sequence,
      };
      this.#scheduleRepack();
      return;
    }

    this.#materializePendingResize();
    if (prepared.deferResize && prepared.materializedRecord.kind === "resizeFile") {
      try {
        applyTxn(this.#store.state, record, prepared.projection);
      } catch (cause) {
        this.#poison(cause);
        throw cause;
      }
      this.#pendingResizeCommit = {
        record: prepared.materializedRecord,
        frameBytes: prepared.frameBytes,
        sequence: this.#store.nextSequence,
      };
      this.#store.activeLogBytes += prepared.frameBytes;
      this.#store.activeLogFrames += 1;
      this.#store.nextSequence += 1n;
      this.#scheduleRepack();
      return;
    }

    if (prepared.frame === undefined) {
      const cause = new Error("immediate commit has no encoded transaction frame");
      this.#poison(cause);
      throw cause;
    }
    this.#appendFrame(prepared.frame);
    try {
      applyTxn(this.#store.state, record, prepared.projection);
    } catch (cause) {
      this.#poison(cause);
      throw cause;
    }
    this.#store.activeLogBytes += prepared.frameBytes;
    this.#store.activeLogFrames += 1;
    this.#store.nextSequence += 1n;
    this.#scheduleRepack();
  }

  #isDeferrableResize(record: TxnRecord): record is Extract<TxnRecord, { kind: "resizeFile" }> {
    if (record.kind !== "resizeFile" || record.operation !== "write") return false;
    const inode = this.#store.state.inodes.get(record.inodeId);
    return inode?.kind === "file" && record.size > inode.size;
  }

  #appendFrame(frame: Uint8Array): void {
    const activeName = metadataFileName(this.#store.state.activeMetadataFile);
    try {
      writeExact(this.#store.handles[activeName], this.#store.activeLogEnd, frame, "metadata.log.append");
      this.#metadataDirtySinceFlush = true;
      this.#store.activeLogEnd += BigInt(frame.byteLength);
    } catch (cause) {
      this.#poison(cause);
      throw cause;
    }
  }

  #materializePendingResize(): void {
    const pending = this.#pendingResizeCommit;
    if (pending === undefined) return;
    let frame: Uint8Array;
    try {
      frame = encodeTxnFrame({
        generation: this.#store.state.generation,
        sequence: pending.sequence,
        record: pending.record,
      });
      if (frame.byteLength !== pending.frameBytes) {
        throw new Error("pending resize frame length changed after preflight");
      }
    } catch (cause) {
      this.#poison(cause);
      throw cause;
    }
    this.#appendFrame(frame);
    this.#pendingResizeCommit = undefined;
  }

  #scheduleRepack(): void {
    if (this.#store.activeLogBytes >= SOFT_ACTIVE_LOG_BYTES) {
      this.#pendingRepackReason = "log-bytes";
    } else if (this.#store.activeLogFrames >= SOFT_ACTIVE_LOG_FRAMES) {
      this.#pendingRepackReason = "log-frames";
    } else if (this.#store.state.basePayloadBytes >= BASE_REPACK_PRESSURE_BYTES) {
      this.#pendingRepackReason = "writer-limit";
    } else if (
      this.#store.state.allocator.quarantine.size >= QUARANTINE_PRESSURE_EXTENTS ||
      (this.#store.state.allocator.quarantine.size > 0 && this.#store.state.allocator.available.size === 0)
    ) {
      this.#pendingRepackReason ??= "quarantine-pressure";
    }
  }

  #dueRepackReason(nowMs: number): RepackReason | null {
    if (this.#pendingRepackReason !== null) return this.#pendingRepackReason;
    if (this.#store.activeLogBytes >= SOFT_ACTIVE_LOG_BYTES) return "log-bytes";
    if (this.#store.activeLogFrames >= SOFT_ACTIVE_LOG_FRAMES) return "log-frames";
    if (this.#store.state.basePayloadBytes >= BASE_REPACK_PRESSURE_BYTES) {
      return "writer-limit";
    }
    return this.#store.activeLogFrames > 0 && nowMs - this.#lastRepackAtMs >= REPACK_INTERVAL_MS ? "time" : null;
  }

  #assertOpen(): void {
    if (this.#status === "failed") throw new StoreFailedError(this.#failure);
    if (this.#status === "closed") throw new StoreClosedError();
  }

  #poison(cause: unknown): void {
    if (this.#status === "open") {
      this.#status = "failed";
      this.#failure = cause;
    }
  }
}
