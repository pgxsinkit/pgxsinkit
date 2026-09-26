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
