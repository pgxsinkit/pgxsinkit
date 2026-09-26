// Began as a copy of `@electric-sql/pglite` (taken under its PostgreSQL License option, © ElectricSQL
// — see NOTICE). Owned outright (ADR-0062); compatibility with PGlite is an anti-goal — evolve freely.

import type { PostgresModule } from "../emscripten";
import { PGDATA } from "../paths";
import type { StorageMount } from "./storage-mount";

/**
 * The data directory as a directory on disk, through Emscripten's NODEFS (Bun). Writes go straight to
 * the host filesystem, so there is nothing to persist; closing flushes the runtime's streams.
 */
export class FileMount implements StorageMount {
  readonly #path: string;
  #root: string | undefined;

  constructor(path: string) {
    this.#path = path;
  }

  async acquire(): Promise<void> {
    // Loaded lazily so the browser bundle carries no static `node:` import; this storage is Bun's.
    const [{ mkdirSync }, { resolve }] = await Promise.all([import("node:fs"), import("node:path")]);
    this.#root = resolve(this.#path);
    mkdirSync(this.#root, { recursive: true });
  }

  get preRun(): (module: PostgresModule) => void {
    return (module) => {
      if (this.#root === undefined) throw new Error("the file mount was not acquired");
      module.FS.mkdir(PGDATA);
      module.FS.mount(module.FS.filesystems.NODEFS, { root: this.#root }, PGDATA);
    };
  }

  async initialSync(): Promise<void> {}

  async persist(): Promise<void> {}

  async close(module: PostgresModule | undefined): Promise<void> {
    module?.FS.quit();
  }

  async cleanupFailedInit(): Promise<void> {}
}
