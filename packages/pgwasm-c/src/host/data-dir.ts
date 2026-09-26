// Began as a copy of `@electric-sql/pglite` (taken under its PostgreSQL License option, © ElectricSQL
// — see NOTICE). Owned outright (ADR-0062); compatibility with PGlite is an anti-goal — evolve freely.

import type { DataDirEntry } from "@pgxsinkit/pgwasm/build";

import type { EmscriptenFS } from "./emscripten";
import { PGDATA } from "./paths";

function mtimeSeconds(mtime: Date | number): number {
  return Math.floor((typeof mtime === "number" ? mtime : mtime.getTime()) / 1000);
}

/** Every entry under the data directory, a directory before its contents. */
export function readDataDirEntries(FS: EmscriptenFS, root = PGDATA): DataDirEntry[] {
  const entries: DataDirEntry[] = [];
  const walk = (directory: string) => {
    for (const name of FS.readdir(directory)) {
      if (name === "." || name === "..") continue;
      const fullPath = `${directory}/${name}`;
      const stats = FS.stat(fullPath);
      const isFile = FS.isFile(stats.mode);
      entries.push({
        path: fullPath.slice(root.length),
        type: isFile ? "file" : "directory",
        mode: stats.mode & 0o7777,
        mtimeSeconds: mtimeSeconds(stats.mtime),
        data: isFile ? FS.readFile(fullPath, { encoding: "binary" }) : new Uint8Array(0),
      });
      if (FS.isDir(stats.mode)) walk(fullPath);
    }
  };
  walk(root);
  return entries;
}

function ensureDirectory(FS: EmscriptenFS, path: string): void {
  if (!FS.analyzePath(path).exists) FS.mkdirTree(path);
}

/** Write entries into the data directory, creating it and any missing parents. */
export function writeDataDirEntries(FS: EmscriptenFS, entries: readonly DataDirEntry[], root = PGDATA): void {
  ensureDirectory(FS, root);
  for (const entry of entries) {
    const path = `${root}${entry.path}`;
    if (entry.type === "directory") {
      ensureDirectory(FS, path);
      continue;
    }
    ensureDirectory(FS, path.slice(0, path.lastIndexOf("/")));
    FS.writeFile(path, entry.data);
    const mtimeMs = entry.mtimeSeconds * 1000;
    FS.utime(path, mtimeMs, mtimeMs);
  }
}

/** Write one file, creating its directory. */
export function writeDataDirFile(FS: EmscriptenFS, path: string, data: Uint8Array, root = PGDATA): void {
  const target = `${root}${path}`;
  ensureDirectory(FS, target.slice(0, target.lastIndexOf("/")));
  FS.writeFile(target, data);
}

/** A file in the data directory, or `undefined` when it does not exist. */
export function readDataDirFile(FS: EmscriptenFS, path: string, root = PGDATA): Uint8Array | undefined {
  const target = `${root}${path}`;
  if (!FS.analyzePath(target).exists) return undefined;
  const stats = FS.stat(target);
  if (!FS.isFile(stats.mode)) return undefined;
  return FS.readFile(target, { encoding: "binary" });
}
