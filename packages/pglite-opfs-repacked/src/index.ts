export {
  CorruptStoreError,
  DurabilityModeMismatchError,
  ExtentSizeMismatchError,
  FsError,
  StoreClosedError,
  StoreFailedError,
  StoreLimitError,
  StoreOwnedError,
  StoreRecreationRequiredError,
  UnexpectedStoreEntryError,
} from "./core/errors";
export {
  createOpfsRepackedPGlite,
  type CreateOpfsRepackedPGliteOptions,
  type OpfsRepackedCreatePhase,
  type OpfsRepackedPGlite,
} from "./pglite-factory";
export { OpfsRepackedFS, type RepackedDurability } from "./opfs-repacked-fs";

// The engine-agnostic store core: a `RepackedVfs` over any `RepackedPort`, with no PGlite, wasm, or
// OPFS anywhere in it. This is what a coordinator worker owns and what the sync broker serves.
export {
  RepackedVfs,
  type RepackedStat,
  type RepackedVfsMetrics,
  type RepackedVfsOpenOptions,
} from "./core/repacked-vfs";
export { MemoryRepackedPort, type MemoryFault, type MemoryOperation } from "./core/memory-port";
export type { RepackedFileHandle, RepackedPort, RepackedPortEntry } from "./core/port";

/**
 * The OPFS-backed port for that same store core: four `FileSystemSyncAccessHandle`s over one dedicated
 * OPFS directory. `createOpfsRepackedPGlite` builds this internally, so a PGlite consumer never needs
 * it; it is exported for a host that owns the store itself — a coordinator worker serving the sync
 * broker to a wasm engine — and wants that store persisted rather than in memory. It must be
 * constructed in a scope where `createSyncAccessHandle()` actually SUCCEEDS (a dedicated worker in
 * every engine, plus a SharedWorker on real Safari); method presence is not proof, the window main
 * thread is never such a scope, and a denial surfaces as an open failure rather than a fallback.
 * `OpfsDirectoryHandle` is the structural slice of `FileSystemDirectoryHandle` the port actually uses,
 * so a real handle satisfies it without a cast.
 */
export { OpfsRepackedPort, type OpfsDirectoryHandle } from "./opfs-port";

// The synchronous broker: one coordinator worker owns the store, every other thread reaches it over a
// SharedArrayBuffer channel and blocks in `Atomics.wait` for the answer.
export { RepackedSyncBroker, type RepackedSyncBrokerOptions } from "./broker/server";
export {
  RepackedBrokerStoreError,
  RepackedBrokerTransportError,
  RepackedSyncClient,
  throwOnErrno,
  type BrokerCountResult,
  type BrokerOpenResult,
  type BrokerReadResult,
  type BrokerReaddirPageResult,
  type BrokerReaddirResult,
  type BrokerResult,
  type BrokerSizeResult,
  type BrokerStatResult,
  type RepackedSyncClientOptions,
} from "./broker/client";
export {
  DEFAULT_PAYLOAD_BYTES,
  O_APPEND,
  O_CREAT,
  O_EXCL,
  O_RDONLY,
  O_RDWR,
  O_TRUNC,
  O_WRONLY,
  RepackedChannel,
  RepackedDoorbell,
  errnoName,
  fsErrorNameOf,
  planOpen,
  type BrokerStat,
  type OpenPlan,
  type RepackedChannelTransfer,
} from "./broker/protocol";

// The WASI preview1 filesystem adapter: the seam where a wasm engine's file calls reach ONE store
// through the broker, with fds 0-2 and every non-filesystem import left to the host.
export {
  WASI_ERRNO,
  WASI_FILETYPE,
  createWasiPreview1Fs,
  normalizeWasiPath,
  type WasiPreview1Fs,
  type WasiPreview1FsFunctions,
  type WasiPreview1FsOptions,
} from "./wasi/preview1";
