// Began as a copy of `@electric-sql/pglite`'s tests (taken under its PostgreSQL License option,
// © ElectricSQL — see NOTICE). Owned outright (ADR-0062); compatibility with PGlite is an anti-goal.

import { BaseFilesystem, ERRNO_CODES, type FsStats } from "../../../packages/pgwasm/src/fs";

/** A filesystem error carrying an errno, as a pgwasm filesystem reports one. */
export class CodedFailure extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

interface MemoryNode {
  kind: "file" | "dir";
  mode: number;
  data: Uint8Array;
  size: number;
  atime: number;
  mtime: number;
  ctime: number;
}

function newNode(kind: MemoryNode["kind"], mode: number): MemoryNode {
  const now = Date.now();
  return { kind, mode, data: new Uint8Array(0), size: 0, atime: now, mtime: now, ctime: now };
}

function hostPath(path: string): string {
  return path === "" ? "/" : path;
}

function parentOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut <= 0 ? "/" : path.slice(0, cut);
}

function resize(node: MemoryNode, size: number): void {
  if (size > node.data.length) {
    const grown = new Uint8Array(Math.max(size, node.data.length * 2));
    grown.set(node.data.subarray(0, node.size));
    node.data = grown;
  } else if (size < node.size) {
    node.data.fill(0, size, node.size);
  }
  node.size = size;
}

/**
 * A minimal in-memory pgwasm filesystem, for tests of the filesystem path (`createPgwasm({ fs })`). It
 * counts the durability calls pgwasm and the build make on it.
 */
export class MemoryVfs extends BaseFilesystem {
  readonly #nodes = new Map<string, MemoryNode>([["/", newNode("dir", 0o40755)]]);
  readonly #fds = new Map<number, { node: MemoryNode; path: string }>();
  #nextFd = 3;
  initialSyncs = 0;
  syncs: boolean[] = [];
  closed = false;
  failedInitCleanups = 0;

  override async initialSyncFs(): Promise<void> {
    this.initialSyncs++;
  }

  override async syncToFs(relaxed?: boolean): Promise<void> {
    this.syncs.push(relaxed === true);
  }

  override async closeFs(): Promise<void> {
    this.closed = true;
  }

  override async cleanupFailedInit(): Promise<void> {
    this.failedInitCleanups++;
    this.closed = true;
  }

  /** Whether a path exists, for assertions. */
  has(path: string): boolean {
    return this.#nodes.has(path);
  }

  #node(path: string): MemoryNode {
    const node = this.#nodes.get(hostPath(path));
    if (!node) throw new CodedFailure(ERRNO_CODES.ENOENT, `no such file: ${path}`);
    return node;
  }

  #entry(fd: number): { node: MemoryNode; path: string } {
    const entry = this.#fds.get(fd);
    if (!entry) throw new CodedFailure(ERRNO_CODES.EBADF, `bad descriptor: ${fd}`);
    return entry;
  }

  #create(path: string, node: MemoryNode): void {
    const parent = this.#node(parentOf(path));
    if (parent.kind !== "dir") throw new CodedFailure(ERRNO_CODES.ENOTDIR, `not a directory: ${parentOf(path)}`);
    this.#nodes.set(path, node);
  }

  #stat(node: MemoryNode): FsStats {
    const size = node.kind === "dir" ? 4096 : node.size;
    return {
      dev: 0,
      ino: 0,
      mode: node.mode,
      nlink: 1,
      uid: 0,
      gid: 0,
      rdev: 0,
      size,
      blksize: 4096,
      blocks: Math.ceil(size / 4096),
      atime: node.atime,
      mtime: node.mtime,
      ctime: node.ctime,
    };
  }

  chmod(path: string, mode: number): void {
    this.#node(path).mode = mode;
  }

  close(fd: number): void {
    this.#entry(fd);
    this.#fds.delete(fd);
  }

  fstat(fd: number): FsStats {
    return this.#stat(this.#entry(fd).node);
  }

  lstat(path: string): FsStats {
    return this.#stat(this.#node(path));
  }

  mkdir(path: string, options?: { recursive?: boolean; mode?: number }): void {
    const target = hostPath(path);
    const mode = (options?.mode ?? 0o755) | 0o40000;
    if (options?.recursive) {
      let current = "";
      for (const part of target.split("/").filter(Boolean)) {
        current = `${current}/${part}`;
        const existing = this.#nodes.get(current);
        if (existing?.kind === "file") throw new CodedFailure(ERRNO_CODES.ENOTDIR, `not a directory: ${current}`);
        if (!existing) this.#create(current, newNode("dir", mode));
      }
      return;
    }
    if (this.#nodes.has(target)) throw new CodedFailure(ERRNO_CODES.EEXIST, `exists: ${path}`);
    this.#create(target, newNode("dir", mode));
  }

  open(path: string): number {
    const node = this.#node(path);
    if (node.kind === "dir") throw new CodedFailure(ERRNO_CODES.EISDIR, `directory: ${path}`);
    const fd = this.#nextFd++;
    this.#fds.set(fd, { node, path: hostPath(path) });
    return fd;
  }

  readdir(path: string): string[] {
    const target = hostPath(path);
    if (this.#node(target).kind !== "dir") throw new CodedFailure(ERRNO_CODES.ENOTDIR, `not a directory: ${path}`);
    const prefix = target === "/" ? "/" : `${target}/`;
    return [...this.#nodes.keys()]
      .filter((key) => key !== "/" && key.startsWith(prefix))
      .map((key) => key.slice(prefix.length))
      .filter((name) => !name.includes("/"));
  }

  read(fd: number, buffer: Uint8Array, offset: number, length: number, position: number): number {
    const { node } = this.#entry(fd);
    const count = Math.max(0, Math.min(length, node.size - position));
    buffer.set(node.data.subarray(position, position + count), offset);
    return count;
  }

  rename(oldPath: string, newPath: string): void {
    const from = hostPath(oldPath);
    const to = hostPath(newPath);
    const moving = [...this.#nodes.entries()].filter(([key]) => key === from || key.startsWith(`${from}/`));
    if (moving.length === 0) throw new CodedFailure(ERRNO_CODES.ENOENT, `no such file: ${oldPath}`);
    this.#nodes.delete(to);
    for (const [key] of moving) this.#nodes.delete(key);
    for (const [key, node] of moving) this.#nodes.set(to + key.slice(from.length), node);
  }

  rmdir(path: string): void {
    const target = hostPath(path);
    if (this.#node(target).kind !== "dir") throw new CodedFailure(ERRNO_CODES.ENOTDIR, `not a directory: ${path}`);
    if (this.readdir(target).length > 0) throw new CodedFailure(ERRNO_CODES.ENOTEMPTY, `not empty: ${path}`);
    this.#nodes.delete(target);
  }

  truncate(path: string, length: number): void {
    resize(this.#node(path), length);
  }

  unlink(path: string): void {
    const target = hostPath(path);
    if (this.#node(target).kind === "dir") throw new CodedFailure(ERRNO_CODES.EISDIR, `directory: ${path}`);
    this.#nodes.delete(target);
  }

  utimes(path: string, atime: number, mtime: number): void {
    const node = this.#node(path);
    node.atime = atime;
    node.mtime = mtime;
  }

  writeFile(path: string, data: string | Uint8Array, options?: { mode?: number }): void {
    const target = hostPath(path);
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    let node = this.#nodes.get(target);
    if (!node) {
      node = newNode("file", options?.mode ?? 0o100644);
      this.#create(target, node);
    }
    resize(node, 0);
    resize(node, bytes.byteLength);
    node.data.set(bytes);
  }

  write(fd: number, buffer: Uint8Array, offset: number, length: number, position: number): number {
    const { node } = this.#entry(fd);
    this.beforeWrite(this.#entry(fd).path);
    const end = position + length;
    if (end > node.size) resize(node, end);
    node.data.set(buffer.subarray(offset, offset + length), position);
    node.mtime = Date.now();
    return length;
  }

  /** A hook for subclasses to fail a write, by path. */
  protected beforeWrite(_path: string): void {}
}
