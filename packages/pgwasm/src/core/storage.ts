// Began as a copy of `@electric-sql/pglite` (taken under its PostgreSQL License option, © ElectricSQL
// — see NOTICE). Owned outright (ADR-0062); compatibility with PGlite is an anti-goal — evolve freely.

import type { StorageRequest } from "../build/seam";
import { OpfsAhpRemovedError, UnsupportedDataDirError } from "../errors";
import type { BaseFilesystem } from "../fs/base-filesystem";
import type { StorageDescription } from "../interface";

/**
 * Resolve the `dataDir` / `fs` options into the storage a build mounts. A scheme is required
 * (`memory://`, `idb://<name>`, `file://<path>`); a bare path, an unknown scheme and the removed
 * `opfs-ahp://` are refused before anything is booted.
 */
export function resolveStorage(dataDir: string | undefined, fs: BaseFilesystem | undefined): StorageRequest {
  if (fs !== undefined) {
    if (dataDir !== undefined) {
      throw new UnsupportedDataDirError(dataDir, "`dataDir` and `fs` are exclusive; pass one of them");
    }
    return { kind: "vfs", vfs: fs };
  }
  if (dataDir === undefined || dataDir.startsWith("memory://")) {
    return { kind: "memory" };
  }
  if (dataDir.startsWith("idb://")) {
    const name = dataDir.slice("idb://".length);
    if (name === "") throw new UnsupportedDataDirError(dataDir, "an IndexedDB store needs a name (idb://<name>)");
    return { kind: "idb", name };
  }
  if (dataDir.startsWith("file://")) {
    const path = dataDir.slice("file://".length);
    if (path === "") throw new UnsupportedDataDirError(dataDir, "a file store needs a path (file://<path>)");
    return { kind: "file", path };
  }
  if (dataDir.startsWith("opfs-ahp://")) {
    throw new OpfsAhpRemovedError(dataDir);
  }
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(dataDir)?.[1];
  throw new UnsupportedDataDirError(
    dataDir,
    scheme === undefined
      ? "a scheme is required: memory://, idb://<name> or file://<path>"
      : `unknown scheme "${scheme}://" (supported: memory://, idb://<name>, file://<path>)`,
  );
}

/** The public description of where a data directory lives. */
export function describeStorage(storage: StorageRequest): StorageDescription {
  switch (storage.kind) {
    case "memory":
      return { kind: "memory" };
    case "idb":
      return { kind: "idb", name: storage.name };
    case "file":
      return { kind: "file", path: storage.path };
    case "vfs":
      return { kind: "vfs" };
  }
}

/** The file name a Store backup gets: the storage's last path segment, else `pgdata`. */
export function backupBaseName(storage: StorageDescription): string {
  const location = storage.kind === "idb" ? storage.name : storage.kind === "file" ? storage.path : "";
  const last = location
    .split("/")
    .filter((segment) => segment !== "")
    .pop();
  return last ?? "pgdata";
}
