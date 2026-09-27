/**
 * `MountedRepackedVfs` — one {@link RepackedFileSystem} made of several stores, joined at path
 * prefixes.
 *
 * ## Why
 *
 * A store is a single durable object: four exclusive handles, one arena, one metadata generation.
 * That is exactly right for a datadir and exactly wrong for the parts of a datadir that must NOT be
 * durable — a Postgres temp tablespace, an ephemeral relation, a scratch area whose whole point is
 * that it never reaches the platform. A mount serves one path prefix from a SECOND store, so the
 * durable root and the volatile subtree are one tree to the guest and two stores to the host.
 *
 * ## The shape
 *
 *     /                       -> root store        (OPFS: durable)
 *     /pgdata/...             -> root store
 *     /scratch                -> mount store       (memory: nothing durable)
 *     /scratch/anything/...   -> mount store, as "/anything/..."
 *
 * A mount's prefix is its root: `/scratch/a/b` reaches the mount as `/a/b`, and the prefix itself as
 * `/`. The prefix directory is also created in the ROOT store, so a `readdir` of its parent lists
 * it; every operation AT or BELOW the prefix is answered by the mount, so that root-side directory
 * is a name and nothing more.
 *
 * ## What the composite owns, and what it delegates
 *
 * - **Symlink resolution is the composite's**, because a link is the one thing that can move a path
 *   from one store to another: `pg_tblspc/<oid>` lives in the root and points at `/scratch`, and
 *   neither store alone can resolve it (the root would resolve it against its own placeholder
 *   directory and find nothing there). The fast path is one `resolvePath` call on the store the
 *   path already routes to — if that store says the path holds no link, no link exists on it at
 *   all, because every entry on the path lives in that store. Only a path that really does traverse
 *   a link pays the component-by-component walk.
 * - **Descriptors are the composite's.** Each store numbers its own fds from 3, so the composite
 *   hands out its own numbers and remembers which store each belongs to.
 * - **`rename` across a boundary is `EXDEV`**, exactly as it is between two real filesystems: a
 *   rename is a metadata move inside one store and cannot span two.
 * - **`strictSync()` skips a mount declared non-durable.** A memory-backed mount has nothing to make
 *   durable, and a store-wide sync that walked it would charge the guest for flushes that cannot
 *   protect anything. Durability is a property the STORAGE OWNER declares per mount; nothing here
 *   infers it from the port.
 * - Everything else is a route plus a delegation.
 */

import { FS_ERRNO, FsError } from "./errors";
import { MAX_SYMLINK_HOPS } from "./limits";
import { parsePath } from "./path";
import type { RepackReason, RepackedFileSystem, RepackedStat, RepackedVfsMetrics } from "./repacked-vfs";

/** One store served at one path prefix. */
export interface RepackedMount {
  /** Absolute, canonical, and never `/`: the path the mount's own root appears at. */
  readonly prefix: string;
  readonly vfs: RepackedFileSystem;
  /**
   * Whether a store-wide `strictSync()` reaches this mount. Defaults to `true`. A volatile mount
   * (memory-backed scratch) declares `false`: there is nothing to flush, and pretending otherwise
   * charges every guest `fsync` for it.
   */
  readonly durable?: boolean;
}

export interface MountedRepackedVfsOptions {
  /** The store that answers for every path no mount claims. */
  readonly root: RepackedFileSystem;
  readonly mounts: readonly RepackedMount[];
  /** The clock used to create each mount's placeholder directory in the root. */
  readonly nowMs?: () => bigint;
}

interface ResolvedMount {
  readonly prefix: string;
  readonly boundary: string;
  readonly vfs: RepackedFileSystem;
  readonly durable: boolean;
}

interface Route {
  readonly fs: RepackedFileSystem;
  /** The path as the routed store sees it. */
  readonly path: string;
  /** The mount this route landed on, or `undefined` for the root store. */
  readonly mount: ResolvedMount | undefined;
}

interface MountedDescriptor {
  readonly fs: RepackedFileSystem;
  readonly fd: number;
}

function joinPath(base: string, rest: readonly string[]): string {
  if (rest.length === 0) return base;
  return base === "/" ? `/${rest.join("/")}` : `${base}/${rest.join("/")}`;
}

function isMissing(cause: unknown): boolean {
  return cause instanceof FsError && (cause.code === FS_ERRNO.ENOENT || cause.code === FS_ERRNO.ENOTDIR);
}

export class MountedRepackedVfs implements RepackedFileSystem {
  readonly #root: RepackedFileSystem;
  readonly #mounts: readonly ResolvedMount[];
  readonly #descriptors = new Map<number, MountedDescriptor>();
  #nextDescriptor = 3;

  constructor(options: MountedRepackedVfsOptions) {
    this.#root = options.root;
    const nowMs = (options.nowMs ?? (() => BigInt(Date.now())))();
    const mounts: ResolvedMount[] = [];
    for (const mount of options.mounts) {
      if (parsePath(mount.prefix).length === 0) {
        throw new FsError("EINVAL", "a mount prefix must be an absolute path below the root", {
          path: mount.prefix,
        });
      }
      for (const existing of mounts) {
        if (
          existing.prefix === mount.prefix ||
          mount.prefix.startsWith(existing.boundary) ||
          existing.prefix.startsWith(`${mount.prefix}/`)
        ) {
          throw new FsError("EINVAL", `mount prefix ${mount.prefix} overlaps ${existing.prefix}`, {
            path: mount.prefix,
          });
        }
      }
      mounts.push({
        prefix: mount.prefix,
        boundary: `${mount.prefix}/`,
        vfs: mount.vfs,
        durable: mount.durable ?? true,
      });
    }
    this.#mounts = mounts;
    // The prefix is a NAME in the root store so a listing of its parent shows it; every operation
    // at or below it is answered by the mount, so nothing is ever stored behind that name.
    for (const mount of mounts) {
      try {
        this.#root.mkdir(mount.prefix, { recursive: true, nowMs });
      } catch (cause) {
        if (!(cause instanceof FsError) || cause.code !== FS_ERRNO.EEXIST) throw cause;
      }
    }
  }

  /** The mounts this composite serves, in declaration order. */
  get mounts(): readonly RepackedMount[] {
    return this.#mounts.map((mount) => ({ prefix: mount.prefix, vfs: mount.vfs, durable: mount.durable }));
  }

  /** The store that answers for everything no mount claims. */
  get root(): RepackedFileSystem {
    return this.#root;
  }

  // ---- routing and resolution ---------------------------------------------

  #route(path: string): Route {
    parsePath(path);
    for (const mount of this.#mounts) {
      if (path === mount.prefix) return { fs: mount.vfs, path: "/", mount };
      if (path.startsWith(mount.boundary)) {
        return { fs: mount.vfs, path: path.slice(mount.prefix.length), mount };
      }
    }
    return { fs: this.#root, path, mount: undefined };
  }

  /**
   * The link-free composite path `path` names.
   *
   * The fast path asks the routed store to resolve its own view: a store that reports the path
   * unchanged proves there is no link on it, because every entry on that path lives in that store.
   * Anything else falls through to the careful walk, which resolves one component at a time and can
   * therefore cross a boundary in either direction.
   */
  resolvePath(path: string, follow = true): string {
    const route = this.#route(path);
    if (route.fs.resolvePath(route.path, follow) === route.path) return path;
    return this.#walk(path, follow);
  }

  #walk(path: string, follow: boolean): string {
    let pending = parsePath(path);
    let index = 0;
    const resolved: string[] = [];
    let hops = 0;
    while (index < pending.length) {
      const candidate = joinPath(`/${resolved.join("/")}`, [pending[index]!]);
      const route = this.#route(candidate);
      let stat: RepackedStat;
      try {
        stat = route.fs.lstat(route.path);
      } catch (cause) {
        if (isMissing(cause)) break;
        throw cause;
      }
      if (stat.kind === "symlink" && (follow || index < pending.length - 1)) {
        hops += 1;
        if (hops > MAX_SYMLINK_HOPS) {
          throw new FsError("ELOOP", `path traverses more than ${MAX_SYMLINK_HOPS} symbolic links`, { path });
        }
        pending = parsePath(joinPath(route.fs.readlink(route.path), pending.slice(index + 1)));
        index = 0;
        resolved.length = 0;
        continue;
      }
      resolved.push(pending[index]!);
      index += 1;
    }
    return joinPath(`/${resolved.join("/")}`, pending.slice(index));
  }

  /** Resolve, then route. Every path operation below starts here. */
  #at(path: string, follow: boolean): Route {
    return this.#route(this.resolvePath(path, follow));
  }

  #descriptor(fd: number): MountedDescriptor {
    const entry = this.#descriptors.get(fd);
    if (entry === undefined) throw new FsError("EBADF", "descriptor is invalid");
    return entry;
  }

  // ---- lifecycle -----------------------------------------------------------

  /** Flushes the root and every mount the owner declared durable; a volatile mount is skipped. */
  strictSync(): void {
    this.#root.strictSync();
    for (const mount of this.#mounts) {
      if (mount.durable) mount.vfs.strictSync();
    }
  }

  assertHealthy(): void {
    this.#root.assertHealthy();
    for (const mount of this.#mounts) mount.vfs.assertHealthy();
  }

  fail(cause: unknown): never {
    for (const mount of this.#mounts) {
      try {
        mount.vfs.fail(cause);
      } catch {
        // Every store is poisoned with the same cause; the root's throw is the one that escapes.
      }
    }
    return this.#root.fail(cause);
  }

  /** The ROOT store's metrics. A mount's own are read through {@link MountedRepackedVfs.mounts}. */
  metrics(): RepackedVfsMetrics {
    return this.#root.metrics();
  }

  repack(reason?: RepackReason): void {
    this.#root.repack(reason);
    for (const mount of this.#mounts) mount.vfs.repack(reason);
  }

  runScheduledRepack(nowMs?: number): boolean {
    let repacked = this.#root.runScheduledRepack(nowMs);
    for (const mount of this.#mounts) {
      if (mount.vfs.runScheduledRepack(nowMs)) repacked = true;
    }
    return repacked;
  }

  close(): void;
  close(fd: number): void;
  close(fd?: number): void {
    if (fd !== undefined) {
      const entry = this.#descriptor(fd);
      this.#descriptors.delete(fd);
      entry.fs.close(entry.fd);
      return;
    }
    this.#descriptors.clear();
    let firstError: unknown;
    for (const mount of this.#mounts) {
      try {
        mount.vfs.close();
      } catch (cause) {
        firstError ??= cause;
      }
    }
    try {
      this.#root.close();
    } catch (cause) {
      firstError ??= cause;
    }
    if (firstError !== undefined) throw firstError;
  }

  // ---- path operations -----------------------------------------------------

  stat(path: string): RepackedStat {
    const route = this.#at(path, true);
    return route.fs.stat(route.path);
  }

  lstat(path: string): RepackedStat {
    const route = this.#at(path, false);
    return route.fs.lstat(route.path);
  }

  symlink(target: string, path: string, nowMs: bigint): void {
    const route = this.#at(path, false);
    route.fs.symlink(target, route.path, nowMs);
  }

  readlink(path: string): string {
    const route = this.#at(path, false);
    return route.fs.readlink(route.path);
  }

  readdir(path: string): string[] {
    const route = this.#at(path, true);
    return route.fs.readdir(route.path);
  }

  mkdir(path: string, options: { recursive?: boolean; mode?: number; nowMs: bigint }): void {
    const route = this.#at(path, false);
    route.fs.mkdir(route.path, options);
  }

  writeFile(
    path: string,
    data: string | Uint8Array,
    options: { encoding?: string; mode?: number; flag?: string; nowMs: bigint },
  ): void {
    const route = this.#at(path, true);
    route.fs.writeFile(route.path, data, options);
  }

  readFile(path: string): Uint8Array {
    const route = this.#at(path, true);
    return route.fs.readFile(route.path);
  }

  truncate(path: string, size: bigint, nowMs: bigint): void {
    const route = this.#at(path, true);
    route.fs.truncate(route.path, size, nowMs);
  }

  chmod(path: string, mode: number, nowMs: bigint): void {
    const route = this.#at(path, true);
    route.fs.chmod(route.path, mode, nowMs);
  }

  utimes(path: string, atimeMs: bigint, mtimeMs: bigint, ctimeMs: bigint): void {
    const route = this.#at(path, true);
    route.fs.utimes(route.path, atimeMs, mtimeMs, ctimeMs);
  }

  unlink(path: string, nowMs: bigint): void {
    const route = this.#at(path, false);
    route.fs.unlink(route.path, nowMs);
  }

  rmdir(path: string, nowMs: bigint): void {
    const route = this.#at(path, false);
    route.fs.rmdir(route.path, nowMs);
  }

  /** A rename is one store's metadata move; across a boundary it is `EXDEV`, as on any host. */
  rename(oldPath: string, newPath: string, nowMs: bigint): void {
    const source = this.#at(oldPath, false);
    const destination = this.#at(newPath, false);
    if (source.mount !== destination.mount) {
      throw new FsError("EXDEV", "rename crosses a mount boundary", { operation: "rename", path: newPath });
    }
    source.fs.rename(source.path, destination.path, nowMs);
  }

  // ---- descriptor operations -----------------------------------------------

  open(path: string, flags = "r", mode = 0o100666, nowMs = 0n): number {
    const route = this.#at(path, true);
    const inner = route.fs.open(route.path, flags, mode, nowMs);
    const fd = this.#nextDescriptor++;
    this.#descriptors.set(fd, { fs: route.fs, fd: inner });
    return fd;
  }

  fstat(fd: number): RepackedStat {
    const entry = this.#descriptor(fd);
    return entry.fs.fstat(entry.fd);
  }

  read(fd: number, buffer: Uint8Array, offset: number, length: number, position?: bigint): number {
    const entry = this.#descriptor(fd);
    return entry.fs.read(entry.fd, buffer, offset, length, position);
  }

  write(
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: bigint | undefined,
    nowMs: bigint,
  ): number {
    const entry = this.#descriptor(fd);
    return entry.fs.write(entry.fd, buffer, offset, length, position, nowMs);
  }
}
