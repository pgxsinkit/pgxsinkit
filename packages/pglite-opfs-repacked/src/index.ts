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
