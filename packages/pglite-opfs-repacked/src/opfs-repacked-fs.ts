import { BaseFilesystem } from "@electric-sql/pglite/basefs";
import type { FsStats } from "@electric-sql/pglite/basefs";

import { DurabilityModeMismatchError, StoreLimitError } from "./core/errors";
import type { RepackedPort } from "./core/port";
import { RepackedVfs } from "./core/repacked-vfs";
import type { RepackedStat } from "./core/repacked-vfs";

/** Physical durability selected once for the lifetime of a factory-owned store. */
export type RepackedDurability = "relaxed" | "strict";

export interface RepackedFilesystemOptions {
  /** Creation extent size: 8 KiB–16 MiB in 8 KiB steps. Defaults to 64 KiB. */
  readonly extentSize?: number;
  /** Physical durability for this instance. Defaults to `"relaxed"`. */
  readonly durability?: RepackedDurability;
}

/**
 * PGlite filesystem adapter owned by `createOpfsRepackedPGlite`.
 *
 * Direct construction is unsupported. The factory retains this adapter so it
 * can close all four handles when host initialization or shutdown fails.
 */
export abstract class OpfsRepackedFS extends BaseFilesystem {
  readonly #vfs: RepackedVfs;
  readonly #durability: RepackedDurability;

  protected constructor(vfs: RepackedVfs, durability: RepackedDurability) {
    super();
    this.#vfs = vfs;
    this.#durability = durability;
  }

  override async initialSyncFs(): Promise<void> {
    this.#vfs.assertHealthy();
  }

  override async syncToFs(relaxedDurability = false): Promise<void> {
    this.#vfs.assertHealthy();
    if (relaxedDurability) this.#vfs.fail(new DurabilityModeMismatchError());
    this.#vfs.runScheduledRepack();
    if (this.#durability === "strict") this.#vfs.strictSync();
  }

  /** Stabilize every preceding data and metadata operation in strict order. */
  strictSync(): void {
    this.#vfs.strictSync();
  }

  /** @internal Factory lifecycle cleanup after host initialization fails. */
  async cleanupFailedInit(): Promise<void> {
    this.#vfs.cleanupFailedInit();
  }

  override async closeFs(): Promise<void> {
    this.#vfs.close();
  }

  chmod(path: string, mode: number): void {
    this.#vfs.chmod(hostPath(path), mode, nowMs());
  }

  close(fd: number): void {
    this.#vfs.close(fd);
  }

  fstat(fd: number): FsStats {
    return toFsStats(this.#vfs.fstat(fd));
  }

  lstat(path: string): FsStats {
    return toFsStats(this.#vfs.lstat(hostPath(path)));
  }

  mkdir(path: string, options?: { recursive?: boolean; mode?: number }): void {
    this.#vfs.mkdir(hostPath(path), {
      ...(options?.recursive === undefined ? {} : { recursive: options.recursive }),
      ...(options?.mode === undefined ? {} : { mode: options.mode }),
      nowMs: nowMs(),
    });
  }

  open(path: string, flags = "r+", mode = 0o100666): number {
    return this.#vfs.open(hostPath(path), flags, mode, nowMs());
  }

  readdir(path: string): string[] {
    return this.#vfs.readdir(hostPath(path));
  }

  read(fd: number, buffer: Uint8Array, offset: number, length: number, position: number): number {
    return this.#vfs.read(fd, buffer, offset, length, toFileOffset(position));
  }

  rename(oldPath: string, newPath: string): void {
    this.#vfs.rename(hostPath(oldPath), hostPath(newPath), nowMs());
  }

  rmdir(path: string): void {
    this.#vfs.rmdir(hostPath(path), nowMs());
  }

  truncate(path: string, length: number): void {
    this.#vfs.truncate(hostPath(path), toFileOffset(length), nowMs());
  }

  unlink(path: string): void {
    this.#vfs.unlink(hostPath(path), nowMs());
  }

  utimes(path: string, atime: number, mtime: number): void {
    this.#vfs.utimes(hostPath(path), toTimestamp(atime), toTimestamp(mtime), nowMs());
  }

  writeFile(
    path: string,
    data: string | Uint8Array,
    options?: { encoding?: string; mode?: number; flag?: string },
  ): void {
    this.#vfs.writeFile(hostPath(path), data, {
      ...(options?.encoding === undefined ? {} : { encoding: options.encoding }),
      ...(options?.mode === undefined ? {} : { mode: options.mode }),
      ...(options?.flag === undefined ? {} : { flag: options.flag }),
      nowMs: nowMs(),
    });
  }

  write(fd: number, buffer: Uint8Array, offset: number, length: number, position: number): number {
    if (buffer instanceof Uint8Array) {
      return this.#vfs.write(fd, buffer, offset, length, toFileOffset(position), nowMs());
    }
    const source = new Uint8Array(buffer as unknown as ArrayBuffer, offset, length);
    return this.#vfs.write(fd, source, 0, source.byteLength, toFileOffset(position), nowMs());
  }
}

class ConcreteOpfsRepackedFS extends OpfsRepackedFS {
  constructor(vfs: RepackedVfs, durability: RepackedDurability) {
    super(vfs, durability);
  }
}

export async function openOpfsRepackedFsForPort(
  port: RepackedPort,
  options: RepackedFilesystemOptions = {},
): Promise<OpfsRepackedFS> {
  const durability = options.durability ?? "relaxed";
  if (durability !== "relaxed" && durability !== "strict") {
    throw new TypeError(`unsupported OPFS repacked durability: ${String(durability)}`);
  }
  const vfs = await RepackedVfs.open(port, {
    ...(options.extentSize === undefined ? {} : { extentSize: options.extentSize }),
  });
  return new ConcreteOpfsRepackedFS(vfs, durability);
}

function nowMs(): bigint {
  return BigInt(Date.now());
}

function hostPath(path: string): string {
  return path === "" ? "/" : path;
}

function toFileOffset(value: number): bigint {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("file offset is not a non-negative safe integer");
  return BigInt(value);
}

function toTimestamp(value: number): bigint {
  // Emscripten's utime path can pass fractional milliseconds (µs-precision
  // utimensat converted to ms); floor instead of rejecting the syscall.
  const floored = Math.floor(value);
  if (!Number.isSafeInteger(floored) || floored < 0) {
    throw new TypeError("timestamp is not a non-negative finite millisecond value");
  }
  return BigInt(floored);
}

function toFsStats(stat: RepackedStat): FsStats {
  const size = toSafeNumber(stat.size, "file size");
  const blksize = 4096;
  return {
    dev: 0,
    ino: 0,
    mode: stat.mode,
    nlink: 1,
    uid: 0,
    gid: 0,
    rdev: 0,
    size,
    blksize,
    blocks: Math.ceil(size / blksize),
    atime: toSafeNumber(stat.atimeMs, "access time"),
    mtime: toSafeNumber(stat.mtimeMs, "modification time"),
    ctime: toSafeNumber(stat.ctimeMs, "change time"),
  };
}

function toSafeNumber(value: bigint, label: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new StoreLimitError(`${label} exceeds safe integer range`);
  return Number(value);
}
