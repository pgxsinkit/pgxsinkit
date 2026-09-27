// Began as a copy of `@electric-sql/pglite-tools` (taken under PGlite's PostgreSQL License option,
// © ElectricSQL — see NOTICE). Owned outright (ADR-0062); compatibility with PGlite is an anti-goal.

/**
 * The parts of pg_dump's Emscripten module this package uses, typed here rather than through
 * `@types/emscripten` (a global-ambient package). Only what is called is declared.
 */

export interface PgDumpFS {
  analyzePath(path: string): { exists: boolean };
  mkdirTree(path: string): void;
  writeFile(path: string, data: Uint8Array | string): void;
  chmod(path: string, mode: number): void;
  readFile(path: string, options?: { encoding: "binary" }): Uint8Array;
}

/** pg_dump's module (`pg_dump.js`). */
export interface PgDumpModule {
  readonly FS: PgDumpFS;
  readonly ENV: Record<string, string>;
  readonly HEAPU8: Uint8Array;
  addFunction(fn: (pointer: number, length: number) => number, signature: string): number;
  /** Run pg_dump's `main`; returns its exit status. */
  callMain(args: string[]): number;
  /** Route libpq's socket reads and writes to two functions from `addFunction` (pglitec.c). */
  _pgl_set_rw_cbs(readCallback: number, writeCallback: number): void;
}

/** What the module factory accepts; the members this package sets. */
export interface PgDumpModuleOverrides {
  readonly thisProgram: string;
  readonly noExitRuntime: boolean;
  readonly stdin: () => number | null;
  readonly print: (text: string) => void;
  readonly printErr: (text: string) => void;
  readonly instantiateWasm: (
    imports: Parameters<typeof WebAssembly.instantiate>[1],
    successCallback: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
  ) => Record<string, never>;
  readonly preRun: ((module: PgDumpModule) => void)[];
}

export type PgDumpModuleFactory = (overrides: PgDumpModuleOverrides) => Promise<PgDumpModule>;
