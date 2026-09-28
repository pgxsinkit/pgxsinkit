// Began as a copy of `@electric-sql/pglite` (taken under its PostgreSQL License option, © ElectricSQL
// — see NOTICE). Owned outright (ADR-0062); compatibility with PGlite is an anti-goal — evolve freely.

import type { DebugLevel } from "@pgxsinkit/pgwasm/build";

import type { CBuildArtefactSet } from "../artefacts";
import type { EmscriptenStream, ModuleOverrides, PostgresModule } from "./emscripten";
import { preservingExitCode } from "./exit-code";
import { ICU_DATA_PATH, INITDB_EXE_PATH, LOCALE_LIST_PATH, PGDATA, POSTGRES_EXE_PATH } from "./paths";

/** Postgres' error longjmp, intercepted by the host: keep in sync with pglitec.c's POSTGRES_MAIN_LONGJMP. */
const POSTGRES_MAIN_LONGJMP = 100;
/** The exit status single-user mode reports when it started and stays alive. */
const PGLITE_EXIT_ALIVE = 99;
const INITIAL_MEMORY_PAGES = 2048;
const MAXIMUM_MEMORY_PAGES = 32768;

/** The single-user-mode arguments every start begins with. */
export const DEFAULT_START_PARAMS: readonly string[] = [
  "--single", // single-user mode (must come first)
  "-F", // fsync off: the host persists storage itself
  "-O", // allow system table structure changes
  "-j", // no newline as the interactive query delimiter
  "-c",
  "search_path=public",
  "-c",
  "exit_on_error=false",
  "-c",
  "log_checkpoints=false",
  "-c",
  "max_worker_processes=0",
  "-c",
  "max_parallel_workers=0",
  "-c",
  "max_parallel_workers_per_gather=0",
  "-c",
  "io_method=sync",
  "-c",
  "max_parallel_maintenance_workers=0",
];

/**
 * Whether `error` is one of the exceptions the Emscripten runtime throws on purpose to unwind the wasm
 * stack back to the main loop, which handles them:
 * - `'unwind'` from emscripten_exit_with_live_runtime(): how pgl_longjmp (pglitec.c) delivers Postgres'
 *   siglongjmp to its main-loop error handler, and how a Terminate message ends the loop;
 * - what an emscripten-mode longjmp throws, should one pass every invoke_* frame: an instance of the
 *   glue's (unexported) `EmscriptenSjLj` class on Emscripten 6.0.10 (pgwasm-postgres 18.6.1 onwards), a
 *   number on Emscripten 3.1.74 (18.3.0 and 18.6.0). Both are recognised, so the host works with either.
 *
 * An `ExitStatus` (from exit()/proc_exit(): a FATAL error) is not: the backend's exit callbacks have
 * already torn its session down, so the loop cannot resume on it (see {@link exitStatusOf}).
 */
export function isEmscriptenUnwind(error: unknown): boolean {
  if (error === "unwind" || typeof error === "number") return true;
  if (typeof error !== "object" || error === null) return false;
  return (error as { constructor?: { name?: unknown } }).constructor?.name === "EmscriptenSjLj";
}

const invalidBundleSize = (actual: number, expected: number): Error =>
  new Error(`Invalid filesystem bundle size: ${actual} !== ${expected}`);

/** The status of the `ExitStatus` the runtime throws from exit()/proc_exit(), or undefined for anything else. */
export function exitStatusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || (error as { name?: unknown }).name !== "ExitStatus") {
    return undefined;
  }
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : -1;
}

/**
 * The wasm's shadow stack pointer: the C stack in linear memory, which the glue exports neither
 * `stackSave` nor `stackRestore` for. A throw that unwinds wasm frames (an ERROR's intercepted
 * siglongjmp, a FATAL's exit) skips their epilogues, so the pointer stays where the deepest of them left
 * it. Unrestored, every ERROR leaked that much stack (about 1.2 kB for `SELECT 1/0`), until
 * `max_stack_depth` refused every statement (from about the 1,700th error in one instance). The host
 * restores it to where the call started, as Postgres' own siglongjmp to PostgresMain would.
 */
interface ShadowStack {
  save(): number;
  restore(pointer: number): void;
}

function shadowStackOf(instance: WebAssembly.Instance): ShadowStack {
  const current = instance.exports["emscripten_stack_get_current"];
  const restore = instance.exports["_emscripten_stack_restore"];
  if (typeof current !== "function" || typeof restore !== "function") {
    throw new Error(
      "The Postgres module exports no emscripten_stack_get_current or _emscripten_stack_restore: the host cannot restore its stack after an error",
    );
  }
  return {
    save: () => (current as () => number)(),
    restore: (pointer) => (restore as (pointer: number) => void)(pointer),
  };
}

export interface PostgresInstanceConfig {
  /** The Postgres glue (`postgres.js`) and the size of the filesystem bundle it was packaged with. */
  readonly glue: Pick<CBuildArtefactSet, "createPostgresModule" | "fsBundleBytes">;
  readonly wasmModule: Promise<WebAssembly.Module>;
  /** The filesystem bundle, a copy of its own for this instance. */
  readonly fsBundle: Promise<ArrayBuffer>;
  readonly user: string;
  readonly database: string;
  readonly debug: DebugLevel;
  /** preRun steps that mount storage over the data directory; run after the filesystem bundle loads. */
  readonly mountPreRun?: (module: PostgresModule) => void;
  /** @internal A test's view of the module. */
  readonly onModule?: (module: PostgresModule) => void;
}

/**
 * One Emscripten instance of the Postgres module and the host state around it: the socket callbacks
 * the wire goes through, the `/dev/blob` device, and the external-command hooks.
 */
export class PostgresInstance {
  readonly module: PostgresModule;
  readonly #debug: DebugLevel;
  readonly #stack: ShadowStack;
  // Frontend bytes being fed to Postgres, and how far it has read them.
  #input: Uint8Array = new Uint8Array(0);
  #readOffset = 0;
  // Where backend bytes go during an exchange.
  #sink: ((chunk: Uint8Array) => void) | undefined;
  #blobReadSource: Uint8Array | undefined;
  #blobWritten: Uint8Array<ArrayBuffer>[] | undefined;
  #externalCommandStream: number | null = null;
  #functionPointers: number[] = [];
  #failed = false;
  #exited = false;
  // The last lines Postgres wrote to stderr (since the exchange began, during one), for the error when it
  // fails to start or exits.
  readonly #stderr: string[] = [];

  private constructor(module: PostgresModule, debug: DebugLevel, stack: ShadowStack) {
    this.module = module;
    this.#debug = debug;
    this.#stack = stack;
  }

  static async create(config: PostgresInstanceConfig): Promise<PostgresInstance> {
    const [wasmModule, fsBundle] = await Promise.all([config.wasmModule, config.fsBundle]);
    // Checked before the glue runs. Emscripten 6's file packager (pgwasm-postgres 18.6.1 onwards) loads the
    // bundle in an async function it never awaits, so a throw from getPreloadedPackage no longer rejects the
    // factory: it is an unhandled rejection, and the boot fails later on a missing bundle file with an
    // unrelated filesystem error.
    const { createPostgresModule, fsBundleBytes } = config.glue;
    if (fsBundle.byteLength !== fsBundleBytes) throw invalidBundleSize(fsBundle.byteLength, fsBundleBytes);
    let host: PostgresInstance | undefined;
    let stack: ShadowStack | undefined;
    const pendingHost = (module: PostgresModule): PostgresInstance => {
      // The runtime runs no preRun step before the instance it waits on (instantiateWasm) is ready.
      if (stack === undefined) throw new Error("The Postgres module initialised before its wasm instance");
      host ??= new PostgresInstance(module, config.debug, stack);
      return host;
    };
    let rejectInstantiation: (error: unknown) => void = () => undefined;
    const instantiationFailed = new Promise<never>((_, reject) => {
      rejectInstantiation = reject;
    });

    const log = (text: string) => {
      if (config.debug > 0) console.debug(text);
    };
    const logError = (text: string) => {
      if (host) host.#recordStderr(text);
      if (config.debug > 0) console.error(text);
    };

    // Emscripten runs preRun callbacks in the order listed (3.1.74, before pgwasm-postgres 18.6.1, ran them
    // in reverse). The build's pre-js loads the filesystem bundle before the first of them, so every one
    // sees the bundle's files. They touch disjoint state (the runtime hook, /dev/blob, the environment, the
    // bundle's files outside the data directory, then the storage mount over the data directory), so none
    // depends on the order of the others.
    const preRun: ((module: PostgresModule) => void)[] = [
      (module) => {
        module.onRuntimeInitialized = () => pendingHost(module).#onRuntimeInitialized();
      },
      (module) => pendingHost(module).#registerBlobDevice(),
      (module) => {
        const env = module.ENV;
        env["HOME"] = "/home/postgres";
        env["USER"] = "postgres";
        env["LOGNAME"] = "postgres";
        env["PGDATA"] = PGDATA;
        env["PGUSER"] = config.user;
        env["PGDATABASE"] = config.database;
        env["LANG"] = "en_US.UTF-8";
        env["LC_COLLATE"] = "en_US.UTF-8";
        env["LC_CTYPE"] = "en_US.UTF-8";
        env["TZ"] = "UTC";
        env["PGTZ"] = "UTC";
        env["PGCLIENTENCODING"] = "UTF8";
        env["ICU_DATA"] = ICU_DATA_PATH;
      },
      (module) => {
        module.FS.chmod("/home/postgres/.pgpass", 0o600); // libpq ignores a .pgpass others can read
        module.FS.chmod(INITDB_EXE_PATH, 0o555);
        module.FS.chmod(POSTGRES_EXE_PATH, 0o555);
      },
    ];
    if (config.mountPreRun) preRun.push(config.mountPreRun);

    const overrides: ModuleOverrides<PostgresModule> = {
      thisProgram: POSTGRES_EXE_PATH,
      arguments: config.debug > 0 ? ["-d", String(config.debug)] : [],
      noExitRuntime: true,
      wasmMemory: new WebAssembly.Memory({ initial: INITIAL_MEMORY_PAGES, maximum: MAXIMUM_MEMORY_PAGES }),
      // A stdin that is always at EOF, so a browser never prompts.
      stdin: () => null,
      print: log,
      printErr: logError,
      instantiateWasm: (imports, successCallback) => {
        WebAssembly.instantiate(wasmModule, imports).then(
          (instance) => {
            try {
              stack = shadowStackOf(instance);
            } catch (error) {
              rejectInstantiation(error);
              return;
            }
            successCallback(instance, wasmModule);
          },
          (error: unknown) => rejectInstantiation(error),
        );
        return {};
      },
      getPreloadedPackage: (name, size) => {
        if (name !== "postgres.data") throw new Error(`Unknown filesystem package: ${name}`);
        if (fsBundle.byteLength !== size) {
          // Unreachable while the glue and the pins agree; if they ever do not, fail the boot with this error.
          const error = invalidBundleSize(fsBundle.byteLength, size);
          rejectInstantiation(error);
          throw error;
        }
        return fsBundle;
      },
      preRun,
    };

    const module = await Promise.race([createPostgresModule(overrides), instantiationFailed]);
    const instance = pendingHost(module);
    config.onModule?.(module);
    return instance;
  }

  #recordStderr(text: string): void {
    this.#stderr.push(text);
    if (this.#stderr.length > 20) this.#stderr.shift();
  }

  #log(...args: unknown[]): void {
    if (this.#debug > 0) console.log(...args);
  }

  #addFunction(fn: (...args: number[]) => number | void, signature: string): number {
    const pointer = this.module.addFunction(fn, signature);
    this.#functionPointers.push(pointer);
    return pointer;
  }

  #onRuntimeInitialized(): void {
    const mod = this.module;
    // system() never runs a command: it is logged and fails.
    mod._pgl_set_system_fn(
      this.#addFunction((command: number) => {
        this.#log(`Postgres tried to execute ${mod.UTF8ToString(command)}, returning 1.`);
        return 1;
      }, "pi"),
    );
    mod._pgl_set_popen_fn(
      this.#addFunction((command: number, mode: number) => {
        this.#externalCommandStream = this.#handleExternalCommand(mod.UTF8ToString(command), mod.UTF8ToString(mode));
        return this.#externalCommandStream;
      }, "ppp"),
    );
    mod._pgl_set_pclose_fn(
      this.#addFunction((stream: number) => {
        if (stream !== this.#externalCommandStream) throw new Error(`Unhandled pclose ${stream}`);
        mod._fclose(stream);
        this.#externalCommandStream = null;
      }, "pi"),
    );
    // Backend bytes: handed to the exchange's sink as a view of the heap, valid during the call.
    const write = this.#addFunction((pointer: number, length: number) => {
      this.#sink?.(this.module.HEAPU8.subarray(pointer, pointer + length));
      return length;
    }, "iii");
    // Frontend bytes: copied into the heap from the message being exchanged.
    const read = this.#addFunction((pointer: number, maxLength: number) => {
      const length = Math.min(this.#input.length - this.#readOffset, maxLength);
      this.module.HEAPU8.set(this.#input.subarray(this.#readOffset, this.#readOffset + length), pointer);
      this.#readOffset += length;
      return length;
    }, "iii");
    mod._pgl_set_rw_cbs(read, write);
  }

  #handleExternalCommand(command: string, mode: string): number {
    if (command.startsWith("locale -a") && mode === "r") {
      return this.module._fopen(
        this.module.stringToUTF8OnStack(LOCALE_LIST_PATH),
        this.module.stringToUTF8OnStack(mode),
      );
    }
    throw new Error(`Unhandled external command: ${command}`);
  }

  /** `/dev/blob`: what `COPY … FROM '/dev/blob'` reads and `COPY … TO '/dev/blob'` writes. */
  #registerBlobDevice(): void {
    const FS = this.module.FS;
    const device = FS.makedev(64, 0);
    FS.registerDevice(device, {
      open: () => undefined,
      close: () => undefined,
      read: (_stream, buffer, offset, length, position) => {
        const contents = this.#blobReadSource;
        if (!contents) throw new Error("No /dev/blob File or Blob provided to read from");
        if (position >= contents.length) return 0;
        const size = Math.min(contents.length - position, length);
        buffer.set(contents.subarray(position, position + size), offset);
        return size;
      },
      write: (_stream, buffer, offset, length) => {
        this.#blobWritten ??= [];
        this.#blobWritten.push(new Uint8Array(buffer.subarray(offset, offset + length)));
        return length;
      },
      llseek: (stream: EmscriptenStream, offset: number, whence: number) => {
        const contents = this.#blobReadSource;
        if (!contents) throw new Error("No /dev/blob File or Blob provided to llseek");
        let position = offset;
        if (whence === 1) position += stream.position;
        else if (whence === 2) position = contents.length;
        if (position < 0) throw new FS.ErrnoError(28);
        return position;
      },
    });
    FS.mkdev("/dev/blob", device);
  }

  setBlobReadSource(data: Uint8Array | undefined): void {
    this.#blobReadSource = data;
  }

  takeBlobWritten(): Uint8Array<ArrayBuffer>[] | undefined {
    const written = this.#blobWritten;
    this.#blobWritten = undefined;
    return written;
  }

  /** Run `callMain`, leaving the host's exit code as it was. */
  callMain(args: string[]): number {
    return preservingExitCode(() => this.module.callMain(args));
  }

  /** Start Postgres in single-user mode on the data directory. */
  startSingleMode(startParams: readonly string[]): void {
    const mod = this.module;
    mod._pgl_setPGliteActive(1);
    this.callMain([...startParams, "-D", PGDATA, mod.ENV["PGDATABASE"] ?? "postgres"]);
    const exitStatus = mod._pgl_setPGliteExitStatus(-3);
    if (exitStatus !== PGLITE_EXIT_ALIVE) {
      const output = this.#stderr.join("\n").trim();
      throw new Error(
        `Postgres failed to start (single-user mode exit status ${exitStatus})${output ? `:\n${output}` : ""}`,
      );
    }
    mod._pgl_startPGlite();
  }

  /**
   * One exchange on the single session: feed `message` to Postgres and hand every backend byte it
   * produces to `onData`, synchronously. A startup packet (first byte 0) is processed as one; a
   * Terminate (`X`) is ignored, as the session ends with the instance. A throw that is not Postgres'
   * own error unwind means the wasm stack was abandoned mid-function, and an exit (a FATAL error) means
   * the backend tore its session down: either fails the session, which refuses every later exchange.
   */
  exchange(message: Uint8Array, onData: (chunk: Uint8Array) => void): void {
    if (this.#failed) throw new Error("The C build's session failed and cannot be used again");
    if (message[0] === 0x58) return; // Terminate
    this.#sink = onData;
    this.#input = message;
    this.#readOffset = 0;
    this.#stderr.length = 0;
    try {
      if (message[0] === 0) {
        this.#processStartupPacket();
        return;
      }
      this.#runMainLoop(message);
    } catch (error) {
      const status = exitStatusOf(error);
      if (status === undefined) throw error;
      this.#failed = true;
      const output = this.#stderr.join("\n").trim();
      throw new Error(
        `Postgres exited with status ${status} during an exchange: a FATAL error ended the C build's session${output ? `:\n${output}` : ""}`,
        { cause: error },
      );
    } finally {
      this.#sink = undefined;
      this.#input = new Uint8Array(0);
    }
  }

  /**
   * A call into the backend that may unwind (an ERROR's intercepted siglongjmp, a FATAL's exit):
   * should it throw, the shadow stack pointer is restored to where it began (see {@link ShadowStack}).
   */
  #call<T>(call: () => T): T {
    const stack = this.#stack.save();
    try {
      return call();
    } catch (error) {
      this.#stack.restore(stack);
      throw error;
    }
  }

  #processStartupPacket(): void {
    const mod = this.module;
    const result = this.#call(() => mod._ProcessStartupPacket(mod._pgl_getMyProcPort(), true, true));
    if (result !== 0) throw new Error("Cannot process the startup packet");
    this.#call(() => {
      mod._pgl_sendConnData();
      mod._pgl_pq_flush();
    });
  }

  #runMainLoop(message: Uint8Array): void {
    const mod = this.module;
    try {
      // One message may carry several batched statements; the loop returns after each.
      while (this.#readOffset < message.length || mod._pq_buffer_remaining_data() > 0) {
        const stack = this.#stack.save();
        try {
          mod._PostgresMainLoopOnce();
        } catch (error) {
          // First, as Postgres' own siglongjmp to PostgresMain would: the throw skipped the epilogues of
          // every frame it abandoned (see ShadowStack).
          this.#stack.restore(stack);
          if (!isEmscriptenUnwind(error)) throw error;
          if (mod._pgl_setPGliteExitStatus(-2) === POSTGRES_MAIN_LONGJMP) {
            // Postgres raised an error: its siglongjmp into main was intercepted, and its error handling
            // runs here before the loop resumes with the rest of the batch.
            this.#call(() => mod._PostgresMainLongJmp());
          }
        }
      }
      this.#call(() => {
        mod._PostgresSendReadyForQueryIfNecessary();
        mod._pgl_pq_flush();
      });
    } catch (error) {
      this.#failed = true;
      throw error;
    }
  }

  /** Postgres' clean exit: its atexit callbacks. An exit status of 0 is the normal outcome. */
  shutdown(): void {
    const mod = this.module;
    try {
      preservingExitCode(() => {
        mod._pgl_setPGliteActive(0);
        this.#call(() => mod._pgl_run_atexit_funcs());
      });
    } catch (error) {
      const exit = error as { name?: unknown; status?: unknown };
      if (!(exit.name === "ExitStatus" && exit.status === 0)) throw error;
    }
  }

  /** Release the callbacks and exit the runtime, which `noExitRuntime` otherwise keeps alive. */
  dispose(exitStatus: number): void {
    if (this.#exited) return;
    this.#exited = true;
    for (const pointer of this.#functionPointers) {
      try {
        this.module.removeFunction(pointer);
      } catch {
        // continue releasing
      }
    }
    this.#functionPointers = [];
    try {
      preservingExitCode(() => this.module._emscripten_force_exit(exitStatus));
    } catch {
      // The runtime reports a forced exit by throwing ExitStatus.
    }
  }
}
