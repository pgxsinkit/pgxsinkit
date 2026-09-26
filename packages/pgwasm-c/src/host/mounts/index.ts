// Began as a copy of `@electric-sql/pglite` (taken under its PostgreSQL License option, © ElectricSQL
// — see NOTICE). Owned outright (ADR-0062); compatibility with PGlite is an anti-goal — evolve freely.

import type { StorageRequest } from "@pgxsinkit/pgwasm/build";

import { FileMount } from "./file";
import { IdbMount } from "./idb";
import { MemoryMount } from "./memory";
import type { StorageMount } from "./storage-mount";
import { VfsMount } from "./vfs";

export type { StorageMount } from "./storage-mount";

/** The mount for a storage request. */
export function mountFor(storage: StorageRequest): StorageMount {
  switch (storage.kind) {
    case "memory":
      return new MemoryMount();
    case "idb":
      return new IdbMount(storage.name);
    case "file":
      return new FileMount(storage.path);
    case "vfs":
      return new VfsMount(storage.vfs);
  }
}
