/**
 * The FILE-backed `RepackedPort`: the same four owned files, in an ordinary directory on an ordinary
 * filesystem, opened with `node:fs`'s synchronous calls.
 *
 * It exists because the store's four files are the store — nothing about the format is OPFS's, and
 * nothing about it is a browser's. A host running under Node or Bun can therefore BUILD a store
 * (seed it, fill it, repack it) where a build step can see the bytes, hand those four files to a
 * browser, and have the browser's `OpfsRepackedPort` open them as the same store. Format identity
 * is by construction: the port answers `getSize`/`read`/`write`/`truncate`/`flush` and the layout
 * above it never learns which port it is on.
 *
 * **`node:fs` is imported LAZILY, and that is load-bearing.** This module is exported from the
 * package entry, and the package's redistribution artifact (`dist/browser-bundle.js`) is built with
 * `--target browser`, where a STATIC `import { openSync } from "node:fs"` is compiled to an empty
 * object — every call would then be `undefined is not a function`, in Node as well as in a browser,
 * because that one bundle is what the wasm hosts load in BOTH. A dynamic `import("node:fs")` is left
 * verbatim by every target, so the same file resolves the real module under Node/Bun and rejects
 * where there is no such module. `enumerate` and `acquire` are already async, which is the whole
 * reason the seam fits: every method on the HANDLE stays synchronous, as the store requires.
 *
 * **Ownership is not exclusion.** OPFS's `createSyncAccessHandle()` is exclusive per origin, and
 * `StoreOwnedError` there means another live owner. POSIX `open` grants nothing of the kind: two
 * processes may hold the same file open and interleave writes, and no advisory lock this port could
 * take would be honoured by a process that did not take one. So the guarantee here is bounded and
 * stated — a second `acquire` of a name this port already has open raises `StoreOwnedError`, and a
 * SECOND PROCESS is the host's problem to arrange. The intended use is a single build-time owner.
 */
// Type-only, and therefore erased before any bundler sees it — the RUNTIME import is the dynamic one
// in `loadNodeFileSystem` below, which is the whole point of this module's shape.
import type * as NodeFsModule from "node:fs";

import { StoreOwnedError } from "./core/errors";
import type { OwnedFileName, RepackedFileHandle, RepackedPort, RepackedPortEntry } from "./core/port";

/** The `node:fs` surface this port uses, and nothing else. Never part of an exported signature. */
type NodeFileSystem = Pick<
  typeof NodeFsModule,
  | "closeSync"
  | "constants"
  | "fstatSync"
  | "ftruncateSync"
  | "fsyncSync"
  | "mkdirSync"
  | "openSync"
  | "readSync"
  | "readdirSync"
  | "writeSync"
>;

/** The mode a newly created owned file takes; the process umask applies to it as it does anywhere. */
const CREATED_FILE_MODE = 0o666;

/**
 * Resolve `node:fs`, or say why there is none.
 *
 * A bare rejected `import()` in a browser reads as "Failed to resolve module specifier", which names
 * neither this port nor the reason; the check in front of it is what turns that into an answer.
 */
async function loadNodeFileSystem(): Promise<NodeFileSystem> {
  const runtime = globalThis as { process?: { versions?: Record<string, string | undefined> } };
  if (runtime.process?.versions?.["node"] === undefined) {
    throw new Error(
      "FileRepackedPort needs node:fs and this scope has none (no process.versions.node); " +
        "a browser store belongs on OpfsRepackedPort",
    );
  }
  return (await import("node:fs")) as NodeFileSystem;
}

function joinPath(directory: string, name: string): string {
  return `${directory.replace(/\/+$/, "")}/${name}`;
}

export class FileRepackedPort implements RepackedPort {
  readonly #directory: string;
  readonly #open = new Set<OwnedFileName>();
  #fs: NodeFileSystem | undefined;

  /**
   * @param directory The directory this store owns in full. It is created on first use, with every
   * parent, exactly as the OPFS port's caller creates its directory handle with `create: true`.
   */
  constructor(directory: string) {
    if (directory.trim() === "") throw new TypeError("FileRepackedPort needs a directory path");
    this.#directory = directory;
  }

  /** The directory this port reads and writes. Absolute or relative, exactly as it was given. */
  get directory(): string {
    return this.#directory;
  }

  async enumerate(_label: string): Promise<readonly RepackedPortEntry[]> {
    const fs = await this.#ready();
    // Everything that is there, not just the four names: an entry the store did not write is what
    // `UnexpectedStoreEntryError` is for, and hiding it here would open a store over a stranger's
    // directory.
    return fs.readdirSync(this.#directory, { withFileTypes: true }).map((entry) => ({
      name: entry.name,
      kind: entry.isDirectory() ? ("directory" as const) : ("file" as const),
    }));
  }

  async acquire(name: OwnedFileName, _label: string): Promise<RepackedFileHandle> {
    const fs = await this.#ready();
    // The bounded half of the ownership guarantee; see the file header for the half POSIX cannot give.
    if (this.#open.has(name)) throw new StoreOwnedError();
    // `r+` that creates: O_RDWR|O_CREAT, which is `openSync(path, "r+")`'s flags plus the create bit
    // and NOT `a+` — an append-mode fd ignores the position argument on every write, which would
    // turn the arena's random writes into a log.
    const fd = fs.openSync(
      joinPath(this.#directory, name),
      fs.constants.O_RDWR | fs.constants.O_CREAT,
      CREATED_FILE_MODE,
    );
    this.#open.add(name);
    return new FileRepackedFileHandle(fs, name, fd, () => this.#open.delete(name));
  }

  async #ready(): Promise<NodeFileSystem> {
    if (this.#fs === undefined) {
      const fs = await loadNodeFileSystem();
      fs.mkdirSync(this.#directory, { recursive: true });
      this.#fs = fs;
    }
    return this.#fs;
  }
}

class FileRepackedFileHandle implements RepackedFileHandle {
  readonly name: OwnedFileName;
  readonly #fs: NodeFileSystem;
  readonly #fd: number;
  readonly #released: () => void;
  #closed = false;

  constructor(fs: NodeFileSystem, name: OwnedFileName, fd: number, released: () => void) {
    this.#fs = fs;
    this.name = name;
    this.#fd = fd;
    this.#released = released;
  }

  getSize(_label: string): number {
    this.#assertOpen();
    return this.#fs.fstatSync(this.#fd).size;
  }

  read(target: Uint8Array, at: number, _label: string): number {
    this.#assertOpen();
    // A read wholly past the end answers 0, which `readExact` reports as a store that ended early —
    // the same thing an OPFS access handle answers there.
    return this.#fs.readSync(this.#fd, target, 0, target.byteLength, at);
  }

  write(source: Uint8Array, at: number, _label: string): number {
    this.#assertOpen();
    return this.#fs.writeSync(this.#fd, source, 0, source.byteLength, at);
  }

  truncate(size: number, _label: string): void {
    this.#assertOpen();
    this.#fs.ftruncateSync(this.#fd, size);
  }

  flush(_label: string): void {
    this.#assertOpen();
    // The platform's durability boundary, not a userspace buffer drain: nothing here buffers, so
    // `fsync` is the only thing `flush` can honestly mean.
    this.#fs.fsyncSync(this.#fd);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#released();
    this.#fs.closeSync(this.#fd);
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error(`file handle ${this.name} is closed`);
  }
}
