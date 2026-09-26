// Began as a copy of `@electric-sql/pglite` (taken under its PostgreSQL License option, © ElectricSQL
// — see NOTICE). Owned outright (ADR-0062); compatibility with PGlite is an anti-goal — evolve freely.

/**
 * The parts of the Emscripten runtime the C build's host code uses, typed here rather than through
 * `@types/emscripten` (a global-ambient package that would put a global `FS` into every file of the
 * repository's single typecheck program). Only what is called is declared.
 */

/** An Emscripten filesystem type (MEMFS, NODEFS, IDBFS, PROXYFS or one of ours). */
export interface EmscriptenFilesystemType {
  readonly [member: string]: unknown;
}

export interface EmscriptenNode {
  name: string;
  mode: number;
  id: number;
  rdev: number;
  parent: EmscriptenNode;
  mount: { opts: { root?: string } };
  node_ops: unknown;
  stream_ops: unknown;
}

export interface EmscriptenStream {
  node: EmscriptenNode;
  position: number;
  nfd?: number;
  shared: { refcount: number };
}

export interface EmscriptenStat {
  mode: number;
  size: number;
  mtime: Date | number;
}

export interface EmscriptenErrnoError extends Error {
  errno: number;
}

export interface IdbfsType extends EmscriptenFilesystemType {
  readonly dbs: Readonly<Record<string, { close(): void } | undefined>>;
}

/** Emscripten's `FS` object. */
export interface EmscriptenFS {
  readonly filesystems: {
    readonly MEMFS: EmscriptenFilesystemType;
    readonly NODEFS: EmscriptenFilesystemType;
    readonly IDBFS: IdbfsType;
  };
  readonly ErrnoError: new (errno: number) => EmscriptenErrnoError;
  analyzePath(path: string): { exists: boolean };
  mkdir(path: string, mode?: number): void;
  mkdirTree(path: string, mode?: number): void;
  mount(type: EmscriptenFilesystemType, opts: Record<string, unknown>, mountpoint: string): void;
  symlink(target: string, path: string): void;
  readdir(path: string): string[];
  stat(path: string): EmscriptenStat;
  isFile(mode: number): boolean;
  isDir(mode: number): boolean;
  readFile(path: string, options?: { encoding: "binary" }): Uint8Array;
  writeFile(path: string, data: Uint8Array | string): void;
  utime(path: string, atime: number, mtime: number): void;
  chmod(path: string, mode: number): void;
  unlink(path: string): void;
  rmdir(path: string): void;
  makedev(major: number, minor: number): number;
  registerDevice(dev: number, ops: EmscriptenDeviceOps): void;
  mkdev(path: string, dev: number): void;
  createNode(parent: EmscriptenNode | null, name: string, mode: number, dev?: number): EmscriptenNode;
  createPreloadedFile(
    parent: string,
    name: string,
    data: Uint8Array,
    canRead: boolean,
    canWrite: boolean,
    onload: () => void,
    onerror: () => void,
    dontCreateFile: boolean,
  ): void;
  syncfs(populate: boolean, callback: (error: unknown) => void): void;
  quit(): void;
}

export interface EmscriptenDeviceOps {
  open(stream: EmscriptenStream): void;
  close(stream: EmscriptenStream): void;
  read(stream: EmscriptenStream, buffer: Uint8Array, offset: number, length: number, position: number): number;
  write(stream: EmscriptenStream, buffer: Uint8Array, offset: number, length: number, position: number): number;
  llseek(stream: EmscriptenStream, offset: number, whence: number): number;
}

/** What the module factories accept; the members the host sets. */
export interface ModuleOverrides<TModule> {
  thisProgram: string;
  arguments?: string[];
  noExitRuntime?: boolean;
  wasmMemory?: WebAssembly.Memory;
  stdin?: () => number | null;
  print?: (text: string) => void;
  printErr?: (text: string) => void;
  instantiateWasm?: (
    imports: Parameters<typeof WebAssembly.instantiate>[1],
    successCallback: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
  ) => Record<string, never>;
  getPreloadedPackage?: (name: string, size: number) => ArrayBuffer;
  preRun?: ((module: TModule) => void)[];
  WASM_PREFIX?: string;
}

/** The members every Emscripten module the C build loads has. */
export interface EmscriptenModuleBase {
  readonly FS: EmscriptenFS;
  readonly ENV: Record<string, string>;
  readonly HEAPU8: Uint8Array;
  readonly HEAP8: Int8Array;
  onRuntimeInitialized?: () => void;
  callMain(args: string[]): number;
  addFunction(fn: (...args: number[]) => number | void, signature: string): number;
  removeFunction(pointer: number): void;
  UTF8ToString(pointer: number): string;
  stringToUTF8OnStack(value: string): number;
  _fopen(path: number, mode: number): number;
  _fclose(stream: number): number;
  _pgl_set_system_fn(fn: number): void;
  _pgl_set_popen_fn(fn: number): void;
  _pgl_set_pclose_fn(fn: number): void;
  _pgl_freopen(path: number, mode: number, stream: number): number;
}

/** The Postgres module (`pglite.js`). */
export interface PostgresModule extends EmscriptenModuleBase {
  readonly PROXYFS: EmscriptenFilesystemType;
  _pgl_set_rw_cbs(readCallback: number, writeCallback: number): void;
  _pgl_pq_flush(): void;
  _pgl_setPGliteActive(value: number): number;
  _pgl_startPGlite(): void;
  _pgl_getMyProcPort(): number;
  _pgl_sendConnData(): void;
  _pgl_run_atexit_funcs(): void;
  _pgl_setPGliteExitStatus(status: number): number;
  _PostgresMainLoopOnce(): void;
  _PostgresMainLongJmp(): void;
  _PostgresSendReadyForQueryIfNecessary(): void;
  _ProcessStartupPacket(port: number, sslDone: boolean, gssDone: boolean): number;
  _pq_buffer_remaining_data(): number;
  _emscripten_force_exit(status: number): void;
}

/** The initdb module (`initdb.js`). */
export interface InitdbModule extends EmscriptenModuleBase {
  readonly PROXYFS: EmscriptenFilesystemType;
  _pclose(stream: number): number;
}

export type ModuleFactory<TModule> = (overrides: ModuleOverrides<TModule>) => Promise<TModule>;
