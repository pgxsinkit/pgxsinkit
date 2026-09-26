// Began as a copy of `@electric-sql/pglite` (taken under its PostgreSQL License option, © ElectricSQL
// — see NOTICE). Owned outright (ADR-0062); compatibility with PGlite is an anti-goal — evolve freely.

import type { PostgresModule } from "../emscripten";
import type { StorageMount } from "./storage-mount";

/** The data directory in the module's own memory (MEMFS): gone when the database closes. */
export class MemoryMount implements StorageMount {
  readonly preRun = undefined;

  async acquire(): Promise<void> {}

  async initialSync(): Promise<void> {}

  async persist(): Promise<void> {}

  async close(module: PostgresModule | undefined): Promise<void> {
    module?.FS.quit();
  }

  async cleanupFailedInit(): Promise<void> {}
}
