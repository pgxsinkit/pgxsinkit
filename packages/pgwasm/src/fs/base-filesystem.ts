// Began as a copy of `@electric-sql/pglite` (taken under its PostgreSQL License option, © ElectricSQL
// — see NOTICE). Owned outright (ADR-0062); compatibility with PGlite is an anti-goal — evolve freely.

/** Stat results, in the shape a POSIX `stat` returns them. Times are milliseconds since the epoch. */
export interface FsStats {
  dev: number;
  ino: number;
  mode: number;
  nlink: number;
  uid: number;
  gid: number;
  rdev: number;
  size: number;
  blksize: number;
  blocks: number;
  atime: number;
  mtime: number;
  ctime: number;
}

/**
 * Errno values, in the numbering Postgres builds use (Emscripten's). A filesystem reports a failed
 * operation by throwing an error whose `code` is one of these; an error without a `code` is reported to
 * Postgres as `EIO`.
 */
export const ERRNO_CODES = {
  EBADF: 8,
  EBADFD: 127,
  EEXIST: 20,
  EINVAL: 28,
  EIO: 29,
  EISDIR: 31,
  ENODEV: 43,
  ENOENT: 44,
  ENOTDIR: 54,
  ENOTEMPTY: 55,
} as const;

/**
 * A filesystem call that failed and was reported to Postgres as an errno. Kept in a small ring so
 * that when Postgres later fails, the storage failures underneath it are visible.
 */
export interface SyscallError {
  readonly op: string;
  readonly path: string;
  readonly errno: number;
  readonly message: string;
  readonly timeMs: number;
}

const MAX_SYSCALL_ERRORS = 50;

/**
 * What a filesystem says about itself, reported in `pg.storage` as `{ kind: "vfs", ...description }`:
 * a short name for diagnostics, and whether what it holds survives the process (or the page) that wrote it.
 */
export interface FilesystemDescription {
  /** A short name for diagnostics, e.g. `opfs-repacked`. */
  readonly name: string;
  /**
   * Whether the data directory outlives the process (or page) that wrote it. Absent when the filesystem
   * doesn't say: nothing outside it can tell, so callers treat an undeclared filesystem as the author's
   * own call rather than as non-persistent.
   */
  readonly persistent?: boolean;
}

const DEFAULT_DESCRIPTION: FilesystemDescription = Object.freeze({ name: "custom" });

/**
 * A synchronous virtual filesystem that holds a data directory, mounted by a Postgres build in place
 * of its built-in storage (pass it as `createPgwasm({ fs })`). Paths are absolute within the
 * filesystem, `/`-separated, `/` being the data directory itself.
 *
 * Besides the POSIX-shaped operations, a filesystem takes part in durability: pgwasm calls
 * `syncToFs(relaxed)` after statements (see `createPgwasm`'s `relaxedDurability`), the build calls
 * `initialSyncFs()` once when it mounts the filesystem, `closeFs()` when the database closes and
 * `cleanupFailedInit()` when a boot fails after the filesystem was handed over.
 */
export abstract class BaseFilesystem {
  readonly debug: boolean;
  readonly #recentSyscallErrors: SyscallError[] = [];

  constructor({ debug = false }: { debug?: boolean } = {}) {
    this.debug = debug;
  }

  /**
   * What this filesystem is, as `pg.storage` reports it. Defaults to `{ name: "custom" }`, persistence
   * undeclared: a filesystem overrides it to name itself and to say whether its data outlives the process
   * (`persistent: true`) or not (`persistent: false`), since nothing else can tell.
   */
  get description(): FilesystemDescription {
    return DEFAULT_DESCRIPTION;
  }

  /** The most recent failed filesystem calls reported to Postgres (up to 50), oldest first. */
  get recentSyscallErrors(): readonly SyscallError[] {
    return this.#recentSyscallErrors;
  }

  /** Record a failed call. The build's mount calls this where it turns a thrown error into an errno. */
  recordSyscallError(op: string, path: string, errno: number, message: string): void {
    const buffer = this.#recentSyscallErrors;
    buffer.push({ op, path, errno, message, timeMs: Date.now() });
    if (buffer.length > MAX_SYSCALL_ERRORS) {
      buffer.shift();
    }
    if (this.debug) {
      console.warn("[pgwasm-fs] syscall error", op, path, errno, message);
    }
  }

  /** Make everything written so far durable. `relaxed` is pgwasm's background persist. */
  async syncToFs(_relaxed?: boolean): Promise<void> {}

  /** Called once when the build mounts the filesystem, before anything reads it. */
  async initialSyncFs(): Promise<void> {}

  /** Release everything the filesystem holds. Called when the database closes. */
  async closeFs(): Promise<void> {}

  /** Release what the filesystem holds after a boot failed. Defaults to {@link closeFs}. */
  async cleanupFailedInit(): Promise<void> {
    await this.closeFs();
  }

  abstract chmod(path: string, mode: number): void;
  abstract close(fd: number): void;
  abstract fstat(fd: number): FsStats;
  abstract lstat(path: string): FsStats;
  abstract mkdir(path: string, options?: { recursive?: boolean; mode?: number }): void;
  abstract open(path: string, flags?: string, mode?: number): number;
  abstract readdir(path: string): string[];
  /** Read into `buffer[offset, offset + length)` from `position`; returns the bytes read. */
  abstract read(fd: number, buffer: Uint8Array, offset: number, length: number, position: number): number;
  abstract rename(oldPath: string, newPath: string): void;
  abstract rmdir(path: string): void;
  abstract truncate(path: string, length: number): void;
  abstract unlink(path: string): void;
  abstract utimes(path: string, atime: number, mtime: number): void;
  abstract writeFile(
    path: string,
    data: string | Uint8Array,
    options?: { encoding?: string; mode?: number; flag?: string },
  ): void;
  /** Write `buffer[offset, offset + length)` at `position`; returns the bytes written. */
  abstract write(fd: number, buffer: Uint8Array, offset: number, length: number, position: number): number;
}
