// Began as a copy of `@electric-sql/pglite` (taken under its PostgreSQL License option, © ElectricSQL
// — see NOTICE). Owned outright (ADR-0062); compatibility with PGlite is an anti-goal — evolve freely.

import type { BaseFilesystem } from "@pgxsinkit/pgwasm/fs";

import type { PostgresModule } from "../emscripten";
import { PGDATA } from "../paths";
import { createVfsFilesystem } from "../vfs-mount";
import type { StorageMount } from "./storage-mount";

/** The data directory on a pgwasm filesystem (`createPgwasm({ fs })`), mounted through an adapter. */
export class VfsMount implements StorageMount {
  readonly #vfs: BaseFilesystem;

  constructor(vfs: BaseFilesystem) {
    this.#vfs = vfs;
  }

  async acquire(): Promise<void> {}

  get preRun(): (module: PostgresModule) => void {
    return (module) => {
      module.FS.mkdir(PGDATA);
      module.FS.mount(createVfsFilesystem(module, this.#vfs), {}, PGDATA);
    };
  }

  async initialSync(): Promise<void> {
    await this.#vfs.initialSyncFs();
  }

  async persist(_module: PostgresModule, relaxed: boolean): Promise<void> {
    await this.#vfs.syncToFs(relaxed);
  }

  async close(): Promise<void> {
    await this.#vfs.closeFs();
  }

  async cleanupFailedInit(): Promise<void> {
    await this.#vfs.cleanupFailedInit();
  }
}
