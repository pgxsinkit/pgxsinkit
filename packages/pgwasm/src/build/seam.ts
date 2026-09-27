/**
 * The seam between pgwasm and a Postgres build (ADR-0062 decision 3).
 *
 * pgwasm owns everything above the wire protocol once: queries, transactions, notifications, live
 * queries, the persist scheduler, the failure latch, the backup format and the build marker. A build
 * provides a boot in two phases (mount storage, then start Postgres), a byte channel per session, and a
 * record of its capabilities. Anything that differs between builds is a capability; shared code never
 * tests a build's name.
 */

import type { BaseFilesystem } from "../fs/base-filesystem";

/** pgwasm's log level, passed through to the build. */
export type DebugLevel = 0 | 1 | 2 | 3 | 4 | 5;

/** Who a build is. Recorded in every data directory it creates (ADR-0063 decision 1). */
export interface BuildIdentity {
  /** Stable name, never renamed; the `storage.build` vocabulary: `"c"`, later `"pgrust"`. */
  readonly name: string;
  /** On-disk compatibility version. A data directory opens only under the same name AND format. */
  readonly dataFormat: number;
  /**
   * Whether a data directory WITHOUT a marker is this build's. True for the C build only: every data
   * directory made before builds were marked was made by it (ADR-0063).
   */
  readonly claimsUnmarkedDirectories: boolean;
  /** Informational release label, never compared. */
  readonly release: string;
}

/** The storage kinds pgwasm knows. A build lists the ones it mounts. */
export type FilesystemKind = "memory" | "idb" | "file" | "vfs";

/** Everything that differs between builds, as data. */
export interface BuildCapabilities {
  /** How many sessions `openSession()` hands out at once. */
  readonly sessions: number;
  /** Needs a cross-origin-isolated context (SharedArrayBuffer) in a browser. */
  readonly requiresCrossOriginIsolation: boolean;
  /** The storage kinds `boot()` accepts. */
  readonly filesystems: readonly FilesystemKind[];
  /**
   * Whether `exchange()` completes inside the call in this context. A tool that bridges a blocking wasm
   * callback to the wire (pg_dump) needs it.
   */
  readonly synchronousExchange: boolean;
  /** Whether `COPY … FROM/TO '/dev/blob'` works (the `blob` query option). */
  readonly blobDevice: boolean;
}

/** Where a data directory lives, as pgwasm resolved it from `dataDir` / `fs`. */
export type StorageRequest =
  | { readonly kind: "memory" }
  | { readonly kind: "idb"; readonly name: string }
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "vfs"; readonly vfs: BaseFilesystem };

/**
 * Files a build installs before Postgres starts, shipped by a build package (for example
 * `@pgxsinkit/pgwasm-c/contrib/amcheck`). Pass it in `extensions` like any other extension.
 */
export interface ServerExtension {
  readonly kind: "server";
  readonly name: string;
  /** The {@link BuildIdentity.name} it was compiled for; another build refuses it before boot. */
  readonly build: string;
  /** A gzipped tar of the extension's `lib/` and `share/` files. */
  readonly bundle: URL;
  readonly sharedPreloadLibraries?: readonly string[];
}

/**
 * One entry of a data directory. `path` is relative to the data directory with a leading `/`
 * (`/PG_VERSION`, `/base/1/1259`): the layout Store backups have always had.
 */
export interface DataDirEntry {
  readonly path: string;
  readonly type: "file" | "directory";
  /** Permission bits. */
  readonly mode: number;
  readonly mtimeSeconds: number;
  /** The file's bytes; empty for a directory. */
  readonly data: Uint8Array;
}

export interface BootRequest {
  readonly storage: StorageRequest;
  readonly extensions: readonly ServerExtension[];
  readonly user: string;
  readonly database: string;
  readonly debug: DebugLevel;
}

/** A compiled Postgres, as pgwasm drives it. */
export interface PostgresBuild {
  readonly identity: BuildIdentity;
  readonly capabilities: BuildCapabilities;
  /**
   * Optional: settles once everything a {@link boot} would wait on before its own work is ready (artefacts
   * fetched and compiled ahead, e.g. by a warm started on an earlier screen). A caller that times a boot
   * awaits it first, so the timing measures the boot, never an unfinished warm. Never rejects: a failed
   * warm means the build loads its artefacts itself during the boot.
   */
  prepare?(): Promise<void>;
  /**
   * Boot, phase 1: bring the host up and mount the storage (IndexedDB read in, a filesystem initially
   * synced). When this resolves, Postgres has not run and nothing in the data directory was written.
   */
  boot(request: BootRequest): Promise<MountedDataDirectory>;
}

/** Phase 1 of a boot: storage is mounted, Postgres has not started. */
export interface MountedDataDirectory {
  /** A file in the data directory, or `undefined` when it does not exist. Never writes. */
  readFile(path: string): Promise<Uint8Array | undefined>;
  /** Create a fresh cluster (initdb) in an empty data directory. */
  createCluster(): Promise<void>;
  /** Write a data-directory image into an empty data directory (a restore, a seed). */
  writeEntries(entries: readonly DataDirEntry[]): Promise<void>;
  /** Write one file into the data directory. */
  writeFile(path: string, data: Uint8Array): Promise<void>;
  /** Strictly persist everything written so far. */
  persist(): Promise<void>;
  /** Boot, phase 2: start Postgres. */
  start(options: StartOptions): Promise<RunningPostgres>;
  /** Give up without starting: release the storage (locks, handles) and the host. */
  release(): Promise<void>;
}

export interface StartOptions {
  /** Server settings (GUCs), `shared_preload_libraries` already merged. */
  readonly settings: Readonly<Record<string, string>>;
}

/** Phase 2 of a boot: Postgres is running. */
export interface RunningPostgres {
  /** A session, already past startup. Calls beyond `capabilities.sessions` reject. */
  openSession(): Promise<WireSession>;
  /**
   * Persist storage after a statement. pgwasm serializes calls and owns the policy: `relaxed` is a
   * background persist whose failure pgwasm latches; `false` is awaited by the statement.
   */
  persist(relaxed: boolean): Promise<void>;
  /** Walk the data directory for a Store backup. pgwasm holds its query lock around the call. */
  readEntries(): Promise<DataDirEntry[]>;
  /** The `/dev/blob` device, present iff `capabilities.blobDevice`. */
  readonly blob: BlobDevice | undefined;
  /** Stop Postgres cleanly. Never called after a failure. */
  shutdown(): Promise<void>;
  /**
   * Release the storage and the host. Always the last call, after a failure too. `afterFailedBoot` is
   * set when the boot failed after `start()` (a filesystem gets `cleanupFailedInit` instead of `closeFs`).
   */
  release(options?: { readonly afterFailedBoot?: boolean }): Promise<void>;
}

/** One session's byte channel carrying the wire protocol. */
export interface WireSession {
  /**
   * Send frontend bytes and stream every byte of the COMPLETE reply into `onData`; settle when it is
   * complete. A build on a real wire frames the reply itself (a Flush after a non-terminal message, then
   * read to its terminator). Returns `undefined` when it completed synchronously, which it always does
   * when `capabilities.synchronousExchange`. A chunk is only valid during the callback: copy it to keep
   * it. A throw is a failure of the build, never an SQL error (those arrive in-band as ErrorResponse),
   * and pgwasm fails the instance. A message starting with a 0 byte is a startup packet.
   */
  exchange(message: Uint8Array, onData: (chunk: Uint8Array) => void): void | Promise<void>;
  /** Set by pgwasm: backend bytes that arrive between exchanges (another session's NOTIFY). */
  onUnsolicited: ((chunk: Uint8Array) => void) | undefined;
  close(): Promise<void>;
}

/** The `COPY … '/dev/blob'` device. */
export interface BlobDevice {
  /** What `COPY … FROM '/dev/blob'` reads, or `undefined` to clear it. */
  setReadSource(data: Uint8Array | undefined): void;
  /** What `COPY … TO '/dev/blob'` wrote since the last call, or `undefined` when nothing was. */
  takeWritten(): Uint8Array<ArrayBuffer>[] | undefined;
}
