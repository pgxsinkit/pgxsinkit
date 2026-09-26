// Began as a copy of `@electric-sql/pglite` (taken under its PostgreSQL License option, © ElectricSQL
// — see NOTICE). Owned outright (ADR-0062); compatibility with PGlite is an anti-goal — evolve freely.

import { createInitdbModule } from "../artefacts";
import { commandWords } from "./command-line";
import type { InitdbModule } from "./emscripten";
import { preservingExitCode } from "./exit-code";
import {
  ICU_DATA_PATH,
  INITDB_EXE_PATH,
  PG_ROOT,
  PG_STDIN_PATH,
  PG_STDOUT_PATH,
  PGDATA,
  POSTGRES_EXE_PATH,
} from "./paths";
import type { PostgresInstance } from "./postgres-instance";

export interface InitdbResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

/** The arguments every initdb run starts with. */
export const INITDB_ARGS: readonly string[] = [
  "--allow-group-access",
  "--encoding",
  "UTF8",
  "--locale=C.UTF-8",
  "--locale-provider=libc",
  "--auth=trust",
];

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/**
 * Run initdb against a scratch Postgres instance. initdb is its own wasm module; the backend commands it
 * shells out to (`postgres --boot`, `postgres --single`) are run on the scratch instance, whose heap is
 * reset to its pristine state before each. initdb sees the instance's filesystem through PROXYFS, so the
 * cluster it creates lands in the instance's `/pglite/data`.
 */
export async function runInitdb({
  postgres,
  initdbWasm,
  debug,
  onCommand,
}: {
  readonly postgres: PostgresInstance;
  readonly initdbWasm: WebAssembly.Module;
  readonly debug: number;
  /** @internal Every command line initdb hands to the host (the tokenizer's test pins these). */
  readonly onCommand?: (command: string) => void;
}): Promise<InitdbResult> {
  const log = (...args: unknown[]) => {
    if (debug > 0) console.log("initdb:", ...args);
  };
  const pg = postgres.module;
  let needToCallPgMain = false;
  let postgresArgs: string[] = [];
  let pgMainResult = 0;
  let initdbStdinFd = -1;
  let initdbStdoutFd = -1;
  let stderr = "";
  let stdout = "";

  const pristineHeap = pg.HEAPU8.slice();
  const callPgMain = (args: string[]): number => {
    const [program, ...rest] = args;
    assert(program === POSTGRES_EXE_PATH, `initdb tried to execute ${String(program)}`);
    pg.HEAPU8.set(pristineHeap);
    log("executing postgres with", rest);
    const result = postgres.callMain(rest);
    postgresArgs = [];
    return result;
  };
  const commandArgs = (module: InitdbModule, pointer: number): string[] => {
    const command = module.UTF8ToString(pointer);
    onCommand?.(command);
    return commandWords(command);
  };

  let rejectInstantiation: (error: unknown) => void = () => undefined;
  const instantiationFailed = new Promise<never>((_, reject) => {
    rejectInstantiation = reject;
  });

  const initdb = await Promise.race([
    createInitdbModule({
      thisProgram: INITDB_EXE_PATH,
      arguments: [...INITDB_ARGS],
      noExitRuntime: false,
      stdin: () => null,
      print: (text) => {
        stdout += text;
        log("stdout", text);
      },
      printErr: (text) => {
        stderr += text;
        log("stderr", text);
      },
      instantiateWasm: (imports, successCallback) => {
        WebAssembly.instantiate(initdbWasm, imports).then(
          (instance) => successCallback(instance, initdbWasm),
          (error: unknown) => rejectInstantiation(error),
        );
        return {};
      },
      // Reverse execution order (see PostgresInstance.create): PROXYFS mount, then env, then callbacks.
      preRun: [
        (module) => {
          const env = module.ENV;
          env["PGDATA"] = PGDATA;
          env["HOME"] = "/home/postgres";
          env["USER"] = "postgres";
          env["LOGNAME"] = "postgres";
          env["ICU_DATA"] = ICU_DATA_PATH;
        },
        (module) => {
          module.onRuntimeInitialized = () => {
            module._pgl_set_system_fn(
              module.addFunction((command: number) => {
                postgresArgs = commandArgs(module, command);
                return callPgMain(postgresArgs);
              }, "pi"),
            );
            module._pgl_set_popen_fn(
              module.addFunction((command: number, mode: number) => {
                const openMode = module.UTF8ToString(mode);
                postgresArgs = commandArgs(module, command);
                if (openMode === "r") {
                  pgMainResult = callPgMain(postgresArgs);
                  return initdbStdinFd;
                }
                if (openMode === "w") {
                  needToCallPgMain = true;
                  return initdbStdoutFd;
                }
                throw new Error(`Unexpected popen mode ${openMode}`);
              }, "ppi"),
            );
            module._pgl_set_pclose_fn(
              module.addFunction((stream: number) => {
                if (stream === initdbStdinFd || stream === initdbStdoutFd) {
                  // A popen in "w" mode runs postgres' main once initdb has written its input.
                  if (needToCallPgMain) {
                    needToCallPgMain = false;
                    pgMainResult = callPgMain(postgresArgs);
                  }
                  return pgMainResult;
                }
                return module._pclose(stream);
              }, "pi"),
            );
            // The backend reads initdb's output and writes initdb's input through two files.
            pg._pgl_freopen(pg.stringToUTF8OnStack(PG_STDIN_PATH), pg.stringToUTF8OnStack("r"), 0);
            pg._pgl_freopen(pg.stringToUTF8OnStack(PG_STDOUT_PATH), pg.stringToUTF8OnStack("w"), 1);
            initdbStdinFd = module._fopen(module.stringToUTF8OnStack(PG_STDOUT_PATH), module.stringToUTF8OnStack("r"));
            initdbStdoutFd = module._fopen(module.stringToUTF8OnStack(PG_STDIN_PATH), module.stringToUTF8OnStack("w"));
          };
        },
        (module) => {
          module.FS.mkdir(PG_ROOT);
          module.FS.mount(module.PROXYFS, { root: PG_ROOT, fs: pg.FS }, PG_ROOT);
        },
      ],
    }),
    instantiationFailed,
  ]);

  log("running initdb with", INITDB_ARGS);
  const exitCode = preservingExitCode(() => initdb.callMain([...INITDB_ARGS]));
  return { exitCode, stderr, stdout };
}
