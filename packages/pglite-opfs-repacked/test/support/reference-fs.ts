interface ReferenceNode {
  kind: "directory" | "file";
  mode: number;
  atimeMs: bigint;
  mtimeMs: bigint;
  ctimeMs: bigint;
  size: bigint;
}

function parentPath(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === 0 ? "/" : path.slice(0, slash);
}

export class ReferenceFs {
  readonly #nodes = new Map<string, ReferenceNode>([
    [
      "/",
      {
        kind: "directory",
        mode: 0o40777,
        atimeMs: 0n,
        mtimeMs: 0n,
        ctimeMs: 0n,
        size: 0n,
      },
    ],
  ]);

  #require(path: string): ReferenceNode {
    const node = this.#nodes.get(path);
    if (node === undefined) {
      throw new Error(`reference path does not exist: ${path}`);
    }
    return node;
  }

  #requireParent(path: string): ReferenceNode {
    const parent = this.#require(parentPath(path));
    if (parent.kind !== "directory") {
      throw new Error(`reference parent is not a directory: ${path}`);
    }
    return parent;
  }

  mkdir(path: string, mode: number, nowMs: bigint): void {
    this.#requireParent(path);
    if (this.#nodes.has(path)) {
      throw new Error(`reference path already exists: ${path}`);
    }
    this.#nodes.set(path, {
      kind: "directory",
      mode,
      atimeMs: nowMs,
      mtimeMs: nowMs,
      ctimeMs: nowMs,
      size: 0n,
    });
  }

  createFile(path: string, mode: number, size: bigint, nowMs: bigint): void {
    this.#requireParent(path);
    if (this.#nodes.has(path)) {
      throw new Error(`reference path already exists: ${path}`);
    }
    this.#nodes.set(path, {
      kind: "file",
      mode,
      atimeMs: nowMs,
      mtimeMs: nowMs,
      ctimeMs: nowMs,
      size,
    });
  }

  resize(path: string, size: bigint, nowMs: bigint): void {
    const node = this.#require(path);
    if (node.kind !== "file") {
      throw new Error(`reference path is not a file: ${path}`);
    }
    node.size = size;
    node.mtimeMs = nowMs;
    node.ctimeMs = nowMs;
  }

  chmod(path: string, mode: number, nowMs: bigint): void {
    const node = this.#require(path);
    node.mode = mode;
    node.ctimeMs = nowMs;
  }

  utimes(path: string, atimeMs: bigint, mtimeMs: bigint, ctimeMs: bigint): void {
    const node = this.#require(path);
    node.atimeMs = atimeMs;
    node.mtimeMs = mtimeMs;
    node.ctimeMs = ctimeMs;
  }

  unlink(path: string, nowMs: bigint): void {
    const node = this.#require(path);
    if (node.kind !== "file") {
      throw new Error(`reference path is not a file: ${path}`);
    }
    const parent = this.#requireParent(path);
    this.#nodes.delete(path);
    parent.mtimeMs = nowMs;
    parent.ctimeMs = nowMs;
  }

  rmdir(path: string, nowMs: bigint): void {
    const node = this.#require(path);
    if (node.kind !== "directory") {
      throw new Error(`reference path is not a directory: ${path}`);
    }
    for (const candidate of this.#nodes.keys()) {
      if (candidate !== path && parentPath(candidate) === path) {
        throw new Error(`reference directory is not empty: ${path}`);
      }
    }
    const parent = this.#requireParent(path);
    this.#nodes.delete(path);
    parent.mtimeMs = nowMs;
    parent.ctimeMs = nowMs;
  }

  rename(oldPath: string, newPath: string, nowMs: bigint): void {
    const source = this.#require(oldPath);
    const oldParent = this.#requireParent(oldPath);
    const newParent = this.#requireParent(newPath);
    const destination = this.#nodes.get(newPath);
    if (destination !== undefined && destination.kind !== source.kind) {
      throw new Error("reference rename type mismatch");
    }
    if (destination?.kind === "directory") {
      for (const candidate of this.#nodes.keys()) {
        if (candidate !== newPath && parentPath(candidate) === newPath) {
          throw new Error(`reference destination directory is not empty: ${newPath}`);
        }
      }
    }
    const moved = [...this.#nodes].filter(
      ([candidate]) => candidate === oldPath || candidate.startsWith(`${oldPath}/`),
    );
    this.#nodes.delete(newPath);
    for (const [candidate] of moved) this.#nodes.delete(candidate);
    for (const [candidate, node] of moved) {
      this.#nodes.set(`${newPath}${candidate.slice(oldPath.length)}`, node);
    }
    source.ctimeMs = nowMs;
    oldParent.mtimeMs = nowMs;
    oldParent.ctimeMs = nowMs;
    newParent.mtimeMs = nowMs;
    newParent.ctimeMs = nowMs;
  }

  entries(): unknown[] {
    return [...this.#nodes]
      .sort(([left], [right]) => {
        if (left === "/") return -1;
        if (right === "/") return 1;
        return left.localeCompare(right);
      })
      .map(([path, node]) => ({ path, ...node }));
  }
}
