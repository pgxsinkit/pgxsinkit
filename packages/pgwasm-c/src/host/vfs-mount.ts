// Began as a copy of `@electric-sql/pglite` (taken under its PostgreSQL License option, © ElectricSQL
// — see NOTICE). Owned outright (ADR-0062); compatibility with PGlite is an anti-goal — evolve freely.

import { ERRNO_CODES, type BaseFilesystem } from "@pgxsinkit/pgwasm/fs";

import type { EmscriptenFilesystemType, EmscriptenNode, EmscriptenStream, PostgresModule } from "./emscripten";

/** The node attributes Emscripten passes to `setattr`. */
interface NodeAttributes {
  mode?: number;
  size?: number;
  timestamp?: number;
}

/** A Uint8Array over exactly the bytes of `buffer` (Emscripten hands the heap as an Int8Array). */
function asBytes(buffer: ArrayBufferView): Uint8Array {
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

/**
 * An Emscripten filesystem over a pgwasm {@link BaseFilesystem}: each node and stream operation becomes a
 * call on the filesystem, by path relative to the mount. A thrown error becomes an errno for Postgres —
 * its `code` when it has one, `EIO` when it does not (a DOMException, a plain Error from the storage):
 * rethrown, it would unwind the engine mid-syscall instead of failing that syscall.
 */
export function createVfsFilesystem(module: PostgresModule, vfs: BaseFilesystem): EmscriptenFilesystemType {
  const FS = module.FS;
  const log = vfs.debug ? console.log : undefined;

  const tryOperation = <T>(fn: () => T, op: string, path: string | (() => string)): T => {
    try {
      return fn();
    } catch (error) {
      // Already an errno (a filesystem may throw Emscripten's own error).
      if (error instanceof FS.ErrnoError) throw error;
      const code = (error as { code?: unknown } | null)?.code;
      const errno = !code ? ERRNO_CODES.EIO : code === "UNKNOWN" ? ERRNO_CODES.EINVAL : code;
      const message = (error as { message?: unknown } | null)?.message;
      vfs.recordSyscallError(
        op,
        typeof path === "function" ? path() : path,
        typeof errno === "number" ? errno : -1,
        typeof message === "string" ? message : String(code ?? error),
      );
      throw new FS.ErrnoError(typeof errno === "number" ? errno : ERRNO_CODES.EIO);
    }
  };

  const realPath = (node: EmscriptenNode): string => {
    const parts: string[] = [];
    let current = node;
    while (current.parent !== current) {
      parts.push(current.name);
      current = current.parent;
    }
    parts.push(current.mount.opts.root ?? "");
    parts.reverse();
    return parts.join("/");
  };

  const createNode = (parent: EmscriptenNode | null, name: string, mode: number): EmscriptenNode => {
    if (!FS.isDir(mode) && !FS.isFile(mode)) {
      throw new FS.ErrnoError(ERRNO_CODES.EINVAL);
    }
    const node = FS.createNode(parent, name, mode);
    node.node_ops = nodeOps;
    node.stream_ops = streamOps;
    return node;
  };

  const getMode = (path: string): number => tryOperation(() => vfs.lstat(path).mode, "getMode", path);

  const nodeOps = {
    getattr(node: EmscriptenNode) {
      const path = realPath(node);
      log?.("getattr", path);
      return tryOperation(
        () => {
          const stats = vfs.lstat(path);
          return {
            ...stats,
            dev: 0,
            ino: node.id,
            nlink: 1,
            rdev: node.rdev,
            atime: new Date(stats.atime),
            mtime: new Date(stats.mtime),
            ctime: new Date(stats.ctime),
          };
        },
        "getattr",
        path,
      );
    },
    setattr(node: EmscriptenNode, attr: NodeAttributes): void {
      const path = realPath(node);
      log?.("setattr", path, attr);
      tryOperation(
        () => {
          if (attr.mode !== undefined) vfs.chmod(path, attr.mode);
          if (attr.size !== undefined) vfs.truncate(path, attr.size);
          if (attr.timestamp !== undefined) vfs.utimes(path, attr.timestamp, attr.timestamp);
        },
        "setattr",
        path,
      );
    },
    lookup(parent: EmscriptenNode, name: string): EmscriptenNode {
      const path = `${realPath(parent)}/${name}`;
      log?.("lookup", path);
      return createNode(parent, name, getMode(path));
    },
    mknod(parent: EmscriptenNode, name: string, mode: number): EmscriptenNode {
      const node = createNode(parent, name, mode);
      const path = realPath(node);
      log?.("mknod", path, mode);
      return tryOperation(
        () => {
          if (FS.isDir(node.mode)) {
            vfs.mkdir(path, { mode });
          } else {
            vfs.writeFile(path, "", { mode });
          }
          return node;
        },
        "mknod",
        path,
      );
    },
    rename(oldNode: EmscriptenNode, newDir: EmscriptenNode, newName: string): void {
      const oldPath = realPath(oldNode);
      const newPath = `${realPath(newDir)}/${newName}`;
      log?.("rename", oldPath, newPath);
      tryOperation(() => vfs.rename(oldPath, newPath), "rename", oldPath);
      oldNode.name = newName;
    },
    unlink(parent: EmscriptenNode, name: string): void {
      const path = `${realPath(parent)}/${name}`;
      log?.("unlink", path);
      try {
        vfs.unlink(path);
      } catch (error) {
        // An unlink failure is not reported to Postgres, only recorded.
        const code = (error as { code?: unknown } | null)?.code;
        if (code) {
          const message = (error as { message?: unknown } | null)?.message;
          vfs.recordSyscallError(
            "unlink",
            path,
            typeof code === "number" ? code : -1,
            typeof message === "string" ? message : JSON.stringify(code),
          );
        }
      }
    },
    rmdir(parent: EmscriptenNode, name: string): void {
      const path = `${realPath(parent)}/${name}`;
      log?.("rmdir", path);
      tryOperation(() => vfs.rmdir(path), "rmdir", path);
    },
    readdir(node: EmscriptenNode): string[] {
      const path = realPath(node);
      log?.("readdir", path);
      return tryOperation(() => vfs.readdir(path), "readdir", path);
    },
    symlink(): never {
      throw new FS.ErrnoError(63); // EPERM: not supported
    },
    readlink(): never {
      throw new FS.ErrnoError(63);
    },
  };

  const streamOps = {
    open(stream: EmscriptenStream): void {
      const path = realPath(stream.node);
      log?.("open", path);
      tryOperation(
        () => {
          if (FS.isFile(stream.node.mode)) {
            stream.shared.refcount = 1;
            stream.nfd = vfs.open(path);
          }
        },
        "open",
        path,
      );
    },
    close(stream: EmscriptenStream): void {
      log?.("close", realPath(stream.node));
      tryOperation(
        () => {
          if (FS.isFile(stream.node.mode) && stream.nfd !== undefined && --stream.shared.refcount === 0) {
            vfs.close(stream.nfd);
          }
        },
        "close",
        () => realPath(stream.node),
      );
    },
    dup(stream: EmscriptenStream): void {
      stream.shared.refcount++;
    },
    read(stream: EmscriptenStream, buffer: ArrayBufferView, offset: number, length: number, position: number): number {
      if (length === 0) return 0;
      const fd = stream.nfd ?? -1;
      return tryOperation(
        () => vfs.read(fd, asBytes(buffer), offset, length, position),
        "read",
        () => realPath(stream.node),
      );
    },
    write(stream: EmscriptenStream, buffer: ArrayBufferView, offset: number, length: number, position: number): number {
      const fd = stream.nfd ?? -1;
      return tryOperation(
        () => vfs.write(fd, asBytes(buffer), offset, length, position),
        "write",
        () => realPath(stream.node),
      );
    },
    llseek(stream: EmscriptenStream, offset: number, whence: number): number {
      let position = offset;
      if (whence === 1) {
        position += stream.position;
      } else if (whence === 2 && FS.isFile(stream.node.mode)) {
        const fd = stream.nfd ?? -1;
        tryOperation(
          () => {
            position += vfs.fstat(fd).size;
          },
          "llseek",
          () => realPath(stream.node),
        );
      }
      if (position < 0) throw new FS.ErrnoError(ERRNO_CODES.EINVAL);
      return position;
    },
    mmap(): never {
      // The runtime exports no mmapAlloc; Postgres does not map data-directory files.
      throw new FS.ErrnoError(ERRNO_CODES.ENODEV);
    },
    msync(): number {
      return 0;
    },
  };

  return {
    mount(): EmscriptenNode {
      return createNode(null, "/", 0o40000 | 0o777);
    },
    syncfs(_mount: unknown, _populate: unknown, done: (error: unknown) => void): void {
      done(null);
    },
    createNode,
    node_ops: nodeOps,
    stream_ops: streamOps,
  };
}
